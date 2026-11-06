/** The kernel loop: one per operad home, one child process per run. */

import { ActiveRunError } from "../log/errors.ts";
import type { LogBackend } from "../log/types.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type { StartRunRequest } from "../plugin/types.ts";
import { Kernel } from "../trigger/kernel.ts";
import { loadTriggerRules } from "../trigger/rules.ts";
import type { TriggerRule } from "../trigger/types.ts";
import { acquireLock, lockHeld, runLockPath, serveLockPath } from "../runner/lock.ts";
import { objectKey, parseObjectKey, readState } from "../runner/service.ts";

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

  await options.registry.tick();
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
      });
      if (result.kind === "started") started.push(result.runId);
    } catch (error) {
      if (!(error instanceof ActiveRunError)) throw error;
    }
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

    // A start that died after creating its run must not become a run with no
    // record of the event that made it: restore the start files first, so the
    // child starts from the intended input and sees the same event.
    kernel.adoptStart(run);

    await options.spawnRun(run.runId, {
      recover: state.status === "running",
    });
    spawned.push(run.runId);
  }

  // A run ended before its end event reached the rules loses that event unless
  // the recorded input is routed again. The run is already inactive here, so a
  // chained flow can start on the same object.
  if (options.shouldStop?.() !== true) {
    await kernel.recoverRunEnds();
  }

  return { started, spawned };
}

export interface ServeOptions extends Omit<ServePassOptions, "shouldStop"> {
  readonly home: string;
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
  const lock = acquireLock(serveLockPath(options.home), {
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

  try {
    while (!stopped) {
      const result = await serveOnce({
        ...options,
        shouldStop: () => stopped,
        isRecentlySpawned: (runId) => {
          const at = spawnedAt.get(runId);
          return at !== undefined && clock() - at < intervalMs * 2;
        },
      });
      const now = clock();
      for (const runId of result.spawned) spawnedAt.set(runId, now);
      if (stopped) break;
      await sleep(intervalMs, options.signal);
    }
  } finally {
    options.signal?.removeEventListener("abort", stop);
    lock.release();
  }
}

export { parseObjectKey };
