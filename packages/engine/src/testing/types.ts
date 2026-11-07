/** The shapes `@operad-io/engine/testing` takes and returns. */

import type { FlowDefinition } from "../flow/types.ts";
import type { Fact } from "../log/types.ts";
import type { JsonValue } from "../log/types.ts";
import type { PluginDefinition, PluginStore } from "../plugin/types.ts";
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

/**
 * The plugin a test runs: the path or package name of its module (steps then
 * run in a worker, as under `serve`), or its definition, which can only run
 * with `inProcess: true`.
 */
export type PluginUnderTest = PluginDefinition | string;

/** What a world is made of. */
export interface WorldOptions {
  /** The plugin's `config.json` section (`ctx.settings`). */
  readonly settings?: Readonly<Record<string, JsonValue>> | undefined;
  /** The plugin's secrets (`ctx.secrets`). */
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly clock?: FakeClock | undefined;
  /**
   * Run steps in this process against an in-memory store: faster, not isolated.
   * A step then shares module state with the test and may return values a
   * worker could not hand back, so it can pass here and fail under `serve`.
   * Needed when the plugin is given as a definition.
   */
  readonly inProcess?: boolean | undefined;
  /** Objects to start from; only with `inProcess`. Default: `memoryStore()`. */
  readonly store?: PluginStore | undefined;
}

export interface RunFlowOptions extends WorldOptions {
  /** The object the run is about. Default: `<first object type>:1`. */
  readonly object?: { readonly type: string; readonly id: string } | undefined;
  /** Fixed JSON the flow starts with (`ctx.params`). */
  readonly params?: JsonValue | undefined;
  /** The access profile (`ctx.access`). */
  readonly access?: JsonValue | undefined;
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

export interface EmitOptions {
  /** The idempotency key. Default: a fresh one for each event of a world. */
  readonly key?: string | undefined;
  /** The object the event is about, as `<type>:<id>`. */
  readonly object?: string | undefined;
  readonly summary?: string | undefined;
}

export interface EmitResult {
  /** True when this event started a run: a rule matched and it was not a repeat. */
  readonly started: boolean;
  readonly result: TriggerResult;
  /** The run the event started, taken to its end or first wait. */
  readonly run: FlowRun | undefined;
}

/**
 * One log, store, kernel and clock that several calls share, so a repeated
 * event key is a repeat and a run that ends can start the next one.
 */
export interface TestWorld {
  readonly store: PluginStore;
  /** Starts `flow` and runs the world until nothing more can happen. */
  runFlow(
    flow: string | FlowDefinition,
    options?: Pick<RunFlowOptions, "object" | "params" | "access">,
  ): Promise<FlowRun>;
  /** Sends an event through the plugin's rules, as a source plugin would. */
  emit(
    source: string,
    type: string,
    data?: JsonValue,
    options?: EmitOptions,
  ): Promise<EmitResult>;
  /** Every run of the world, in the order they started. */
  runs(): Promise<readonly FlowRun[]>;
  close(): Promise<void>;
}
