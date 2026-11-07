import type { FlowDefinition } from "../flow/types.ts";
import type { KernelState } from "../kernel/types.ts";
import type { Secret } from "../log/secret.ts";
import type { JsonValue, RunInfo } from "../log/types.ts";
import type {
  SourceEvent,
  StepEvent,
  TriggerEvent,
  TriggerRule,
  TriggerView,
} from "../trigger/types.ts";

/** The plugin API version a module declares with `operadPlugin`. */
export const OPERAD_PLUGIN_VERSION = 1 as const;

/** The plugin API version as a semver version, for `requires.api`. */
export const PLUGIN_API_VERSION = `${OPERAD_PLUGIN_VERSION}.0.0` as const;

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

/** Who a person input came from. `via` is a client such as `cli` or `ios`. */
export interface Actor {
  readonly via: string;
  readonly id: string;
}

/** One line of a list: what the plugin shows for an object. */
export interface ObjectRow {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  /** A short tail for the row, such as a cost or a duration. */
  readonly note?: string | undefined;
  /**
   * The namespace the id is unique in, such as a repository. A list shows it
   * only when the type's `showScope` says so.
   */
  readonly scope?: string | undefined;
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

/**
 * An access profile: opaque JSON the kernel hands to steps. Its shape belongs
 * to `operad-sandbox.md`, not to the kernel.
 */
export type AccessProfile = Readonly<Record<string, JsonValue>>;

/** A plugin's secrets, scoped to that plugin and stored outside the log. */
export interface SecretStore {
  get(name: string): Promise<Secret<string> | undefined>;
  set(name: string, value: string | Secret<string>): Promise<void>;
  delete(name: string): Promise<void>;
  names(): Promise<readonly string[]>;
}

/** How one object type appears to every client. */
export interface ObjectViews {
  /** Must be pure and fast: it reads the stored object and nothing else. */
  readonly row: (object: StoredObject) => ObjectRow;
  /** The section directory only; it reads no section content. */
  readonly sections: (object: StoredObject) => readonly ViewSection[];
  /**
   * Whether a list shows each row's `scope` next to its id, because more than
   * one namespace exists. Read once per list.
   */
  readonly showScope?: ((ctx: ViewContext) => MaybePromise<boolean>) | undefined;
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
 * Options for reading one page of objects. `where` holds equality filters on
 * fields the object type declared in `index`; `cursor` continues a page.
 */
export interface ListOptions {
  readonly where?: Readonly<Record<string, unknown>> | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  /** The fields `where` may name. The store normally learns them from `declare`. */
  readonly index?: readonly string[] | undefined;
}

/** One page of objects, ordered by id, and where to continue. */
export interface ListPage {
  readonly objects: readonly StoredObject[];
  readonly next?: string | undefined;
}

/** Options for reading one object's facts. */
export interface FactsOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One page of an object's facts in sequence order, and where to continue. */
export interface FactsPage {
  readonly facts: readonly PluginFact[];
  readonly next?: string | undefined;
}

/**
 * The object side of the store. A plugin reads and writes objects here and
 * never touches the storage backend.
 */
export interface ObjectStore {
  /** The directory that holds this store's files, such as logs. */
  readonly root: string;

  /** Tells the store which fields a type allows `where` to filter on. */
  declare?(type: string, index: readonly string[]): void;

  /**
   * Tells a listener whenever an object gains a fact. Optional: a store that
   * cannot watch simply returns a no-op unsubscribe. With an object and a
   * cursor, the same call subscribes to that object's facts instead.
   */
  subscribe(listener: (object: ObjectRef) => void): () => void;
  subscribe(
    object: ObjectRef,
    options: FactsOptions,
    listener: (fact: PluginFact) => void,
  ): () => void;

  /** Every fact in append order, when this store keeps them in memory. */
  facts(): readonly PluginFact[];

  /** One page of one object's facts in sequence order. */
  facts(object: ObjectRef, options?: FactsOptions): FactsPage;

  /**
   * Calls `listener` for facts of `object` after `options.cursor`; without a
   * cursor, only facts appended after the subscription starts.
   */
  subscribeFacts?(
    object: ObjectRef,
    options: FactsOptions,
    listener: (fact: PluginFact) => void,
  ): () => void;

  /** Stores a new version of an object and appends the change as a fact. */
  put(
    type: string,
    id: string,
    data: ObjectData,
    cause: string,
  ): MaybePromise<StoredObject>;

  get(type: string, id: string): MaybePromise<StoredObject | undefined>;

  /** One page of objects of `type`, ordered by id and filtered by `where`. */
  list(type: string, options?: ListOptions): MaybePromise<ListPage>;
}

/** Appends facts that are not an object change, such as a step's output path. */
export interface FactWriter {
  append(input: FactInput): MaybePromise<PluginFact>;
}

/** A fact as a store takes it: the cause is always known by then. */
export interface StoreFactInput extends FactInput {
  readonly cause: string;
}

/** How a worker reopens the store its run uses. */
export interface PluginStoreLocation {
  readonly backend: "jsonl" | "sqlite";
  readonly root: string;
  /** The SQLite file, when the backend keeps one file. */
  readonly file?: string | undefined;
}

/** The store a plugin sees: objects plus its own facts. */
export interface PluginStore extends ObjectStore {
  /** Appends a fact; the caller names its cause (the kernel fills it for plugins). */
  append(input: StoreFactInput): MaybePromise<PluginFact>;

  /**
   * `file` stores live under one directory and a worker step sees the same
   * data; `memory` stores exist only in this process.
   */
  readonly kind: "file" | "memory";

  /** How a worker opens the same store; absent for an in-memory store. */
  readonly location?: PluginStoreLocation | undefined;
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
  /** The plugin's validated `config.json` section, with defaults filled. */
  readonly settings: Readonly<Record<string, JsonValue>>;
  /** The plugin's own secrets: never stored in the log. */
  readonly secrets: SecretStore;
  /** Set when the kernel can cancel a run for this plugin. */
  readonly runs?: RunControl | undefined;
}

/** The answer a plugin action gives to the person wait it is answering. */
export type Answer = (choice: string, note?: string) => MaybePromise<void>;

/** What a plugin may ask the kernel to do with a run it owns. */
export interface RunControl {
  /** Cancels a run through the kernel; an ended run is left alone. */
  cancel(runId: string): MaybePromise<void>;
}

/** The result of one plugin's optional `check`. */
export interface PluginCheck {
  readonly plugin: string;
  readonly ok: boolean;
  readonly message: string;
}

/** What a step asks a person with `ctx.ask`. */
export interface AskRequest {
  readonly prompt: string;
  /** The answers offered; none means a free note only. */
  readonly choices?: readonly string[] | undefined;
  /**
   * How long to wait for the answer, in seconds, while the step goes on
   * waiting. The narrowest of this, the step's `askGraceSecs` param and the
   * `ask.graceSecs` setting counts. `0` does not wait.
   */
  readonly graceSecs?: number | undefined;
  /**
   * What happens when the grace passes without an answer. `"waiting"` (the
   * default) ends the step with the result `waiting`; `"reject_once"` returns
   * to the step with `rejected: true`.
   */
  readonly onTimeout?: "waiting" | "reject_once" | undefined;
  /** What the step needs to carry on later; handed back in the `waiting` data. */
  readonly resume?: JsonValue | undefined;
}

/** The answer `ctx.ask` returns. */
export interface AskAnswer {
  readonly choice: string | undefined;
  readonly note?: string | undefined;
  /** Who answered; absent when `rejected`. */
  readonly actor?: Actor | undefined;
  /** True when the grace passed and `onTimeout` was `"reject_once"`. */
  readonly rejected?: boolean | undefined;
}

/** The data of a step that ended `waiting` because an ask timed out. */
export interface AskWaitingData {
  readonly waitId: string;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly resume: JsonValue;
}

/** The context a step run receives. */
export interface StepContext extends PluginBaseContext {
  readonly runId: string;
  readonly object: RunObject | undefined;
  /** Fixed JSON the flow was started with; null when it was given none. */
  readonly params: JsonValue;
  /** The run's access profile, opaque to the kernel; null when it has none. */
  readonly access: JsonValue;
  /** The event that started the run, with paths to its text. */
  readonly trigger: TriggerView | undefined;
  /** Sends an event; the type must begin with this plugin's name. */
  emit(event: StepEvent): Promise<void>;
  /**
   * Asks a person and waits for the answer while the step lives. Only steps
   * have it; a flow cannot ask. When the grace passes, `onTimeout` decides.
   */
  ask(request: AskRequest): Promise<AskAnswer>;
  /**
   * Runs another loaded step in this run. The kernel offers it when a plugin
   * step delegates to a harness or another plugin; a direct call to a step's
   * `run` has no host and leaves it undefined.
   */
  readonly runStep?:
    | ((
        use: string,
        params: unknown,
        options: StepRunOptions,
      ) => MaybePromise<PluginStepResult>)
    | undefined;
}

/** What a step returns. `result` must be one of the step type's results. */
export interface PluginStepResult {
  readonly result: string;
  readonly data?: ObjectData | undefined;
}

/**
 * Where a step type's concurrency is limited. `key` names what is shared (a
 * model, an account); `undefined` means this call is not limited. `concurrent`
 * is how many calls under one key may run at once across the operad home.
 */
export interface StepLimitDefinition {
  readonly key: (
    params: unknown,
    settings: Readonly<Record<string, JsonValue>>,
  ) => string | undefined;
  readonly concurrent: (
    params: unknown,
    settings: Readonly<Record<string, JsonValue>>,
  ) => number;
}

/** A held place under a limit key; `release` gives it back. */
export interface StepLimitRequest {
  readonly use: string;
  readonly key: string;
  readonly concurrent: number;
  readonly signal?: AbortSignal | undefined;
}

/** Hands out places under limit keys to steps a step starts with `runStep`. */
export interface StepLimiter {
  acquire(request: StepLimitRequest): Promise<() => Promise<void>>;
}

/** Options for running a step through the registry. */
export interface StepRunOptions {
  readonly runId: string;
  /** Limits the steps this step starts through `ctx.runStep`. */
  readonly limits?: StepLimiter | undefined;
  readonly object?: RunObject | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly params?: JsonValue | undefined;
  /** The run's access profile; the kernel only checks who enforces it. */
  readonly access?: JsonValue | undefined;
  readonly trigger?: TriggerView | undefined;
  /** Sends a step event; the plugin is the one that registered the step. */
  readonly emit?:
    | ((plugin: string, event: StepEvent) => MaybePromise<void>)
    | undefined;
}

/** A step type a plugin declares. The use name is `<plugin>/<name>`. */
export interface StepTypeDefinition {
  readonly name: string;
  readonly results: readonly string[];
  /** Access profile fields this step applies, such as `denyPaths`. */
  readonly enforces?: readonly string[] | undefined;
  /**
   * How long one run of this step may take, in seconds. Default: the runner's
   * step timeout (5 minutes). A step that runs an agent or a test suite sets
   * it above its own limits.
   */
  readonly timeoutSecs?: number | undefined;
  /** Limits how many runs of this step may be going at once. */
  readonly limit?: StepLimitDefinition | undefined;
  readonly run: (
    ctx: StepContext,
    params: unknown,
  ) => MaybePromise<PluginStepResult>;
}

/** What an object type's `resolve` receives. `cwd` is where the person is. */
export interface ObjectResolveContext {
  readonly cwd: string;
  /** A namespace the person named explicitly (`--repo <name>`), when they did. */
  readonly scope?: string | undefined;
  readonly store: ObjectStore;
}

/** An object type a plugin owns, such as `task`. */
export interface ObjectTypeDefinition {
  readonly name: string;
  readonly schema?: unknown;
  /**
   * Turns a bare id into the object's store key, or undefined when this type
   * does not claim it. The kernel asks this before its own suffix lookup, so a
   * plugin can scope an id to a repository or another namespace.
   */
  readonly resolve?: (
    ctx: ObjectResolveContext,
    type: string,
    id: string,
  ) => MaybePromise<string | undefined>;
  /** The fields a person may filter on with `list(..., { where })`. */
  readonly index?: readonly string[] | undefined;
}

/** The value types an action argument may have. */
export type ActionArgType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object";

/**
 * One property of an action's arguments. It is the JSON Schema subset the
 * kernel validates: `type`, `enum`, `minimum`, `maximum`, `minLength`,
 * `maxLength`, `items`, `properties`, `required`, `additionalProperties` (`false` or a schema for the other fields),
 * `description` and `role`.
 */
export interface ActionArgSchema {
  readonly type?: ActionArgType | undefined;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly items?: ActionArgSchema | undefined;
  readonly properties?: Readonly<Record<string, ActionArgSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly additionalProperties?: false | ActionArgSchema | undefined;
  /** A value the kernel fills when the field is absent. */
  readonly default?: unknown;
  readonly description?: string | undefined;
  /** A note is prompted for in a terminal and accepted as `--note`. */
  readonly role?: "note" | undefined;
}

/** The arguments of an action: a JSON Schema object. */
export interface ActionArgsSchema extends ActionArgSchema {
  readonly type: "object";
}

/** An action a plugin offers on an object type. */
export interface ActionTypeDefinition {
  readonly name: string;
  readonly on: string;
  /** The person's input, as a JSON Schema object. */
  readonly args?: ActionArgsSchema | undefined;
  /** The action asks for confirmation before it runs. */
  readonly confirm?: boolean | undefined;
  readonly when: (state: ObjectData) => MaybePromise<boolean>;
  /**
   * Why `when` refuses this object, in one line that starts with the object's
   * own name. A client prints it when the action is not available.
   */
  readonly why?:
    | ((object: StoredObject) => string | undefined)
    | undefined;
  readonly run: (ctx: ActionContext, args: unknown) => MaybePromise<unknown>;
}

/** The context an action receives. `runId` is set when it answers a person wait. */
export interface ActionContext extends PluginBaseContext {
  readonly runId: string | undefined;
  readonly object: RunObject;
  /** Who asked for the action: a person through a client. */
  readonly actor: Actor;
  /** Answers the run's current person wait; set when the action runs for a run. */
  readonly answer?: Answer | undefined;
}

/** Options for running an action through the registry. */
export interface ActionRunOptions {
  readonly object: RunObject | StoredObject;
  readonly runId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly args?: unknown;
  readonly actor: Actor;
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
  /** The access profile the run starts with, opaque to the kernel. */
  readonly access?: JsonValue | undefined;
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
  /** The access profile the run starts with, opaque to the kernel. */
  readonly access?: JsonValue | undefined;
}

/**
 * What a plugin may ask the kernel about runs while it ticks. `serve` supplies
 * it; a registry used on its own leaves it undefined.
 */
export interface RunLookup {
  /** The active runs, optionally only those on one object key. */
  active(object?: string): Promise<readonly RunInfo[]>;
  /** The state a run's log derives, or undefined when it cannot be read. */
  state(runId: string): Promise<KernelState | undefined>;
  /** The last step a run entered, so a repair can name it. */
  lastStep(runId: string): Promise<string | null>;
}

/** The context the kernel loop passes to a plugin's `onTick`. */
export interface TickContext extends PluginBaseContext {
  /** Starts a run of a flow this plugin declares. */
  start(
    flowOrRequest: string | TickStartRequest,
    object?: ObjectRef,
    access?: JsonValue,
  ): Promise<void>;
  /**
   * Answers the current person wait of a run this plugin owns. The kernel's
   * configured answer handler records the answer; a run that no longer waits
   * rejects with a `StateError`.
   */
  answer(runId: string, choice: string, note?: string): Promise<void>;
  /** What the kernel knows about runs, when the loop supplies it. */
  readonly runLookup?: RunLookup | undefined;
}

/** A plugin's declared dependencies: plugins and the plugin API version. */
export interface PluginRequires {
  readonly plugins?: Readonly<Record<string, string>> | undefined;
  readonly api?: string | undefined;
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
  /**
   * Default trigger rules this plugin ships. A user rule with the same source
   * and type replaces every plugin rule for that pair.
   */
  readonly rules?: readonly TriggerRule[] | undefined;
  readonly onTick?: ((ctx: TickContext) => MaybePromise<void>) | undefined;
  /** The JSON Schema of this plugin's `config.json` settings section. */
  readonly settings?: ActionArgsSchema | undefined;
  /** Access profile fields this plugin's steps apply. */
  readonly enforces?: readonly string[] | undefined;
  /** What this plugin needs loaded before it can be used. */
  readonly requires?: PluginRequires | undefined;
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
  /**
   * When the run last recorded anything. A run whose object is not in the store
   * takes this as the time of its placeholder object, so an age shown for it
   * is the run's own.
   */
  readonly lastFactAt?: number | undefined;
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
