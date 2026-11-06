/** Drives one run: inputs to `decide`, facts to the log, effects to plugins. */

import type { FlowDefinition } from "../flow/types.ts";
import type { Input, KernelState } from "../kernel/types.ts";
import type { JsonValue, LogBackend } from "../log/types.ts";
import type { PluginStepResult, RunObject } from "../plugin/types.ts";
import { PluginRegistry } from "../plugin/registry.ts";
import type { ObjectRef } from "../plugin/types.ts";
import { messageOf } from "../plugin/errors.ts";
import { Worker } from "node:worker_threads";
import { acquireLock, runLockPath, type LockHandle } from "./lock.ts";
import { applyInput, parseObjectKey, readState } from "./service.ts";

/** The wall time a plugin step may take before the run records a failure. */
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;

const STEP_WORKER = new URL("./step-worker.ts", import.meta.url);

interface StepWorkerReply {
  readonly ok: boolean;
  readonly result?: PluginStepResult | undefined;
  readonly error?: string | undefined;
}

function isStepWorkerReply(value: unknown): value is StepWorkerReply {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof (value as { ok: unknown }).ok === "boolean"
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
  /** Treat an outstanding step as a crash and recover it first. */
  readonly recover?: boolean | undefined;
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
          );
          state = result.state;
        }
      }

      if (state.status === "idle") {
        const result = await applyInput(
          this.log,
          this.flow,
          this.runId,
          state,
          { kind: "start" },
          this.clock(),
          "runner",
          "start",
        );
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
    const state = stateInput ?? (await readState(this.log, this.runId));
    if (state.status === "ended") return "ended";
    if (state.status === "waiting_person") return "waiting";
    if (state.status === "idle") {
      const result = await applyInput(
        this.log,
        this.flow,
        this.runId,
        state,
        { kind: "start" },
        this.clock(),
        "runner",
        "start",
      );
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
      );
      return result.duplicate ? "blocked" : "progress";
    }

    if (effect.kind === "poll_check") {
      if (effect.check === null) return "blocked";
      const outcome = await this.execute(effect.check, effect.params, true);
      if (outcome.result === "ready" || outcome.result === "interrupted") {
        await this.recordResult(state, effect.id, outcome.result, outcome.data);
        return "progress";
      }
      return "blocked";
    }

    if (effect.use === null) return "blocked";
    const outcome = await this.execute(effect.use, effect.params, false);
    await this.recordResult(state, effect.id, outcome.result, outcome.data);
    return "progress";
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
      );
    }
    return this.executeHere(use, params, object, preferInterrupted);
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
  ): Promise<PluginStepResult> {
    return new Promise((resolve) => {
      const worker = new Worker(STEP_WORKER, {
        workerData: {
          sources,
          home: this.registry.home,
          cwd: this.cwd ?? this.registry.workdir,
          storeRoot: this.registry.store.root,
          use,
          params,
          runId: this.runId,
          ...(object === undefined ? {} : { object }),
        },
      });

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: PluginStepResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        void worker.terminate();
        resolve(result);
      };
      const onAbort = (): void => {
        finish(
          this.failure(use, preferInterrupted, {
            reason: "aborted",
            message: "the step was cancelled",
          }),
        );
      };

      timer = setTimeout(() => {
        finish(
          this.failure(use, preferInterrupted, {
            reason: "timeout",
            message: `the step took longer than ${this.stepTimeoutMs} ms`,
          }),
        );
      }, this.stepTimeoutMs);
      this.signal?.addEventListener("abort", onAbort, { once: true });

      worker.once("message", (message: unknown) => {
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
  ): Promise<PluginStepResult> {
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    this.signal?.addEventListener("abort", forward, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.stepTimeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });

    const step = this.registry.runStep(use, params, {
      runId: this.runId,
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      ...(object === undefined ? {} : { object }),
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
          message: `the step took longer than ${this.stepTimeoutMs} ms`,
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
