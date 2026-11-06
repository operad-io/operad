/** Drives one run: inputs to `decide`, facts to the log, effects to plugins. */

import type { FlowDefinition } from "../flow/types.ts";
import type { Input, KernelState } from "../kernel/types.ts";
import type { JsonValue, LogBackend } from "../log/types.ts";
import type { PluginStepResult } from "../plugin/types.ts";
import { PluginRegistry } from "../plugin/registry.ts";
import type { ObjectRef } from "../plugin/types.ts";
import { messageOf } from "../plugin/errors.ts";
import { acquireLock, runLockPath, type LockHandle } from "./lock.ts";
import { applyInput, parseObjectKey, readState } from "./service.ts";

/** The wall time a plugin step may take before the run records a failure. */
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;

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

function chooseFailure(use: string, registry: PluginRegistry): string {
  const results = resultsOf(registry, use);
  if (results.includes("failed")) return "failed";
  if (results.includes("interrupted")) return "interrupted";
  return results[0] ?? "failed";
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
      const outcome = await this.execute(effect.check, null, true);
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
      ...(this.object === undefined
        ? {}
        : {
            object: {
              type: this.object.type,
              id: this.object.id,
              data:
                (await this.registry.store.get(this.object.type, this.object.id))
                  ?.data ?? {},
            },
          }),
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
    const results = resultsOf(this.registry, use);
    let result = chooseFailure(use, this.registry);
    if (preferInterrupted && results.includes("interrupted")) {
      result = "interrupted";
    }
    return { result, data };
  }
}
