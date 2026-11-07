import type { EndStatus, Replay, StepKind } from "../flow/types.ts";
import type { FactCause, JsonValue, NewFact } from "../log/types.ts";
import type { Actor } from "../plugin/types.ts";

/** The kinds of fact the kernel writes. */
export type FactKind =
  | "run_started"
  | "step_entered"
  | "effect_requested"
  | "step_started"
  | "step_queued"
  | "step_slot"
  | "step_released"
  | "step_result"
  | "edge_taken"
  | "waiting_for_person"
  | "person_answered"
  | "ask_opened"
  | "ask_answered"
  | "ask_timed_out"
  | "ask_refused"
  | "grant_used"
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
  /** The wait's own params for the check; `null` when it gave none. */
  readonly params: JsonValue;
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
  /** Fixed JSON the flow was started with, read by its steps. */
  readonly params?: JsonValue | undefined;
  /** The access profile the run starts with, opaque to the kernel. */
  readonly access?: JsonValue | undefined;
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
  /** Who answered: a person through a client. */
  readonly actor: Actor;
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

/**
 * A one-time permission an answer to a question gives: the exact command or
 * path the question was about. It lives in the effect that continues the step,
 * never in the run's own access profile.
 */
export interface Grant {
  readonly waitId: string;
  readonly kind: "command" | "path";
  readonly value: string;
  /** The tool the person approved; a path grant covers that tool only. */
  readonly tool?: string;
}

/** A question that was answered, waiting for the step that asked to run again. */
export interface AnsweredAskState {
  readonly waitId: string;
  readonly step: string;
  readonly prompt: string;
  readonly resume: JsonValue;
  readonly choice: string;
  readonly note: string | null;
}

/** What a flow wait took over from a step that asked and ran out of grace. */
export interface AskedWait {
  /** The step that asked; the answer sends the run back to it. */
  readonly step: string;
  /** What the step left to carry on with: a session and the call asked about. */
  readonly resume: JsonValue;
}

export interface PendingEffect {
  readonly id: string;
  readonly kind: PendingEffectKind;
  readonly step: string;
  readonly use: string | null;
  readonly params: JsonValue;
  readonly check: string | null;
  readonly due: number | null;
  readonly replay: Replay;
  /** Permissions for this run of the step only, from an answered question. */
  readonly grants?: readonly Grant[] | undefined;
}

export interface PendingWait {
  readonly id: string;
  readonly step: string;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly kind: WaitKind;
  readonly effectId: string | null;
  readonly ask?: AskedWait | undefined;
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
  /** The access profile recorded at the start; null when there is none. */
  readonly access: JsonValue;
  /** Hops of the event that started the run; 0 when no event started it. */
  readonly hops: number;
  readonly started: boolean;
  /** The one step a run is in, or null. */
  readonly step: string | null;
  readonly stepKind: StepKind | null;
  readonly endedStatus: EndStatus | null;
  readonly wait: PendingWait | null;
  readonly effect: PendingEffect | null;
  /** The effect a runner has started; null when nothing has run yet. */
  readonly effectStarted: string | null;
  readonly visits: Readonly<Record<string, number>>;
  readonly recoveries: Readonly<Record<string, number>>;
  readonly effects: Readonly<Record<string, EffectStatus>>;
  readonly results: Readonly<Record<string, StepResultValue>>;
  readonly answeredWaits: Readonly<Record<string, true>>;
  /** The answer to a question, kept until the step that asked runs again. */
  readonly answeredAsk: AnsweredAskState | null;
  readonly lastSeq: number;
}

export interface Decision {
  readonly facts: readonly KernelFact[];
  readonly effects: readonly Effect[];
}

/* Fact payloads, exported so callers and tests can name what they read. */

export interface RunStartedPayload {
  readonly flow: string;
  readonly params?: JsonValue | undefined;
  readonly access?: JsonValue | undefined;
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

/** A runner began executing an effect; `pid` is the process that did. */
export interface StepStartedPayload {
  readonly step: string;
  readonly effectId: string;
  readonly pid: number;
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
  readonly grants?: readonly Grant[];
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
  readonly ask?: AskedWait;
}

export interface PersonAnsweredPayload {
  readonly waitId: string;
  readonly step: string;
  readonly choice: string;
  readonly note: string | null;
  readonly waitKind: WaitKind;
  readonly actor: Actor | null;
  /** Set when the wait took over a question a step asked. */
  readonly ask?: {
    readonly step: string;
    readonly prompt: string;
    readonly resume: JsonValue;
  };
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
  /** What the step said when it stopped with a result the flow does not expect. */
  readonly message?: string | undefined;
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
