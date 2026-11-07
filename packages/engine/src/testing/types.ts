/** The shapes `@operad-io/engine/testing` takes and returns. */

import type { Fact } from "../log/types.ts";
import type { JsonValue } from "../log/types.ts";
import type { PluginStore } from "../plugin/types.ts";
import type { TriggerResult } from "../trigger/types.ts";
import type { Clock } from "../platform/index.ts";

/** A clock the test moves. Timers fire only when `advance` passes them. */
export interface FakeClock extends Clock {
  /** The time now, in milliseconds. Starts at the value given to `fakeClock`. */
  now(): number;
  /** Moves time forward and fires every timer that falls due, in order. */
  advance(ms: number): void;
  /** How many timers are set and not yet fired or cleared. */
  readonly pending: number;
  /** Resolves once at least one timer is set. */
  whenTimer(): Promise<void>;
}

export interface RunFlowOptions {
  /** The object the run is about. Default: `<first object type>:1`. */
  readonly object?: { readonly type: string; readonly id: string } | undefined;
  /** Fixed JSON the flow starts with (`ctx.params`). */
  readonly params?: JsonValue | undefined;
  /** The plugin's `config.json` section (`ctx.settings`). */
  readonly settings?: Readonly<Record<string, JsonValue>> | undefined;
  /** The plugin's secrets (`ctx.secrets`). */
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  /** The access profile (`ctx.access`). */
  readonly access?: JsonValue | undefined;
  readonly clock?: FakeClock | undefined;
  /** Objects to start from. Default: an empty `memoryStore()`. */
  readonly store?: PluginStore | undefined;
}

export type FlowRunStatus = "ended" | "waiting_person" | "blocked";

export type FlowEnd = "done" | "failed" | "cancelled";

/** What a run is waiting for a person to answer. */
export interface FlowWait {
  readonly id: string;
  readonly prompt: string;
  readonly choices: readonly string[];
}

/** One run, as it stood when `runFlow`, `answer` or `resume` returned. */
export interface FlowRun {
  readonly runId: string;
  readonly flow: string;
  readonly status: FlowRunStatus;
  readonly end: FlowEnd | undefined;
  readonly wait: FlowWait | undefined;
  readonly facts: readonly Fact[];
  readonly history: readonly string[];
  readonly store: PluginStore;
}

export interface EmitOptions extends Omit<RunFlowOptions, "object"> {
  /** The idempotency key. Default: a fresh one. */
  readonly key?: string | undefined;
  /** The object the event is about, as `<type>:<id>`. */
  readonly object?: string | undefined;
  readonly summary?: string | undefined;
}

export interface EmitResult {
  /** True when a rule matched and started a run. */
  readonly started: boolean;
  readonly result: TriggerResult;
  /** The run the event started, taken to its end or first wait. */
  readonly run: FlowRun | undefined;
}
