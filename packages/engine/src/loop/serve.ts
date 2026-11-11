/** The kernel loop: one per operad home, one child process per run. */

import { ActiveRunError, SeqConflictError } from "../log/errors.ts";
import type { InputRecord, JsonValue, LogBackend } from "../log/types.ts";
import { StartRefusedError } from "../plugin/errors.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type { RunLookup, StartRunRequest } from "../plugin/types.ts";
import type { Input, PersonAnswerInput } from "../kernel/types.ts";
import { Kernel } from "../trigger/kernel.ts";
import { loadTriggerRules } from "../trigger/rules.ts";
import type { TriggerRule } from "../trigger/types.ts";
import { acquireLock, lockHeld, runLockPath, serveLockPath } from "../runner/lock.ts";
import type { LockHandle } from "../runner/lock.ts";
import { StepLimits } from "../runner/limits.ts";
import { applyInput, objectKey, parseObjectKey, readState } from "../runner/service.ts";
import { reapStale } from "../platform/step-reap.ts";
import { isRecord } from "../util.ts";

export interface SpawnRunOptions {
  /** The previous process died mid-step; recover before doing anything else. */
  readonly recover: boolean;
}

export type SpawnRun = (
  runId: string,
  options: SpawnRunOptions,
) => void | Promise<void>;

export interface ServePassOptions {
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly spawnRun: SpawnRun;
  readonly lockRoot: string;
  readonly clock?: (() => number) | undefined;
  readonly isRunnerAlive?: ((runId: string) => boolean) | undefined;
  readonly isRecentlySpawned?: ((runId: string) => boolean) | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  /** Where a refused start or recovery is reported. */
  readonly onLog?: ((message: string) => void) | undefined;
  /** When given, every start request goes through this kernel entry point. */
  readonly kernel?: Kernel | undefined;
  /** The operad home; defaults to the registry's home. */
  readonly home?: string | undefined;
  /** Where trigger metadata lives; defaults to `lockRoot`. */
  readonly storeRoot?: string | undefined;
  /** Rules for a kernel built when `kernel` is omitted. */
  readonly rules?: readonly TriggerRule[] | undefined;
}

export interface ServePassResult {
  readonly started: readonly string[];
  readonly spawned: readonly string[];
}

function startObjectKey(request: StartRunRequest): string {
  const key = objectKey(request.object);
  return key === "flow" ? `flow:${request.plugin}/${request.flow}` : key;
}

/** The answer a recorded input carries, or undefined for another input. */
function recordedAnswer(payload: JsonValue): PersonAnswerInput | undefined {
  if (!isRecord(payload) || payload.kind !== "person_answer") return undefined;
  const waitId = payload.waitId;
  const choice = payload.choice;
  const actor = payload.actor;
  if (
    typeof waitId !== "string" ||
    typeof choice !== "string" ||
    !isRecord(actor) ||
    typeof actor.via !== "string" ||
    typeof actor.id !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "person_answer",
    waitId,
    choice,
    ...(typeof payload.note === "string" ? { note: payload.note } : {}),
    actor: { via: actor.via, id: actor.id },
  };
}

/** The kernel facts a plugin's tick may ask about. */
function runLookup(log: LogBackend): RunLookup {
  return {
    active: async (object) => {
      const runs = await log.runs({ active: true });
      return object === undefined
        ? runs
        : runs.filter((run) => run.object === object);
    },
    state: async (runId) => {
      try {
        return await readState(log, runId);
      } catch {
        return undefined;
      }
    },
    lastStep: async (runId) => {
      let step: string | null = null;
      try {
        for await (const fact of log.read(runId)) {
          if (
            fact.kind === "step_entered" &&
            isRecord(fact.payload) &&
            fact.payload.kind !== "end" &&
            typeof fact.payload.step === "string"
          ) {
            step = fact.payload.step;
          }
        }
      } catch {
        return null;
      }
      return step;
    },
  };
}

interface AnswerProgress {
  position: number;
  readonly waiting: Map<
    string,
    { readonly record: InputRecord; readonly input: PersonAnswerInput }
  >;
}

/** What each serving kernel has read of the inputs, and what still waits. */
const answerProgress = new WeakMap<Kernel, AnswerProgress>();

/**
 * Applies answers another process only recorded. The input record is the
 * hand-off: `serve` is the one process that may decide what the answer means
 * and start the step it requests. A repeated record is applied once.
 */
async function applyRecordedAnswers(options: {
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly kernel: Kernel;
  readonly clock: () => number;
  readonly shouldStop?: (() => boolean) | undefined;
}): Promise<void> {
  // Only the inputs recorded since the last pass are read. An answer stays in
  // `waiting` until it is applied or can no longer be: a run that has ended
  // takes no answer, so the answers of past runs are never looked at again.
  const progress = answerProgress.get(options.kernel) ?? {
    position: 0,
    waiting: new Map<string, { record: InputRecord; input: PersonAnswerInput }>(),
  };
  answerProgress.set(options.kernel, progress);
  const fresh = await options.log.readInputsAfter(progress.position);
  progress.position = fresh.position;
  for (const record of fresh.inputs) {
    if (record.runId === null) continue;
    const input = recordedAnswer(record.payload);
    if (input !== undefined) progress.waiting.set(record.inputId, { record, input });
  }
  if (progress.waiting.size === 0) return;

  const runs = new Map(
    (await options.log.runs({ active: true })).map((run) => [run.runId, run]),
  );
  const answers = [...progress.waiting.values()];
  const appliedByRun = new Map<string, Set<string>>();
  const appliedFor = async (runId: string): Promise<Set<string>> => {
    const cached = appliedByRun.get(runId);
    if (cached !== undefined) return cached;
    const applied = new Set<string>();
    try {
      for await (const fact of options.log.read(runId)) {
        if (typeof fact.cause === "string") applied.add(fact.cause);
      }
    } catch {
      // A run that cannot be read is left to the runner's own recovery.
    }
    appliedByRun.set(runId, applied);
    return applied;
  };

  for (const { record, input } of answers) {
    if (options.shouldStop?.() === true) return;
    const runId = record.runId;
    if (runId === null) continue;
    const run = runs.get(runId);
    if (run === undefined) {
      progress.waiting.delete(record.inputId);
      continue;
    }
    const flow = options.registry.flow(run.flow);
    if (flow === undefined) continue;
    const applied = await appliedFor(runId);
    if (applied.has(record.inputId)) {
      progress.waiting.delete(record.inputId);
      continue;
    }

    for (let attempt = 0; ; attempt += 1) {
      let state;
      try {
        state = await readState(options.log, runId);
      } catch {
        break;
      }
      if (
        state.status !== "waiting_person" ||
        state.wait === null ||
        state.wait.id !== input.waitId
      ) {
        progress.waiting.delete(record.inputId);
        break;
      }
      const withId: Input = { ...input, inputId: record.inputId };
      try {
        await applyInput(
          options.log,
          flow.flow,
          runId,
          state,
          withId,
          options.clock(),
          "person",
          `answer:${input.waitId}:${input.choice}`,
          {
            beforeEnd: async (endedRunId, ended) => {
              await options.kernel.emitRunEnd(endedRunId, ended);
            },
          },
        );
        applied.add(record.inputId);
        progress.waiting.delete(record.inputId);
        break;
      } catch (error) {
        if (error instanceof SeqConflictError && attempt < 2) continue;
        throw error;
      }
    }
  }
}

/**
 * One pass: tick every plugin, start the runs they asked for, and give every
 * active run without a live process a child of its own.
 */
export async function serveOnce(
  options: ServePassOptions,
): Promise<ServePassResult> {
  const clock = options.clock ?? (() => Date.now());
  const isRunnerAlive =
    options.isRunnerAlive ??
    ((runId: string) => lockHeld(runLockPath(options.lockRoot, runId)));
  const home = options.home ?? options.registry.home;
  let rules = options.rules;
  if (options.kernel === undefined && rules === undefined) {
    try {
      rules = await loadTriggerRules({ home, registry: options.registry });
    } catch {
      // A broken rule file must not stop the loop; the CLI reports it.
      rules = [];
    }
  }
  const kernel =
    options.kernel ??
    new Kernel({
      log: options.log,
      registry: options.registry,
      home,
      storeRoot: options.storeRoot ?? options.lockRoot,
      rules: rules ?? [],
    });
  const started: string[] = [];
  const spawned: string[] = [];

  await options.registry.tick(runLookup(options.log));
  const requests = options.registry.takeStartedRuns();
  for (const request of requests) {
    if (options.shouldStop?.() === true) break;
    const object = startObjectKey(request);
    try {
      const result = await kernel.start({
        flow: request.flow,
        object,
        ...(request.params === undefined ? {} : { params: request.params }),
        ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
        ...(request.inputId === undefined ? {} : { inputId: request.inputId }),
        ...(request.access === undefined ? {} : { access: request.access }),
      });
      if (result.kind === "started") started.push(result.runId);
    } catch (error) {
      if (error instanceof StartRefusedError) {
        options.onLog?.(`${request.plugin}/${request.flow}: ${error.message}`);
      } else if (!(error instanceof ActiveRunError)) throw error;
    }
  }

  if (options.shouldStop?.() !== true) {
    await applyRecordedAnswers({
      log: options.log,
      registry: options.registry,
      kernel,
      clock,
      ...(options.shouldStop === undefined
        ? {}
        : { shouldStop: options.shouldStop }),
    });
  }

  // Places freed while no process was left to hand them on (a crash after a
  // step's result, a run that ended) go to the next in line before runs are
  // given processes.
  if (options.shouldStop?.() !== true) {
    await new StepLimits({ log: options.log, lockRoot: options.lockRoot }).grant();
  }

  const active = await options.log.runs({ active: true });
  for (const run of active) {
    if (options.shouldStop?.() === true) break;
    const state = await readState(options.log, run.runId);

    if (state.status === "ended") {
      // Recording the end event comes first; `emitRunEnd` ends the run before
      // routing it, so a recovered run can start the same flow on the object.
      await kernel.emitRunEnd(run.runId, state);
      continue;
    }
    if (state.status === "waiting_person") continue;

    const now = clock();
    if (
      state.effect?.kind === "schedule_wake" &&
      state.effect.due !== null &&
      now < state.effect.due
    ) {
      continue;
    }

    if (isRunnerAlive(run.runId)) continue;
    if (options.isRecentlySpawned?.(run.runId) === true) continue;

    // A step the flow needs went missing: the run waits for the plugin.
    const problem = options.registry.startProblem(run.flow);
    if (problem !== undefined) {
      options.onLog?.(`run ${run.runId}: ${problem}`);
      continue;
    }

    // A start that died after creating its run must not become a run with no
    // record of the event that made it: restore the start files first, so the
    // child starts from the intended input and sees the same event.
    kernel.adoptStart(run);

    await options.spawnRun(run.runId, {
      recover:
        state.status === "running" &&
        state.effect !== null &&
        state.effectStarted === state.effect.id,
    });
    spawned.push(run.runId);
  }

  // A recorded event whose routing was interrupted is routed again. Outcomes
  // are derived from the log by input id, so a second pass cannot repeat one.
  if (options.shouldStop?.() !== true) {
    await kernel.recoverUnrouted();
  }

  return { started, spawned };
}

export interface ServeOptions extends Omit<ServePassOptions, "shouldStop"> {
  readonly home: string;
  /** The home lock, when the caller already holds it; `serve` releases it. */
  readonly lock?: LockHandle | undefined;
  /** Called after each pass; it must not wait for slow work. */
  readonly onPass?: (() => void) | undefined;
  readonly intervalMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly sleep?:
    | ((ms: number, signal?: AbortSignal) => Promise<void>)
    | undefined;
}

/** Waits `ms`, but a signal abort ends the wait at once. */
export function sleepUntilAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs passes until the signal aborts. A child is never killed: an interrupted
 * loop leaves it running, and the next loop picks the run up again.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const lock =
    options.lock ??
    acquireLock(serveLockPath(options.home), {
      clock: options.clock,
    });
  const intervalMs = options.intervalMs ?? 1_000;
  const sleep = options.sleep ?? sleepUntilAborted;
  const clock = options.clock ?? (() => Date.now());
  const spawnedAt = new Map<string, number>();
  let stopped = options.signal?.aborted === true;
  const stop = (): void => {
    stopped = true;
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  // A change another process made marks the loop, so it takes one more pass
  // before sleeping again. Writes this pass makes itself must not keep the
  // loop busy, so they are ignored while a pass is running.
  let inPass = false;
  let woken = false;
  const unsubscribe = options.log.subscribe?.(() => {
    if (!inPass) woken = true;
  });

  try {
    // A serve that died left the processes of its steps running: the runs that
    // are no longer active have none to keep.
    try {
      const active = await options.log.runs({ active: true });
      await reapStale({
        home: options.home,
        activeRunIds: active.map((run) => run.runId),
        log: (message) => options.onLog?.(message),
      });
    } catch (error) {
      options.onLog?.(`serve start: could not look for left-over processes: ${error instanceof Error ? error.message : String(error)}`);
    }
    while (!stopped) {
      inPass = true;
      const result = await serveOnce({
        ...options,
        shouldStop: () => stopped,
        isRecentlySpawned: (runId) => {
          const at = spawnedAt.get(runId);
          return at !== undefined && clock() - at < intervalMs * 2;
        },
      });
      inPass = false;
      options.onPass?.();
      const now = clock();
      for (const runId of result.spawned) spawnedAt.set(runId, now);
      if (stopped) break;
      if (woken) {
        woken = false;
        continue;
      }
      await sleep(intervalMs, options.signal);
    }
  } finally {
    unsubscribe?.();
    options.signal?.removeEventListener("abort", stop);
    lock.release();
  }
}

export { parseObjectKey };
