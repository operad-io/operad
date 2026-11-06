import type { FlowDefinition } from "../flow/types.ts";
import type { JsonValue } from "../log/types.ts";
import type {
  SourceEvent,
  StepEvent,
  TriggerEvent,
  TriggerRule,
  TriggerView,
} from "../trigger/types.ts";

/** The plugin API version a module declares with `operadPlugin`. */
export const OPERAD_PLUGIN_VERSION = 1 as const;

/**
 * The plugin kinds the kernel recognises. These names are internal: user text
 * never names a kind.
 */
export type PluginKind =
  | "domain"
  | "harness"
  | "stage"
  | "channel"
  | "source"
  | "action";

/** A synchronous value, or a promise of one. Plugin hooks may use either. */
export type MaybePromise<T> = T | Promise<T>;

/** The data of an object: JSON-shaped and owned by the plugin that declares it. */
export type ObjectData = Readonly<Record<string, unknown>>;

/** One line of a list: what the plugin shows for an object. */
export interface ObjectRow {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  /** A short tail for the row, such as a cost or a duration. */
  readonly note?: string | undefined;
}

/** One section a detail page offers. `live` means its content still grows. */
export interface ViewSection {
  readonly id: string;
  readonly title: string;
  readonly live?: boolean | undefined;
}

/** Where a section read starts; the plugin owns the meaning of the value. */
export interface SectionReadOptions {
  readonly cursor?: string | undefined;
}

/** The Markdown of one section, and where to continue when it is paged. */
export interface SectionContent {
  readonly markdown: string;
  readonly next?: string | undefined;
}

/** The context a `load` call receives. */
export interface ViewContext extends PluginBaseContext {}

/** How one object type appears to every client. */
export interface ObjectViews {
  /** Must be pure and fast: it reads the stored object and nothing else. */
  readonly row: (object: StoredObject) => ObjectRow;
  /** The section directory only; it reads no section content. */
  readonly sections: (object: StoredObject) => readonly ViewSection[];
  /** Called when a person opens a section; it may be slow and paged. */
  readonly load: (
    ctx: ViewContext,
    object: StoredObject,
    sectionId: string,
    options: SectionReadOptions,
  ) => MaybePromise<SectionContent>;
}

/** A key binding a plugin brings as its default. */
export type KeyBindings = Readonly<Record<string, string>>;

/** Names an object without carrying its state. */
export interface ObjectRef {
  readonly type: string;
  readonly id: string;
}

/** An object as a run sees it. */
export interface RunObject extends ObjectRef {
  readonly data: ObjectData;
}

/** An object after it was stored, with the fact that produced this version. */
export interface StoredObject extends RunObject {
  readonly version: number;
  readonly cause: string;
  readonly at: number;
}

/**
 * One fact a plugin sees. Facts hold data and paths, never process output.
 * The name stays apart from the storage backend's `Fact`, which is run-scoped.
 */
export interface PluginFact {
  readonly sequence: number;
  readonly type: string;
  readonly object: ObjectRef | undefined;
  readonly cause: string;
  readonly at: number;
  readonly data: ObjectData;
}

/** A fact a plugin appends for itself, outside the objects it owns. */
export interface FactInput {
  readonly type: string;
  readonly data: ObjectData;
  readonly object?: ObjectRef | undefined;
  readonly cause?: string | undefined;
}

/**
 * The object side of the store. A plugin reads and writes objects here and
 * never touches the storage backend.
 */
export interface ObjectStore {
  /** The directory that holds this store's files, such as logs. */
  readonly root: string;

  /**
   * Tells a listener whenever an object gains a fact. Optional: a store that
   * cannot watch simply returns a no-op unsubscribe.
   */
  subscribe?(listener: (object: ObjectRef) => void): () => void;

  /** Every fact in append order, when this store keeps them in memory. */
  facts?(): readonly PluginFact[];

  /** Stores a new version of an object and appends the change as a fact. */
  put(
    type: string,
    id: string,
    data: ObjectData,
    cause: string,
  ): MaybePromise<StoredObject>;

  get(type: string, id: string): MaybePromise<StoredObject | undefined>;

  list(type: string): MaybePromise<readonly StoredObject[]>;
}

/** Appends facts that are not an object change, such as a step's output path. */
export interface FactWriter {
  append(input: FactInput): MaybePromise<PluginFact>;
}

/** The store a plugin sees: objects plus its own facts. */
export interface PluginStore extends ObjectStore, FactWriter {
  /**
   * `file` stores live under one directory and a worker step sees the same
   * data; `memory` stores exist only in this process.
   */
  readonly kind: "file" | "memory";
}

/** Writes text to a file under the store and returns its path. */
export interface PluginLogger {
  readonly path: string;
  write(text: string): Promise<string>;
}

/** Fields every plugin hook receives. */
export interface PluginBaseContext {
  readonly plugin: string;
  readonly home: string;
  readonly cwd: string;
  readonly store: ObjectStore;
  readonly facts: FactWriter;
  readonly logger: PluginLogger;
  readonly signal: AbortSignal;
}

/** The answer a plugin action gives to the person wait it is answering. */
export type Answer = (choice: string, note?: string) => MaybePromise<void>;

/** The result of one plugin's optional `check`. */
export interface PluginCheck {
  readonly plugin: string;
  readonly ok: boolean;
  readonly message: string;
}

/** The context a step run receives. */
export interface StepContext extends PluginBaseContext {
  readonly runId: string;
  readonly object: RunObject | undefined;
  /** Fixed JSON the flow was started with. */
  readonly params: JsonValue;
  /** The event that started the run, with paths to its text. */
  readonly trigger: TriggerView | undefined;
  /** Sends an event; the type must begin with this plugin's name. */
  emit(event: StepEvent): Promise<void>;
}

/** What a step returns. `result` must be one of the step type's results. */
export interface PluginStepResult {
  readonly result: string;
  readonly data?: ObjectData | undefined;
}

/** Options for running a step through the registry. */
export interface StepRunOptions {
  readonly runId: string;
  readonly object?: RunObject | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly params?: JsonValue | undefined;
  readonly trigger?: TriggerView | undefined;
  readonly emit?: ((event: StepEvent) => MaybePromise<void>) | undefined;
}

/** A step type a plugin declares. The use name is `<plugin>/<name>`. */
export interface StepTypeDefinition {
  readonly name: string;
  readonly results: readonly string[];
  readonly run: (
    ctx: StepContext,
    params: unknown,
  ) => MaybePromise<PluginStepResult>;
}

/** An object type a plugin owns, such as `task`. */
export interface ObjectTypeDefinition {
  readonly name: string;
  readonly schema?: unknown;
}

/** Whether an action asks the person for a note. */
export type ActionNote = boolean | { readonly required: boolean };

/** An action a plugin offers on an object type. */
export interface ActionTypeDefinition {
  readonly name: string;
  readonly on: string;
  /** The action needs a note from the person (`true` and `{ required: true }`). */
  readonly note?: ActionNote | undefined;
  /** The action asks for confirmation before it runs. */
  readonly confirm?: boolean | undefined;
  readonly when: (state: ObjectData) => MaybePromise<boolean>;
  readonly run: (ctx: ActionContext, args: unknown) => MaybePromise<void>;
}

/** The context an action receives. `runId` is set when it answers a person wait. */
export interface ActionContext extends PluginBaseContext {
  readonly runId: string | undefined;
  readonly object: RunObject;
  /** The note the person wrote, when the action asks for one. */
  readonly note?: string | undefined;
  /** Answers the run's current person wait; set when the action runs for a run. */
  readonly answer?: Answer | undefined;
}

/** Options for running an action through the registry. */
export interface ActionRunOptions {
  readonly object: RunObject | StoredObject;
  readonly runId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly note?: string | undefined;
}

/** A CLI verb a plugin declares. */
export interface CommandDefinition {
  readonly name: string;
  /** Usage text for the verb's arguments, such as `"<id> [--force]"`. */
  readonly args: string;
  readonly run: (
    ctx: CommandContext,
    argv: readonly string[],
  ) => MaybePromise<unknown>;
}

/** The context a command verb receives. */
export interface CommandContext extends PluginBaseContext {}

/** Options for running a command through the registry. */
export interface CommandRunOptions {
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Where a command resolved: always `<plugin> <verb>`, optionally `<verb>`. */
export interface ResolvedCommand {
  readonly plugin: string;
  readonly command: string;
  readonly argv: readonly string[];
}

/** A command that ran, with the value its plugin returned. */
export interface CommandRun extends ResolvedCommand {
  readonly value: unknown;
}

/** An action that ran, with the value its plugin returned. */
export interface ActionRun {
  readonly plugin: string;
  readonly action: string;
  readonly value: unknown;
}

/** Asks the kernel to start a run of one of the plugin's flows. */
export interface StartRunRequest {
  readonly plugin: string;
  readonly flow: string;
  readonly object?: ObjectRef | undefined;
  readonly params?: JsonValue | undefined;
  readonly trigger?: TriggerEvent | undefined;
  /** Internal: an event already recorded as a global input. */
  readonly inputId?: string | undefined;
}

/** What `ctx.start` accepts on a tick: a flow name, or a full request. */
export interface TickStartRequest {
  readonly flow: string;
  readonly params?: JsonValue | undefined;
  readonly object?: ObjectRef | string | undefined;
  readonly trigger?: TriggerEvent | undefined;
}

/** The context the kernel loop passes to a plugin's `onTick`. */
export interface TickContext extends PluginBaseContext {
  /** Starts a run of a flow this plugin declares. */
  start(
    flowOrRequest: string | TickStartRequest,
    object?: ObjectRef,
  ): Promise<void>;
}

/** A running source plugin. */
export interface SourceHandle {
  stop(): MaybePromise<void>;
}

/** The context a source plugin's `start` receives. */
export interface SourceContext extends PluginBaseContext {
  /** The routing rules, already checked. */
  readonly rules: readonly TriggerRule[];
  readonly clock: () => number;
  /** Sends one event through the kernel's rules. */
  emit(event: SourceEvent): Promise<void>;
}

/** The shape `definePlugin` accepts. The version is added by the helper. */
export interface PluginShape {
  readonly name: string;
  readonly kind: PluginKind;
  readonly version: string;
  readonly objects?: readonly ObjectTypeDefinition[] | undefined;
  readonly actions?: readonly ActionTypeDefinition[] | undefined;
  readonly steps?: readonly StepTypeDefinition[] | undefined;
  readonly flows?: readonly FlowDefinition[] | undefined;
  readonly commands?: readonly CommandDefinition[] | undefined;
  /** How each object type appears in a list and a detail page. */
  readonly views?: Readonly<Record<string, ObjectViews>> | undefined;
  /** Default key bindings, keyed by key, valued as `<plugin>:<action>`. */
  readonly keys?: KeyBindings | undefined;
  readonly onTick?: ((ctx: TickContext) => MaybePromise<void>) | undefined;
  /** Starts a source; `operad serve` stops it on exit. */
  readonly start?: ((ctx: SourceContext) => MaybePromise<SourceHandle> | SourceHandle) | undefined;
  /** Runs when `operad init` checks the plugin; a string is the check's note. */
  readonly check?: ((ctx: PluginBaseContext) => MaybePromise<string | void>) | undefined;
}

/** A plugin definition ready for the registry. */
export interface PluginDefinition extends PluginShape {
  readonly operadPlugin: typeof OPERAD_PLUGIN_VERSION;
}

/** A run waiting for a person. The kernel supplies these to the pending view. */
export interface WaitingRun {
  readonly runId: string;
  readonly object: ObjectRef;
  readonly prompt?: string | undefined;
  readonly choices?: readonly string[] | undefined;
}

/** One action the pending view offers for a waiting run. */
export interface PendingActionView {
  readonly plugin: string;
  readonly action: string;
}

/** An entry in the pending view: a waiting run, its object and its actions. */
export interface PendingEntry {
  readonly runId: string;
  readonly prompt: string | undefined;
  readonly choices: readonly string[] | undefined;
  readonly object: StoredObject;
  readonly actions: readonly PendingActionView[];
}
