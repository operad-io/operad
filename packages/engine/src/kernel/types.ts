import type { EndStatus, Replay, StepKind } from "../flow/types.ts";
import type { FactCause, JsonValue, NewFact } from "../log/types.ts";

/** The kinds of fact the kernel writes. */
export type FactKind =
  | "run_started"
  | "step_entered"
  | "effect_requested"
  | "step_result"
  | "edge_taken"
  | "waiting_for_person"
  | "person_answered"
  | "run_ended"
  | "step_interrupted"
  | "crash_loop_stopped"
  | "visit_limit_reached"
  | "trigger_received"
  | "trigger_skipped";

/** One fact produced by `decide`; the log adds the run id, seq and time. */
export interface KernelFact extends NewFact {
  readonly kind: FactKind;
}

/** The descriptions a caller turns into work; the kernel performs no work. */
export type EffectKind = "run_plugin_step" | "notify_pending" | "schedule_wake" | "poll_check";

/** Effects that stay outstanding until a result or a wake. */
export type PendingEffectKind = Exclude<EffectKind, "notify_pending">;

/** Ask the plugin to run one of its step types. */
export interface RunPluginStepEffect {
  readonly kind: "run_plugin_step";
  readonly effectId: string;
  readonly step: string;
  readonly use: string;
  readonly params: JsonValue;
  readonly replay: Replay;
}

/** Tell the user a person is needed. */
export interface NotifyPendingEffect {
  readonly kind: "notify_pending";
  readonly waitId: string;
  readonly step: string;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly waitKind: WaitKind;
}

/** Wake the run again at a time. */
export interface ScheduleWakeEffect {
  readonly kind: "schedule_wake";
  readonly effectId: string;
  readonly step: string;
  readonly due: number;
}

/** Ask a plugin to check its condition again. */
export interface PollCheckEffect {
  readonly kind: "poll_check";
  readonly effectId: string;
  readonly step: string;
  readonly check: string;
}

export type Effect =
  | RunPluginStepEffect
  | NotifyPendingEffect
  | ScheduleWakeEffect
  | PollCheckEffect;

/** Inputs the caller may give `decide`. */
export type Input =
  | StartInput
  | StepResultInput
  | PersonAnswerInput
  | TickInput
  | RecoverInput
  | CancelInput;

export interface InputBase {
  /** The id the log gave this input. Facts caused by it point here. */
  readonly inputId?: string;
}

export interface StartInput extends InputBase {
  readonly kind: "start";
  /** Fixed JSON the flow was started with. */
  readonly params?: JsonValue;
  /** Hops of the event that started the run; 0 when no event started it. */
  readonly hops?: number;
  /** Where the run came from, in words the history view can print. */
  readonly trigger?: StartTrigger;
}

/** The event that started a run, without any of its text. */
export interface StartTrigger {
  readonly source: string;
  readonly type: string;
  readonly key?: string;
}

export interface StepResultInput extends InputBase {
  readonly kind: "step_result";
  readonly effectId: string;
  readonly result: string;
  readonly data?: JsonValue;
}

export interface PersonAnswerInput extends InputBase {
  readonly kind: "person_answer";
  readonly waitId: string;
  readonly choice: string;
  readonly note?: string;
}

export interface TickInput extends InputBase {
  readonly kind: "tick";
}

export interface RecoverInput extends InputBase {
  readonly kind: "recover";
}

export interface CancelInput extends InputBase {
  readonly kind: "cancel";
}

/** Who is waiting: a flow step, or the crash-loop decision. */
export type WaitKind = "step" | "crash_loop";

export type RunStatus = "idle" | "running" | "waiting" | "waiting_person" | "ended";

export type EffectStatus = "outstanding" | "done" | "abandoned";

export interface PendingEffect {
  readonly id: string;
  readonly kind: PendingEffectKind;
  readonly step: string;
  readonly use: string | null;
  readonly params: JsonValue;
  readonly check: string | null;
  readonly due: number | null;
  readonly replay: Replay;
}

export interface PendingWait {
  readonly id: string;
  readonly step: string;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly kind: WaitKind;
  readonly effectId: string | null;
}

export interface StepResultValue {
  readonly result: string;
  readonly data: JsonValue;
}

/** Everything the kernel knows, derived from the fact log alone. */
export interface KernelState {
  readonly status: RunStatus;
  /** Fixed JSON the flow was started with, or null. */
  readonly params: JsonValue;
  /** Hops of the event that started the run; 0 when no event started it. */
  readonly hops: number;
  readonly started: boolean;
  /** The one step a run is in, or null. */
  readonly step: string | null;
  readonly stepKind: StepKind | null;
  readonly endedStatus: EndStatus | null;
  readonly wait: PendingWait | null;
  readonly effect: PendingEffect | null;
  readonly visits: Readonly<Record<string, number>>;
  readonly recoveries: Readonly<Record<string, number>>;
  readonly effects: Readonly<Record<string, EffectStatus>>;
  readonly results: Readonly<Record<string, StepResultValue>>;
  readonly answeredWaits: Readonly<Record<string, true>>;
  readonly lastSeq: number;
}

export interface Decision {
  readonly facts: readonly KernelFact[];
  readonly effects: readonly Effect[];
}

/* Fact payloads, exported so callers and tests can name what they read. */

export interface RunStartedPayload {
  readonly flow: string;
  readonly params?: JsonValue;
  readonly hops?: number;
  readonly trigger?: StartTrigger;
}

export interface TriggerReceivedPayload {
  readonly source: string;
  readonly type: string;
  readonly key: string;
  readonly summary?: string;
  readonly link?: string;
  readonly hops: number;
}

export interface TriggerSkippedPayload {
  readonly source: string;
  readonly type: string;
  readonly key: string;
  readonly hops: number;
  readonly reason: string;
}

export interface StepEnteredPayload {
  readonly step: string;
  readonly visit: number;
  readonly kind: StepKind;
}

export interface EffectRequestedPayload {
  readonly effectId: string;
  readonly effect: PendingEffectKind;
  readonly step: string;
  readonly replay: Replay;
  readonly recovery: boolean;
  readonly use: string | null;
  readonly params: JsonValue;
  readonly check: string | null;
  readonly due: number | null;
}

export interface StepResultPayload {
  readonly effectId: string;
  readonly step: string;
  readonly result: string;
  readonly data: JsonValue;
}

export interface EdgeTakenPayload {
  readonly step: string;
  readonly result: string;
  readonly target: string;
}

export interface WaitingForPersonPayload {
  readonly waitId: string;
  readonly step: string;
  readonly prompt: string;
  readonly choices: string[];
  readonly waitKind: WaitKind;
  readonly effectId: string | null;
}

export interface PersonAnsweredPayload {
  readonly waitId: string;
  readonly step: string;
  readonly choice: string;
  readonly note: string | null;
  readonly waitKind: WaitKind;
}

export interface RunEndedPayload {
  readonly status: EndStatus;
  readonly reason: string | null;
}

export interface StepInterruptedPayload {
  readonly step: string;
  readonly effectId: string | null;
  readonly reason: string;
  readonly result: string | null;
}

export interface CrashLoopStoppedPayload {
  readonly step: string;
  readonly effectId: string;
  readonly recoveries: number;
}

export interface VisitLimitReachedPayload {
  readonly step: string;
  readonly visits: number;
  readonly limit: number;
}

/** The cause a fact gets when an input produces it directly. */
export function inputCause(input: Input): FactCause {
  return input.inputId ?? input.kind;
}
