/** How a step behaves when a run resumes after a crash. */
export type Replay = "safe" | "unsafe";

/** The internal names of the four basic steps. Users see only "step". */
export type StepKind = "plugin" | "wait_person" | "wait" | "end";

/** How a flow ends. */
export type EndStatus = "done" | "failed" | "cancelled";

/** The reserved step id an edge points at to finish the flow. */
export const END = "end";

/**
 * The shape a step must have before validation. `params` and `next` stay
 * `unknown` here so that `defineFlow` keeps the literal result keys a caller
 * wrote; validation and the conditional step check give them meaning.
 */
export interface StepShape {
  readonly id: string;
  readonly kind: StepKind;
  readonly params: unknown;
  readonly replay: Replay;
  readonly next?: unknown;
}

/** A flow definition: structure is data, step logic lives elsewhere. */
export interface FlowDefinition<S extends readonly StepShape[] = readonly StepShape[]> {
  readonly name: string;
  readonly entry: string;
  readonly maxVisits?: number;
  readonly steps: S;
}

/** Fields every step has. */
export interface StepBase {
  readonly id: string;
  readonly replay: Replay;
}

/** Calls a step type declared by a plugin. */
export interface PluginStep extends StepBase {
  readonly kind: "plugin";
  readonly params: {
    /** `<plugin>/<step type>`, such as `dev/command`. */
    readonly use: string;
    readonly params: unknown;
  };
  readonly next: Readonly<Record<string, string>>;
}

/** Asks a person; the turn ends and the process holds nothing while waiting. */
export interface WaitPersonStep extends StepBase {
  readonly kind: "wait_person";
  readonly params: {
    readonly prompt: string;
    readonly choices: readonly string[];
  };
  readonly next: Readonly<Record<string, string>>;
}

/** Waits for a time or for a plugin step's exit to change. */
export interface WaitStep extends StepBase {
  readonly kind: "wait";
  readonly params:
    | { readonly afterSecs: number }
    | { readonly check: string; readonly params?: unknown };
  readonly next: Readonly<Record<"ready" | "interrupted", string>>;
}

/** Finishes the flow. */
export interface EndStep extends StepBase {
  readonly kind: "end";
  readonly params: { readonly status: EndStatus };
  readonly next?: Readonly<Record<string, never>>;
}

export type Step = PluginStep | WaitPersonStep | WaitStep | EndStep;

/** One step type a plugin declares. */
export interface StepType {
  /** The full use name, such as `dev/command`, matched exactly. */
  readonly name: string;
  /** The result names the step can produce. */
  readonly results: readonly string[];
  /** Kept for the plugin loader that lands later; not interpreted here. */
  readonly paramsSchema?: unknown;
}

/** The step types validation may see. A single declaration or a list of them. */
export type StepTypeRegistry = StepType | readonly StepType[];
