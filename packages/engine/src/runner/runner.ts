/** Drives one run: inputs to `decide`, facts to the log, effects to plugins. */

import type { FlowDefinition } from "../flow/types.ts";
import type { Input, KernelState, StartInput } from "../kernel/types.ts";
import type { JsonValue, LogBackend } from "../log/types.ts";
import type { PluginStepResult, RunObject } from "../plugin/types.ts";
import { PluginRegistry } from "../plugin/registry.ts";
import type { ObjectRef } from "../plugin/types.ts";
import { messageOf } from "../plugin/errors.ts";
import type { StepEvent, TriggerView } from "../trigger/types.ts";
import { Worker } from "node:worker_threads";
import { KILL_GRACE_MS } from "../platform/index.ts";
import { acquireLock, runLockPath, type LockHandle } from "./lock.ts";
import { appendInput, applyInput, parseObjectKey, readState } from "./service.ts";

/** The wall time a plugin step may take before the run records a failure. */
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long a worker gets to stop what it started before it is terminated. A
 * process-group stop may wait one grace for the sentinel's `ready` and one more
 * after SIGTERM before it sends SIGKILL, so this exceeds both plus latency;
 * terminating sooner would leave the sentinel and its line running.
 */
export const WORKER_ABORT_GRACE_MS = 2 * KILL_GRACE_MS + 1000;

const STEP_WORKER = new URL("./step-worker.ts", import.meta.url);

interface StepWorkerReply {
  readonly kind: "result";
  readonly ok: boolean;
  readonly result?: PluginStepResult | undefined;
  readonly error?: string | undefined;
}

interface StepWorkerEmit {
  readonly kind: "emit";
  readonly id: number;
  readonly plugin: string;
  readonly event: StepEvent;
}

function isStepWorkerReply(value: unknown): value is StepWorkerReply {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "result" &&
    "ok" in value &&
    typeof (value as { ok: unknown }).ok === "boolean"
  );
}

function isStepWorkerEmit(value: unknown): value is StepWorkerEmit {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "emit" &&
    typeof (value as { id?: unknown }).id === "number" &&
    typeof (value as { plugin?: unknown }).plugin === "string" &&
    typeof (value as { event?: unknown }).event === "object"
  );
}

export type RunnerOutcome = "progress" | "waiting" | "blocked" | "ended";

export interface RunnerOptions {
  readonly log: LogBackend;
  readonly flow: FlowDefinition;
  readonly runId: string;
  readonly registry: PluginRegistry;
  readonly clock?: (() => number) | undefined;
  readonly stepTimeoutMs?: number | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** The store root; the run lock lives under `<root>/locks/runs`. */
  readonly lockRoot?: string | undefined;
  readonly object?: ObjectRef | undefined;
  /** Fixed JSON the flow starts with; the runner writes it in the start fact. */
  readonly params?: JsonValue | undefined;
  /** The access profile the run starts with; recovery reads it from the log. */
  readonly access?: JsonValue | undefined;
  /** Treat an outstanding step as a crash and recover it first. */
  readonly recover?: boolean | undefined;
  /** The event that started the run, read-only for its steps. */
  readonly trigger?: TriggerView | undefined;
  /** The start fact to use for an idle run, written by the start entry. */
  readonly startInput?: StartInput | undefined;
  /** Sends an event a step emitted, from the plugin that registered it. */
  readonly emit?:
    | ((plugin: string, event: StepEvent) => Promise<void>)
    | undefined;
  /** Called once when the run ends, before the log marks it ended. */
  readonly onEnded?:
    | ((runId: string, state: KernelState) => Promise<void>)
    | undefined;
}

function resultsOf(registry: PluginRegistry, use: string): readonly string[] {
  return registry.stepResults(use) ?? [];
}

function chooseFailure(
  use: string,
  registry: PluginRegistry,
  preferInterrupted: boolean,
): string {
  // A check reports through the wait step, which accepts only "interrupted"
  // as a failure; a plugin step uses the failure result it declares.
  if (preferInterrupted) return "interrupted";
  const results = resultsOf(registry, use);
  if (results.includes("failed")) return "failed";
  if (results.includes("interrupted")) return "interrupted";
  // No declared failure result: name the failure anyway, so the kernel turns
  // it into an interrupted step instead of advancing on a success result.
  return "failed";
}

/**
 * The plugin specifiers when every plugin has one, or undefined when a plugin
 * was registered in memory and cannot be reloaded in a worker.
 */
function allSources(
  sources: readonly (string | undefined)[],
): readonly string[] | undefined {
  const resolved: string[] = [];
  for (const source of sources) {
    if (source === undefined) return undefined;
    resolved.push(source);
  }
  return resolved;
}

export class Runner {
  private readonly log: LogBackend;
  private readonly flow: FlowDefinition;
  private readonly registry: PluginRegistry;
  private readonly clock: () => number;
  private readonly stepTimeoutMs: number;
  private readonly cwd: string | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly lockRoot: string | undefined;
  private readonly object: ObjectRef | undefined;
  private readonly trigger: TriggerView | undefined;
  private readonly startInput: StartInput | undefined;
  private readonly params: JsonValue | undefined;
  private readonly access: JsonValue | undefined;
  private readonly emitEvent:
    | ((plugin: string, event: StepEvent) => Promise<void>)
    | undefined;
  private readonly onEnded:
    | ((runId: string, state: KernelState) => Promise<void>)
    | undefined;
  private readonly recover: boolean;
  readonly runId: string;

  constructor(options: RunnerOptions) {
    this.log = options.log;
    this.flow = options.flow;
    this.runId = options.runId;
    this.registry = options.registry;
    this.clock = options.clock ?? (() => Date.now());
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.cwd = options.cwd;
    this.signal = options.signal;
    this.lockRoot = options.lockRoot;
    this.object = options.object;
    this.trigger = options.trigger;
    this.startInput = options.startInput;
    this.emitEvent = options.emit;
    this.onEnded = options.onEnded;
    this.params = options.params;
    this.access = options.access;
    this.recover = options.recover === true;
  }

  /**
   * Takes the run's lock and drives it until it waits for a person, waits for
   * a time or check, or ends. On a recovery start an outstanding step is fed
   * to `recover` before anything else.
   */
  async run(): Promise<RunnerOutcome> {
    let lock: LockHandle | undefined;
    if (this.lockRoot !== undefined) {
      lock = acquireLock(runLockPath(this.lockRoot, this.runId), {
        clock: this.clock,
      });
    }
    try {
      let state = await readState(this.log, this.runId);
      if (state.status === "ended") {
        // Record the end event before ending the run: a crash in between leaves
        // the run active, and the next pass records the same event again.
        await this.onEnded?.(this.runId, state);
        await this.log.endRun(this.runId);
        return "ended";
      }
      let pendingRecovery = this.recover;

      if (pendingRecovery) {
        pendingRecovery = false;
        if (
          state.status === "running" &&
          state.effect !== null &&
          state.effects[state.effect.id] === "outstanding"
        ) {
          const result = await applyInput(
            this.log,
            this.flow,
            this.runId,
            state,
            { kind: "recover" },
            this.clock(),
            "runner",
            `recover:${state.lastSeq}`,
            this.hooks(),
          );
          state = result.state;
        }
      }

      if (state.status === "idle") {
        const result = await this.startIdle(state);
        state = result.state;
      }

      let outcome: RunnerOutcome = "progress";
      while (outcome === "progress") {
        outcome = await this.step(state);
        if (outcome === "progress") {
          state = await readState(this.log, this.runId);
        }
      }
      return outcome;
    } finally {
      lock?.release();
    }
  }

  /** Performs one unit of work for the run, or reports why it cannot. */
  async step(stateInput?: KernelState): Promise<RunnerOutcome> {
    let state = stateInput ?? (await readState(this.log, this.runId));
    if (state.status === "ended") return "ended";
    if (state.status === "waiting_person") return "waiting";
    if (state.status === "idle") {
      const result = await this.startIdle(state);
      return result.duplicate ? "blocked" : "progress";
    }

    const effect = state.effect;
    if (effect === null) return "blocked";

    if (effect.kind === "schedule_wake") {
      if (effect.due === null || this.clock() < effect.due) return "blocked";
      const result = await applyInput(
        this.log,
        this.flow,
        this.runId,
        state,
        { kind: "tick" },
        this.clock(),
        "runner",
        `tick:${state.lastSeq}`,
        this.hooks(),
      );
      return result.duplicate ? "blocked" : "progress";
    }

    if (effect.kind === "poll_check") {
      if (effect.check === null) return "blocked";
      const outcome = await this.execute(effect.check, effect.params, true, state.params, state.access);
      if (outcome.result === "ready" || outcome.result === "interrupted") {
        await this.recordResult(state, effect.id, outcome.result, outcome.data);
        return "progress";
      }
      return "blocked";
    }

    if (effect.use === null) return "blocked";
    if (state.effectStarted !== effect.id) {
      state = await this.markStarted(state, effect);
    }
    const outcome = await this.execute(effect.use, effect.params, false, state.params, state.access);
    await this.recordResult(state, effect.id, outcome.result, outcome.data);
    return "progress";
  }

  private hooks(): {
    readonly beforeEnd: (runId: string, state: KernelState) => Promise<void>;
  } {
    return {
      beforeEnd: async (runId, state) => {
        await this.onEnded?.(runId, state);
      },
    };
  }

  /** Applies the run's start fact, using the start entry's metadata when present. */
  private async startIdle(
    state: KernelState,
  ): Promise<{ readonly state: KernelState; readonly duplicate: boolean }> {
    const meta = this.startInput;
    const provided = meta?.access ?? this.access;
    const access =
      provided ?? (meta === undefined ? await this.initialAccess() : undefined);
    this.registry.checkAccess(this.flow.name, access);
    if (meta !== undefined && meta.inputId !== undefined) {
      const start: Input =
        access === undefined || meta.access !== undefined
          ? meta
          : { ...meta, access };
      const result = await appendInput(
        this.log,
        this.flow,
        this.runId,
        state,
        start,
        this.clock(),
      );
      if (result.state.status === "ended") {
        await this.onEnded?.(this.runId, result.state);
        await this.log.endRun(this.runId);
      }
      return { state: result.state, duplicate: false };
    }
    const input: Input =
      meta === undefined
        ? {
            kind: "start",
            ...(this.params === undefined ? {} : { params: this.params }),
            ...(access === undefined ? {} : { access }),
          }
        : {
            kind: "start",
            ...(meta.params === undefined ? {} : { params: meta.params }),
            ...(meta.hops === undefined ? {} : { hops: meta.hops }),
            ...(meta.trigger === undefined ? {} : { trigger: meta.trigger }),
            ...(access === undefined ? {} : { access }),
          };
    const result = await applyInput(
      this.log,
      this.flow,
      this.runId,
      state,
      input,
      this.clock(),
      "runner",
      "start",
      this.hooks(),
    );
    return { state: result.state, duplicate: result.duplicate };
  }

  /**
   * Records that this process began the step. `serve` reads it to tell a
   * crashed step from a fresh one, and the fact names the process that ran it.
   */
  private async markStarted(
    state: KernelState,
    effect: NonNullable<KernelState["effect"]>,
  ): Promise<KernelState> {
    await this.log.append(this.runId, state.lastSeq, [
      {
        kind: "step_started",
        payload: { step: effect.step, effectId: effect.id, pid: process.pid },
        cause: state.lastSeq,
      },
    ]);
    return readState(this.log, this.runId);
  }

  private async recordResult(
    state: KernelState,
    effectId: string,
    result: string,
    data: object | undefined,
  ): Promise<void> {
    const input: Input =
      data === undefined
        ? { kind: "step_result", effectId, result }
        : {
            kind: "step_result",
            effectId,
            result,
            data: data as unknown as JsonValue,
          };
    await applyInput(
      this.log,
      this.flow,
      this.runId,
      state,
      input,
      this.clock(),
      "runner",
      `result:${effectId}`,
      this.hooks(),
    );
  }

  /**
   * Runs a plugin step with a wall-time limit and the cancel signal. A step
   * that throws or overruns becomes a declared failure result; the data says
   * which in words the history view can print.
   *
   * A step whose plugin came from a file runs in a worker thread, so the wall
   * time also bounds a step that never yields to the event loop. A registry
   * built in memory has no file to reload, so its steps stay in this process.
   */
  private async execute(
    use: string,
    params: unknown,
    preferInterrupted: boolean,
    flowParams: JsonValue,
    access: JsonValue,
  ): Promise<PluginStepResult> {
    if (this.signal?.aborted === true) {
      return this.failure(use, preferInterrupted, {
        reason: "aborted",
        message: "the step was cancelled",
      });
    }

    const object = await this.runObject();
    const sources =
      this.registry.store.kind === "file"
        ? allSources(this.registry.pluginSources())
        : undefined;
    if (sources !== undefined) {
      return this.executeInWorker(
        use,
        params,
        object,
        sources,
        preferInterrupted,
        flowParams,
        access,
      );
    }
    return this.executeHere(
      use,
      params,
      object,
      preferInterrupted,
      flowParams,
      access,
    );
  }

  private startInputFor(access: JsonValue | undefined): Input {
    return {
      kind: "start",
      ...(this.params === undefined ? {} : { params: this.params }),
      ...(access === undefined ? {} : { access }),
    };
  }

  /** The profile given to the runner, or the one the log recorded at start. */
  private async initialAccess(): Promise<JsonValue | undefined> {
    if (this.access !== undefined) return this.access;
    const runs = await this.log.runs();
    return runs.find((run) => run.runId === this.runId)?.access;
  }

  /** The step type's own `timeoutSecs`, or the runner's step timeout. */
  private timeoutMsFor(use: string): number {
    const declared = this.registry
      .stepTypes()
      .find((type) => type.name === use)?.timeoutSecs;
    return declared === undefined ? this.stepTimeoutMs : declared * 1000;
  }

  private async runObject(): Promise<RunObject | undefined> {
    if (this.object === undefined) return undefined;
    const stored = await this.registry.store.get(
      this.object.type,
      this.object.id,
    );
    return {
      type: this.object.type,
      id: this.object.id,
      data: stored?.data ?? {},
    };
  }

  private executeInWorker(
    use: string,
    params: unknown,
    object: RunObject | undefined,
    sources: readonly string[],
    preferInterrupted: boolean,
    flowParams: JsonValue,
    access: JsonValue,
  ): Promise<PluginStepResult> {
    return new Promise((resolve) => {
      const worker = new Worker(STEP_WORKER, {
        workerData: {
          sources,
          home: this.registry.home,
          cwd: this.cwd ?? this.registry.workdir,
          storeRoot: this.registry.store.root,
          ...(this.registry.store.location === undefined
            ? {}
            : { store: this.registry.store.location }),
          use,
          params,
          flowParams,
          access,
          settings: this.registry.pluginSettings(),
          ...(this.trigger === undefined ? {} : { trigger: this.trigger }),
          runId: this.runId,
          ...(object === undefined ? {} : { object }),
        },
      });

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: PluginStepResult, terminate = true): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        if (terminate) {
          void worker.terminate();
          resolve(result);
        } else {
          // Give the step a moment to stop the processes it started; the
          // worker is killed anyway when it does not answer in time. The run
          // waits for that cleanup so it never leaves a process behind.
          stopTimer = setTimeout(() => {
            void worker.terminate();
          }, WORKER_ABORT_GRACE_MS);
          worker.once("exit", () => {
            if (stopTimer !== undefined) clearTimeout(stopTimer);
            resolve(result);
          });
        }
      };
      const abortWorker = (): void => {
        try {
          worker.postMessage("abort");
        } catch {
          // The worker ended between the abort and this message.
        }
      };
      const onAbort = (): void => {
        abortWorker();
        finish(
          this.failure(use, preferInterrupted, {
            reason: "aborted",
            message: "the step was cancelled",
          }),
          false,
        );
      };

      timer = setTimeout(() => {
        abortWorker();
        finish(
          this.failure(use, preferInterrupted, {
            reason: "timeout",
            message: `the step took longer than ${this.timeoutMsFor(use)} ms`,
          }),
          false,
        );
      }, this.timeoutMsFor(use));
      this.signal?.addEventListener("abort", onAbort, { once: true });

      worker.on("message", (message: unknown) => {
        if (settled) {
          // The step answered after an abort: it has stopped what it started.
          void worker.terminate();
          return;
        }
        if (isStepWorkerEmit(message)) {
          void (async () => {
            try {
              if (this.emitEvent === undefined) {
                throw new Error("no event destination is configured");
              }
              await this.emitEvent(message.plugin, message.event);
              worker.postMessage({ kind: "emit-result", id: message.id, ok: true });
            } catch (error) {
              worker.postMessage({
                kind: "emit-result",
                id: message.id,
                ok: false,
                error: messageOf(error),
              });
            }
          })();
          return;
        }
        if (isStepWorkerReply(message) && message.ok && message.result) {
          finish(message.result);
          return;
        }
        finish(
          this.failure(use, preferInterrupted, {
            reason: "error",
            message:
              isStepWorkerReply(message) && message.error !== undefined
                ? message.error
                : "the step failed",
          }),
        );
      });
      worker.once("error", (error) => {
        finish(
          this.failure(use, preferInterrupted, {
            reason: "error",
            message: messageOf(error),
          }),
        );
      });
      worker.once("exit", () => {
        if (stopTimer !== undefined) clearTimeout(stopTimer);
        finish(
          this.failure(use, preferInterrupted, {
            reason: "error",
            message: "the step ended without a result",
          }),
        );
      });
    });
  }

  private async executeHere(
    use: string,
    params: unknown,
    object: RunObject | undefined,
    preferInterrupted: boolean,
    flowParams: JsonValue,
    access: JsonValue,
  ): Promise<PluginStepResult> {
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    this.signal?.addEventListener("abort", forward, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.timeoutMsFor(use));
    });

    const step = this.registry.runStep(use, params, {
      runId: this.runId,
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      ...(object === undefined ? {} : { object }),
      params: flowParams,
      access,
      ...(this.trigger === undefined ? {} : { trigger: this.trigger }),
      ...(this.emitEvent === undefined ? {} : { emit: this.emitEvent }),
      signal: controller.signal,
    });
    // After a timeout the plugin may still reject; that rejection is no
    // longer interesting, and must not crash the process.
    step.catch(() => undefined);

    try {
      const raced = await Promise.race([
        step.then((value) => ({ kind: "result" as const, value })),
        timeout.then(() => ({ kind: "timeout" as const })),
      ]);
      if (raced.kind === "timeout") {
        return this.failure(use, preferInterrupted, {
          reason: "timeout",
          message: `the step took longer than ${this.timeoutMsFor(use)} ms`,
        });
      }
      return raced.value;
    } catch (error) {
      return this.failure(use, preferInterrupted, {
        reason: "error",
        message: messageOf(error),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.signal?.removeEventListener("abort", forward);
    }
  }

  private failure(
    use: string,
    preferInterrupted: boolean,
    data: { readonly reason: string; readonly message: string },
  ): PluginStepResult {
    return {
      result: chooseFailure(use, this.registry, preferInterrupted),
      data,
    };
  }
}
