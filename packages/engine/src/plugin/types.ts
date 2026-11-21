import type { ClientApi } from "../views/presentation.ts";
import type { ActionInfo } from "./registry.ts";
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

/** The semantic marks a row may carry; clients draw one icon per value. */
export const ROW_MARKS = [
  "todo",
  "blocked",
  "retry_wait",
  "paused",
  "proposed",
  "starting",
  "running",
  "reconciling",
  "checking",
  "rework_pending",
  "waiting",
  "integrating",
  "ready_to_merge",
  "done",
  "failed",
  "cancelled",
  "broken",
] as const;

/** One of the values in `ROW_MARKS`. */
export type RowMark = (typeof ROW_MARKS)[number];

/** The longest `badge` a row may carry, in characters. */
export const ROW_BADGE_MAX = 16;

/** One line of a list: what the plugin shows for an object. */
export interface ObjectRow {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  /** A short tail for the row, such as a cost or a duration. */
  readonly note?: string | undefined;
  /**
   * Why the object waits, as one text, separate from `note` so a client need
   * not split the note. A protocol field; absent when nothing is waited for.
   */
  readonly wait?: string | undefined;
  /**
   * The namespace the id is unique in, such as a repository. A list shows it
   * only when the type's `showScope` says so.
   */
  readonly scope?: string | undefined;
  /**
   * Whether `state` is final for the type: the object will not move on. A
   * client that reports ends reads this and no state name.
   */
  readonly final?: boolean | undefined;
  /** What the object is doing, as one of `ROW_MARKS`; clients choose the icon. */
  readonly mark?: RowMark | undefined;
  /** A short single-line text clients show after the state, such as `#2`. */
  readonly badge?: string | undefined;
  /**
   * The object one level up: a full object id (`type:id`) or a bare id that
   * resolves the way `get` resolves it. The kernel passes it through untouched
   * and never invents one.
   */
  readonly parent?: string | undefined;
  /**
   * The siblings (same `parent`) this object waits for, as row ids. The kernel
   * passes it through untouched; clients draw it.
   */
  readonly after?: readonly string[] | undefined;
  /**
   * The object waits for a person although no run does, as a proposed task
   * does. The row is drawn waiting, like one with a run waiting.
   */
  readonly waiting?: boolean | undefined;
  /**
   * Structured data the plugin defines for its clients, passed through
   * unchanged. The kernel reads no field of it; a client that does not know
   * a plugin's shape ignores it.
   */
  readonly data?: Readonly<Record<string, JsonValue>> | undefined;
}

/** One section a detail page offers. `live` means its content still grows. */
export interface ViewSection {
  readonly id: string;
  readonly title: string;
  readonly live?: boolean | undefined;
}

/** Where a section read starts; the plugin owns the meaning of the values. */
export interface SectionReadOptions {
  readonly cursor?: string | undefined;
  /**
   * Return only the finished content after this mark, a position an earlier
   * read returned. The plugin owns the meaning of the value; a plugin that
   * does not implement it answers with the whole section and leaves `delta` out.
   */
  readonly after?: string | undefined;
  /** The read asked to skip the size cap, so the plugin may leave its data whole. */
  readonly full?: boolean | undefined;
}

/** What a live section says it is doing, and since when. */
export interface SectionStatus {
  readonly text: string;
  /** When the state named by `text` began, in milliseconds since the epoch. */
  readonly since: number;
}

/** A model request a harness waits to try again, with when the next attempt starts. */
export interface SectionRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  /** When the next attempt starts, in milliseconds since the epoch. */
  readonly until: number;
  /** The provider's message that caused the retry. */
  readonly reason: string;
}

/** The Markdown of one section, and where to continue when it is paged. */
export interface SectionContent {
  readonly markdown: string;
  readonly next?: string | undefined;
  /** A table of contents: one entry per page; the first page's cursor is absent. */
  readonly pages?: readonly SectionPage[] | undefined;
  /**
   * An opaque position the finished content goes to; a client passes it back
   * as `after`. The plugin owns its meaning.
   */
  readonly mark?: string | undefined;
  /**
   * The part that is still changing, as Markdown: always its whole current
   * text, not only what changed since the last read.
   */
  readonly tail?: string | undefined;
  /**
   * What the live section is doing now; the kernel passes it through and
   * never reads it. A client that does not know it ignores it.
   */
  readonly status?: SectionStatus | undefined;
  /**
   * A model request the harness is waiting to try again. The kernel passes it
   * through on every read; a client that does not know it ignores it.
   */
  readonly retry?: SectionRetry | undefined;
  /**
   * Numbers a client shows beside the section, such as how full an agent's
   * context is. The kernel passes it through on every read; a client that
   * does not know it ignores it.
   */
  readonly context?:
    | {
        readonly used: number;
        readonly window?: number | undefined;
        readonly model?: string | undefined;
      }
    | undefined;
  /**
   * Structured data the plugin defines for its clients, passed through
   * unchanged on every read. A client that does not know a plugin's shape
   * ignores it.
   */
  readonly data?: Readonly<Record<string, JsonValue>> | undefined;
  /**
   * `markdown` holds only what follows the requested `after`. Omit, or set
   * false, when the answer is a whole page; the kernel then tells the client
   * to replace instead of appending.
   */
  readonly delta?: boolean | undefined;
}

/** One page of a long section, as the section API takes it. */
export interface SectionPage {
  readonly label: string;
  readonly cursor?: string | undefined;
}

/** The context a `load` call receives. */
export interface ViewContext extends PluginBaseContext {
  /**
   * A run's own times from its facts: when it started and ended, and its
   * steps and waits for a person in order, each with when it began and ended.
   * Undefined for a run the log does not know. Absent when the kernel has no
   * run log to read.
   */
  readonly runTimes?:
    | ((runId: string) => Promise<
        | {
            readonly startedAt: number;
            readonly endedAt: number | null;
            readonly segments: readonly {
              readonly step: string;
              readonly person: boolean;
              readonly from: number;
              readonly to: number | null;
            }[];
          }
        | undefined
      >)
    | undefined;
  /**
   * A plugin's settings as they are in `config.json` now, with defaults
   * filled; the registry's settings when the file cannot be read. For a view
   * that must follow an edit without a restart.
   */
  readonly settingsInForce?:
    | ((plugin: string) => Readonly<Record<string, JsonValue>>)
    | undefined;
  /**
   * The most bytes a section read may return when the client did not ask for
   * `full`: Markdown, the tail and the plugin's data together. A plugin that
   * carries data cuts its own parts before the kernel shortens Markdown.
   */
  readonly sectionCapBytes: number;
  /**
   * An object after its type's `prepare` has run with the settings in force
   * now, so a view can see a change without a restart. Undefined when the
   * object is gone.
   */
  readonly refreshedObject?:
    | ((type: string, id: string) => Promise<StoredObject | undefined>)
    | undefined;
}

/**
 * An access profile: opaque JSON the kernel hands to steps. Its shape belongs
 * to ADR 0025, not to the kernel.
 */
export type AccessProfile = Readonly<Record<string, JsonValue>>;

/** A plugin's secrets, scoped to that plugin and stored outside the log. */
export interface SecretStore {
  get(name: string): Promise<Secret<string> | undefined>;
  set(name: string, value: string | Secret<string>): Promise<void>;
  delete(name: string): Promise<void>;
  names(): Promise<readonly string[]>;
  /** Every value, from one read of the store, so masking costs one file read. */
  values(): Promise<readonly string[]>;
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
  /**
   * Numbers a detail page shows beside its row, such as how full an agent's
   * context is. It may read facts and may be slow; the kernel passes it
   * through and reads no meaning into it. Absent when the type has none.
   */
  readonly context?:
    | ((
        ctx: ViewContext,
        object: StoredObject,
      ) => MaybePromise<
        | {
            readonly used: number;
            readonly window?: number | undefined;
            readonly model?: string | undefined;
          }
        | undefined
      >)
    | undefined;
  /**
   * The skills an object offers as `/name` commands, such as a chat's. The
   * kernel passes it through and reads no meaning into it. Absent when the
   * type has none.
   */
  readonly skills?:
    | ((
        ctx: ViewContext,
        object: StoredObject,
      ) => MaybePromise<readonly ViewSkill[] | undefined>)
    | undefined;
  /**
   * Whether a file below the object's attachment directory may be served: a
   * path the object's own records name, never one a client chose. The kernel
   * passes the path segments after the type and id, already decoded. A type
   * that declares it serves only what it allows; a type without it keeps the
   * kernel's attachment-directory bounds, as before.
   */
  readonly file?:
    | ((
        ctx: ViewContext,
        object: StoredObject,
        path: readonly string[],
      ) => MaybePromise<boolean>)
    | undefined;
  /**
   * The changing part of a live section, pushed on the event stream as it
   * grows. The kernel passes `section`, `tail`, `status` and `data` through
   * without reading them, in the same shapes a section read uses. Absent: the
   * type pushes no live part and an event carries only the object id.
   */
  readonly tail?:
    | ((
        ctx: ViewContext,
        object: StoredObject,
      ) => MaybePromise<
        | {
            readonly section: string;
            readonly tail?: string | undefined;
            readonly status?: SectionStatus | undefined;
            readonly retry?: SectionRetry | undefined;
            readonly data?: Readonly<Record<string, JsonValue>> | undefined;
          }
        | undefined
      >)
    | undefined;
  /** Called when a person opens a section; it may be slow and paged. */
  readonly load: (
    ctx: ViewContext,
    object: StoredObject,
    sectionId: string,
    options: SectionReadOptions,
  ) => MaybePromise<SectionContent>;
}

/** A skill an object offers as a `/name` command: its name and what it does. */
export interface ViewSkill {
  readonly name: string;
  /** The description from its `SKILL.md`, cut to what a menu shows. */
  readonly description?: string | undefined;
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
   * The sequence of the object's latest fact, or 0 when it has none. A cheap
   * revision for a reader that need not read the facts themselves.
   */
  latestFactSequence?(object: ObjectRef): number;

  /** The distinct object types that have facts under this object id, sorted. */
  objectTypesOf(id: string): readonly string[];

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
  readonly backend: "sqlite";
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
  /**
   * Cancels a run through the kernel; an ended run is left alone. True when
   * this cancelled an active run, so a plugin can tell it from a run that had
   * already ended; a host that does not report says nothing.
   */
  cancel(runId: string, flow?: FlowDefinition): MaybePromise<boolean | void>;
  /**
   * Whether the run still exists and has not ended. Undefined when the host
   * cannot tell. A status view uses it to stop calling a crashed run writing.
   */
  active(runId: string): MaybePromise<boolean | void>;
}

/** The result of one plugin's optional `check`. */
export interface PluginCheck {
  readonly plugin: string;
  readonly ok: boolean;
  readonly message: string;
}

/** The longest grace, in seconds, a timer can hold (2^31-1 ms, rounded down). */
export const MAX_ASK_GRACE_SECS = 2_147_483;

/** What one choice of a question says about itself. */
export interface ChoiceInfo {
  /** What a client shows instead of the raw choice. */
  readonly label?: string | undefined;
  /** One sentence saying what choosing this does. */
  readonly hint?: string | undefined;
  /** The asker recommends `primary`; `destructive` cannot be undone. */
  readonly role?: "primary" | "destructive" | undefined;
  /** Whether the answer may or must carry a note. */
  readonly note?: "optional" | "required" | undefined;
}

/** One answer a form's question offers. */
export interface AskQuestionChoice {
  /** What a client shows and what an answer names. */
  readonly label: string;
  /** One sentence saying what choosing this means. */
  readonly description?: string | undefined;
}

/**
 * One question of a form a step asks a person: the agent's own question, with
 * its choices, carried through the kernel unchanged.
 */
export interface AskQuestion {
  /** What an answer names this question by; unique within the form. */
  readonly id: string;
  /** The question in full, as the agent asked it; for a plan review, its title. */
  readonly text: string;
  /**
   * Long Markdown the question asks about, when its text alone cannot hold it:
   * a plan review carries the plan here. Clients show it as written.
   */
  readonly body?: string | undefined;
  /** A short label a client shows beside the question. */
  readonly header?: string | undefined;
  /** The answers offered; absent or empty means free text only. */
  readonly choices?: readonly AskQuestionChoice[] | undefined;
  /** True when the person may pick more than one choice. */
  readonly multiple?: boolean | undefined;
  /** True when the person may answer in their own words. */
  readonly freeText?: boolean | undefined;
}

/** The person's answer to one question of a form. */
export interface AskQuestionAnswer {
  /** The question this answers; one of the form's ids. */
  readonly id: string;
  /** The labels picked, in the form's order. */
  readonly choices?: readonly string[] | undefined;
  /** What the person typed, instead of or beside a choice. */
  readonly text?: string | undefined;
  /** True when the person gave no answer to this question. */
  readonly skipped?: true | undefined;
}

/** What a question says when it is checked again while it waits. */
export interface AskRecheck {
  /** False when this question no longer needs a person. */
  readonly ask: boolean;
  /** Why it was let through, shown in history; the level's own title for a level change. */
  readonly note?: string | undefined;
  /** Who changed what lifted the question, when one person did. */
  readonly actor?: Actor | undefined;
}

/** What a step asks a person with `ctx.ask`. */
export interface AskRequest {
  readonly prompt: string;
  /** The answers offered; none means a free note only. */
  readonly choices?: readonly string[] | undefined;
  /**
   * What each choice is, keyed by the choice string an answer sends. The keys
   * must be choices; at most one is `primary`. The kernel checks it and carries
   * it to every read of the question.
   */
  readonly choiceInfo?: Readonly<Record<string, ChoiceInfo>> | undefined;
  /**
   * The form the person fills in, when the agent asked questions rather than
   * for one answer. A form has no `choices` of its own: the kernel shows one
   * question's labels to a client that cannot draw a form.
   */
  readonly questions?: readonly AskQuestion[] | undefined;
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
  /**
   * Whether the question still needs a person. The host checks it while the
   * question waits; when it says no, the question is answered `allow_once` with
   * its note and actor. A level change uses this so a question it made
   * unnecessary does not stay open.
   */
  readonly recheck?: (() => MaybePromise<AskRecheck>) | undefined;
}

/** The answer `ctx.ask` returns. */
export interface AskAnswer {
  readonly choice: string | undefined;
  readonly note?: string | undefined;
  /** Who answered; absent when `rejected`. */
  readonly actor?: Actor | undefined;
  /** True when the grace passed and `onTimeout` was `"reject_once"`. */
  readonly rejected?: boolean | undefined;
  /**
   * The person's answer to each question of a form, in the form's order, with
   * `skipped` for one they left alone. Absent for a question that is not a form.
   */
  readonly answers?: readonly AskQuestionAnswer[] | undefined;
}

/** The data of a step that ended `waiting` because an ask timed out. */
export interface AskWaitingData {
  readonly waitId: string;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly choiceInfo?: Readonly<Record<string, ChoiceInfo>> | undefined;
  /** The form the step asked, when it asked one. */
  readonly questions?: readonly AskQuestion[] | undefined;
  readonly resume: JsonValue;
}

/** What the host reports back for one question a step asked. */
export type AskOutcome =
  | { readonly kind: "answered"; readonly answer: AskAnswer }
  | {
      readonly kind: "timeout";
      readonly waitId: string;
      readonly prompt: string;
      readonly choices: readonly string[];
      readonly choiceInfo?: Readonly<Record<string, ChoiceInfo>> | undefined;
      /** The form the step asked, when it asked one. */
      readonly questions?: readonly AskQuestion[] | undefined;
      /** What the step needs to carry on later, when the asker shaped it; the request's own resume otherwise. */
      readonly resume?: JsonValue | undefined;
    };

/**
 * Where a step's questions go. `request.graceSecs` already holds the narrower of
 * the call and the step's `askGraceSecs`; the host narrows it by its own
 * setting.
 */
export interface StepAsker {
  ask(request: AskRequest, signal?: AbortSignal): Promise<AskOutcome>;
  /**
   * Uses up the one-time permission an answer gave. True when this call used
   * it; false when it was used before or the step has none by that id. The fact
   * that records the use is written before this returns.
   */
  useGrant(waitId: string): Promise<boolean>;
}

/** The context a step run receives. */
export interface StepContext extends PluginBaseContext {
  readonly runId: string;
  readonly object: RunObject | undefined;
  /** Fixed JSON the flow was started with; null when it was given none. */
  readonly params: JsonValue;
  /** The flow definition the run executes; absent in a direct step call with no flow. */
  readonly flow?: FlowDefinition | undefined;
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
   * Uses up the one-time permission an answer gave this step (see
   * `access.grants`). True when this call used it, false when it was already
   * used. Call it before the call the permission covers.
   */
  useGrant(waitId: string): Promise<boolean>;
  /** The caller's receiver of log lines, when it gave one; see `StepRunOptions.receiver`. */
  readonly receiver?: StepLineReceiver | undefined;
  /**
   * Tells the kernel this step waits for a place the plugin manages itself
   * (not a step limit), under `key`; the running view shows it queued. Call
   * the returned function when the wait is over. `ahead` is how many
   * waiters the plugin says are before this one in its own order; the running
   * view shows it instead of counting reports. To change it, end the wait and
   * report again. Undefined when the host has
   * no limiter.
   */
  readonly queued?:
    | ((key: string, ahead?: number) => Promise<() => Promise<void>>)
    | undefined;
  /** Whether a plugin that declares this step is loaded now. */
  readonly stepLoaded?: ((use: string) => boolean) | undefined;
  /** The models a loaded harness plugin declares; undefined when it is not loaded or declares none. */
  readonly harnessModels?: ((harness: string) => HarnessModels | undefined) | undefined;
  /**
   * The models a loaded harness plugin declares, waiting for one refresh when
   * the plugin has no kept list yet. Undefined when it is not loaded or declares none.
   */
  readonly harnessModelsReady?: ((harness: string) => Promise<HarnessModels | undefined>) | undefined;
  /** The efforts a loaded harness plugin declares; undefined when it is not loaded or declares none. */
  readonly harnessEfforts?: ((harness: string) => HarnessEfforts | undefined) | undefined;
  /** What a loaded harness plugin declares it can do; undefined when it is not loaded. */
  readonly harnessCapabilities?: ((harness: string) => HarnessCapabilities | undefined) | undefined;
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
  /**
   * Records that the step waits for a place that it manages itself, so the
   * running view shows the run queued under `key`. The returned function ends
   * the wait. The kernel grants nothing for it.
   */
  report(request: {
    readonly key: string;
    readonly ahead?: number | undefined;
  }): Promise<() => Promise<void>>;
}

/** Takes one log line of a step as it is written. */
export type StepLineReceiver = (line: string) => void;

/** Options for running a step through the registry. */
export interface StepRunOptions {
  readonly runId: string;
  /** Limits the steps this step starts through `ctx.runStep`. */
  readonly limits?: StepLimiter | undefined;
  /** Takes the questions the step asks with `ctx.ask`. */
  readonly asker?: StepAsker | undefined;
  /**
   * Takes each line a harness step writes to its log, as the text of the line.
   * Opaque to the kernel: only a harness step calls it, and only for the step
   * it is given to (a nested step does not inherit it).
   */
  readonly receiver?: StepLineReceiver | undefined;
  readonly object?: RunObject | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly params?: JsonValue | undefined;
  /** The flow definition the run executes, for a step that binds data to it. */
  readonly flow?: FlowDefinition | undefined;
  /** The run's access profile; the kernel only checks who enforces it. */
  readonly access?: JsonValue | undefined;
  readonly trigger?: TriggerView | undefined;
  /** Sends a step event; the plugin is the one that registered the step. */
  readonly emit?:
    | ((plugin: string, event: StepEvent) => MaybePromise<void>)
    | undefined;
  /** Sees each event this step sends, besides the destination; only the step it is given to. */
  readonly observe?:
    | ((plugin: string, event: StepEvent) => MaybePromise<void>)
    | undefined;
}

/** Where a plugin write goes outside operad: one call's target and its full content. */
export interface OutwardWrite {
  /** A message, mail or post; a repository push; a call to an outside service; or a shell command. */
  readonly kind: "channel" | "mail" | "post" | "repository" | "service" | "command";
  /** The target as a person reads it: a channel and conversation, an address, a remote and branch, a service, or a command. */
  readonly target: string;
  /** The full content the write carries, when the plugin can name it. */
  readonly content?: string | undefined;
  /** True when the target is one of the owner's own channels, which never ask. */
  readonly owner?: boolean | undefined;
}

/** The outward writes of one call, or none. */
export type OutwardWrites = OutwardWrite | readonly OutwardWrite[] | undefined;

/** Names the target of one call a step or action writes outward. */
export type OutwardTargets = (input: unknown) => OutwardWrites;

/** A step type a plugin declares. The use name is `<plugin>/<name>`. */
export interface StepTypeDefinition {
  readonly name: string;
  /**
   * True when the step can run again from where a question left it (it takes
   * `resumeSession` and `askAnswer` in its params). A step that says `false`
   * has every question it asks forced to `onTimeout: "reject_once"`.
   */
  readonly resumable?: boolean | undefined;
  /**
   * False when the step cannot let one call through and no other. `ctx.ask`
   * then refuses a question that offers a one-time permission, before anyone
   * is asked.
   */
  readonly grants?: boolean | undefined;
  readonly results: readonly string[];
  /**
   * The steps this one calls through `ctx.runStep`, as `plugin/step`. A run
   * does not start when one of them is not loaded.
   */
  readonly calls?: readonly string[] | undefined;
  /**
   * The step also calls steps that settings or an object name (a chat's
   * `refresh` step), so `calls` cannot list them. A run does not wait on them
   * to start; a call to one that is not loaded fails where it is made.
   */
  readonly callsNamedByData?: boolean | undefined;
  /** Access profile fields this step applies, such as `denyPaths`. */
  readonly enforces?: readonly string[] | undefined;
  /**
   * True when this step can write outside operad: send a message, mail or a
   * post, push, or call an outside service. `outward` names the target of one
   * call; an undeclared step that marks itself so counts as outward, with the
   * whole call as the target.
   */
  readonly reachesOutside?: boolean | undefined;
  readonly outward?: OutwardTargets | undefined;
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

/**
 * A named subset of a type's rows, by state. A row matches when its `state` is
 * in `states`. The kernel adds an implicit `all` filter; a plugin may not
 * declare that name.
 */
export interface ObjectFilterDefinition {
  readonly name: string;
  readonly states: readonly string[];
  /** At most one filter is the default; with none marked, the first is. */
  readonly default?: boolean | undefined;
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
  /**
   * Brings this type's stored objects up to date (for example after a rename)
   * before a client reads them. Views run it once per instance, before the
   * first list or get; it must be safe to run again.
   */
  readonly prepare?: (ctx: {
    readonly store: ObjectStore;
    readonly home: string;
    /** The owning plugin's validated settings. */
    readonly settings: Readonly<Record<string, JsonValue>>;
  }) => MaybePromise<void>;
  /**
   * Whether the plugin itself will answer this object's wait for a person
   * automatically. It runs each time the pending view is built and returns
   * what holds now, so a wait whose automatic answer is refused, or whose
   * auto level changes, stops being marked.
   */
  readonly answeredAutomatically?:
    | ((
        data: Record<string, unknown>,
        ctx: { readonly store: ObjectStore },
      ) => MaybePromise<boolean>)
    | undefined;
  /** The fields a person may filter on with `list(..., { where })`. */
  readonly index?: readonly string[] | undefined;
  /** Ordered row filters for lists; see {@link ObjectFilterDefinition}. */
  readonly filters?: readonly ObjectFilterDefinition[] | undefined;
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
 * `title`, `description` and `role`.
 */
export interface ActionArgSchema {
  /** A short name a client shows for this field. */
  readonly title?: string | undefined;
  readonly type?: ActionArgType | undefined;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly items?: ActionArgSchema | undefined;
  readonly minItems?: number | undefined;
  readonly exclusiveMinimum?: number | undefined;
  readonly exclusiveMaximum?: number | undefined;
  readonly minProperties?: number | undefined;
  /** A regular expression the string must match somewhere. */
  readonly pattern?: string | undefined;
  /** The one value allowed. */
  readonly const?: unknown;
  /** In a declaration: a reference `#/$defs/<name>`, replaced at load by what it names. */
  readonly $ref?: string | undefined;
  /** In a declaration's root: the schemas a `$ref` may name. */
  readonly $defs?: Readonly<Record<string, unknown>> | undefined;
  /** Exactly one of these must fit. A `$ref` is already replaced by what it names. */
  readonly oneOf?: readonly ActionArgSchema[] | undefined;
  /**
   * Conditionals a client reads to narrow a field by another (`if`/`then`, as
   * JSON Schema). Only an action's `argsFor` result carries them; the kernel
   * does not evaluate them when it validates the person's values.
   */
  readonly allOf?: readonly ActionArgSchema[] | undefined;
  readonly if?: ActionArgSchema | undefined;
  readonly then?: ActionArgSchema | undefined;
  readonly properties?: Readonly<Record<string, ActionArgSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly additionalProperties?: false | ActionArgSchema | undefined;
  /** A value the kernel fills when the field is absent. */
  readonly default?: unknown;
  /**
   * The value the field has now, for an action that changes an existing value.
   * A client shows it as the choice in effect; it is neither a default nor
   * read by the kernel.
   */
  readonly current?: unknown;
  readonly description?: string | undefined;
  /** A note is prompted for in a terminal and accepted as `--note`. */
  readonly role?: "note" | undefined;
  /**
   * `"file"`: the value is a file a client uploaded; the client passes the
   * upload's reference and the action runs with the stored path.
   */
  readonly format?: "file" | undefined;
  /**
   * In an action whose value is a model id: what each choice is, by id. The
   * kernel passes it through and does not read it.
   */
  readonly info?: Readonly<Record<string, HarnessModelInfo>> | undefined;
  /** In a settings schema: a client may change this setting. */
  readonly editable?: boolean | undefined;
  /** In a settings schema: changing it needs the person's confirmation. */
  readonly confirm?: boolean | undefined;
}

/** The arguments of an action: a JSON Schema object. */
export interface ActionArgsSchema extends ActionArgSchema {
  readonly type: "object";
}

/** What an action's checks may read: the object store, never write. */
export interface ActionEnv {
  readonly store: ObjectStore;
  /**
   * The object the action works on now, as its type and id, so a `when` can
   * read its facts with the store; absent for an action that targets no object.
   */
  readonly object?: ObjectRef | undefined;
  /** The operad home; an action's choices may be in its settings. */
  readonly home?: string | undefined;
  /** The harness plugins loaded now; the kernel always sets it. */
  readonly harnesses?: readonly string[] | undefined;
  /** The models each loaded harness plugin declares, by plugin name. */
  readonly models?: Readonly<Record<string, HarnessModels>> | undefined;
  /** The efforts each loaded harness plugin declares, by plugin name. */
  readonly efforts?: Readonly<Record<string, HarnessEfforts>> | undefined;
}

/** What a harness knows a model can do; only the ones it truly knows are listed. */
export type HarnessModelCapability = "vision" | "reasoning" | "tools" | "web";

/**
 * What a harness can say about one model. `id` is the string a chat stores;
 * a field the harness does not know is left out rather than guessed.
 */
export interface HarnessModelInfo {
  readonly id: string;
  /** A display name, when the harness has one. */
  readonly name?: string | undefined;
  /** The provider, such as `anthropic`, `openai` or `opencode-go`. */
  readonly provider?: string | undefined;
  /** The context window in tokens, when the harness knows it. */
  readonly window?: number | undefined;
  /** What the model can do, as far as the harness truly knows. */
  readonly capabilities?: readonly HarnessModelCapability[] | undefined;
}

/** The models a harness plugin declares: those a chat may pick, and the one used when none is set. */
export interface HarnessModels {
  /**
   * The model ids, or a description of each. A bare string works for a harness
   * that knows nothing more, so a client that reads only ids keeps working.
   */
  readonly list: readonly (string | HarnessModelInfo)[];
  readonly default: string | null;
  /**
   * The context window of each listed model the harness knows, in tokens.
   * A model with no entry has an unknown window; it is never guessed.
   */
  readonly windows?: Readonly<Record<string, number>> | undefined;
  /** What each listed model is, by id; a model with no entry is only an id. */
  readonly info?: Readonly<Record<string, HarnessModelInfo>> | undefined;
}

/** The model ids a declaration lists, in its order. */
export function modelIds(models: HarnessModels | undefined): readonly string[] {
  if (models === undefined) return [];
  return models.list.map((model) => (typeof model === "string" ? model : model.id));
}

/** What a harness's model hook may read besides its settings. */
export interface HarnessModelContext {
  /** The operad home: where a harness keeps the list it read. */
  readonly home: string;
  /** Where a background refresh reports a failure. */
  readonly log: (message: string) => void;
}

/**
 * The efforts a harness plugin declares: those a chat may pick, the one used
 * when none is set, and the step argument that sets it (`--effort` when absent).
 */
export interface HarnessEfforts {
  readonly list: readonly string[];
  readonly default: string | null;
  readonly flag?: string | undefined;
}

/**
 * The efforts a harness declares, or a function that reads them from the
 * plugin's settings each time they are asked for. A harness whose default
 * follows a setting of its own uses the function form.
 */
export type HarnessEffortsSource =
  | HarnessEfforts
  | ((settings: Readonly<Record<string, JsonValue>>) => HarnessEfforts);

/** What a harness plugin's agent does itself, from ADR 0022's capability list. */
export interface HarnessCapabilities {
  /**
   * The model this harness prefers for background work such as a memory tidy.
   * Left out: a bot uses its own model, else the harness's default model.
   */
  readonly backgroundModel?: string | undefined;
  /**
   * True when the agent loads the skill directories the step gives it, so the
   * prompt needs no list of them. False or absent: the harness does not load
   * skills by itself.
   */
  readonly loadsSkills?: boolean | undefined;
  /**
   * True when the agent takes a message while its run is going, after the tool
   * calls already running. False or absent: the run cannot take one, so a
   * message waits for the next run.
   */
  readonly takesMessagesMidRun?: boolean | undefined;
  /**
   * The access levels the agent can carry, as their ids (`plan`, `ask`,
   * `edits`, `full`). Absent or empty: the agent carries none, so a chat at a
   * level refuses the reply instead of ignoring the level.
   */
  readonly accessLevels?: readonly string[] | undefined;
}

/** An action a plugin offers on an object type, or without one. */
export interface ActionTypeDefinition {
  readonly name: string;
  /**
   * The object type the action works on. Absent when the action targets no
   * object: it runs from its arguments alone, as a client's POST /v1/act does.
   */
  readonly on?: string | undefined;
  /** The person's input, as a JSON Schema object. */
  readonly args?: ActionArgsSchema | undefined;
  /**
   * The person's input for this object right now, when it depends on what is
   * loaded; it is computed each time the action is offered and checked, and
   * replaces `args` (which stays the static form for help).
   */
  readonly argsFor?: ((object: RunObject, env: ActionEnv) => ActionArgsSchema) | undefined;
  /** The action asks for confirmation before it runs. */
  readonly confirm?: boolean | undefined;
  /**
   * True when this action can write outside operad; `outward` names the target
   * of one call. A background run asks before it runs when no target function
   * is declared.
   */
  readonly reachesOutside?: boolean | undefined;
  readonly outward?: OutwardTargets | undefined;
  /**
   * A one-line description when a chat may run this action as a `/<name>`
   * command; its presence is what makes the action a chat command. `true` takes
   * the description from the args schema's own `description`, else the action
   * name. Absent when the action cannot be typed after a slash.
   */
  readonly command?: boolean | string | undefined;
  /**
   * The action ends the object (a cancel). A client's main key or button never
   * picks it, even when it is the only action offered.
   */
  readonly ends?: boolean | undefined;
  /**
   * The object type the action creates (`"chat"`). A client keeps such an action
   * out of the parent's page and offers it where that type is created; it is
   * never an object's main action.
   */
  readonly creates?: string | undefined;
  readonly when: (state: ObjectData, env: ActionEnv) => MaybePromise<boolean>;
  /**
   * Where the action stands among the object's available actions: lower comes
   * first, equal ranks keep the plugin's order, none is 0. The first available
   * action is the main one (a client's main key or button), so a plugin ranks
   * what a person most likely wants next ahead of an action that ends the object.
   */
  readonly rank?: ((state: ObjectData) => number) | undefined;
  /**
   * Why `when` refuses this object, in one line that starts with the object's
   * own name and says when the action becomes possible. A client prints it
   * when the action is not available.
   */
  readonly why?:
    | ((object: StoredObject, env: ActionEnv) => MaybePromise<string | undefined>)
    | undefined;
  /**
   * The line to print when the action's result is already true (nothing to
   * do), or undefined. The action then succeeds with that line and does not
   * run; it is checked before `when`, with the arguments as the person sent them.
   */
  readonly settled?:
    | ((
        object: StoredObject,
        args: unknown,
        env: ActionEnv,
      ) => MaybePromise<string | undefined>)
    | undefined;
  /**
   * Returns the line to show, or an `ActionOutcome` when the action created an
   * object a client should open. Any other value is the result as it is.
   */
  readonly run: (ctx: ActionContext, args: unknown) => MaybePromise<unknown>;
}

/**
 * What an action returns when it created an object: the line of text a person
 * reads, and `opens`, the object as `type:id`. Returning only text still works.
 * The kernel, the client API and HTTP pass `opens` on unchanged.
 */
export interface ActionOutcome {
  readonly text: string;
  readonly opens: string;
}

/** Whether an action's return value is an `ActionOutcome`. */
export function isActionOutcome(value: unknown): value is ActionOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const record = value as { readonly text?: unknown; readonly opens?: unknown };
  return (
    keys.length === 2 &&
    typeof record.text === "string" &&
    typeof record.opens === "string"
  );
}

/** An event an action sends: the person's client is the source. */
export interface ActionEvent {
  /** Where it came from, such as `ios`; never `operad`. */
  readonly source: string;
  readonly type: string;
  /** Makes a repeat of the same event a no-op. */
  readonly key: string;
  /** The object it is about, as `<type>:<id>`. */
  readonly object?: string | undefined;
  readonly summary?: string | undefined;
  readonly data?: JsonValue | undefined;
}

/** The context an action receives. `runId` is set when it answers a person wait. */
export interface ActionContext extends PluginBaseContext {
  /** The names of the loaded plugins of kind `harness`. */
  readonly harnesses: readonly string[];
  /** The models each loaded harness plugin declares, by plugin name. */
  readonly models: Readonly<Record<string, HarnessModels>>;
  /** The efforts each loaded harness plugin declares, by plugin name. */
  readonly efforts: Readonly<Record<string, HarnessEfforts>>;
  /** Sends an event through the kernel's rules; set when the host can route events. */
  readonly emit?: ((event: ActionEvent) => Promise<void>) | undefined;
  /**
   * The actions declared on this object's type, for an action that forwards a
   * person's text to one of them (a chat command). Optional: a host that cannot
   * run actions leaves it out.
   */
  readonly actions?: readonly ActionInfo[] | undefined;
  /**
   * Runs another action on the same object with the checks a client's `act`
   * makes (`when`, the arguments, `confirm`); `yes` answers the confirmation.
   * Optional: set when the host can run actions.
   */
  readonly act?:
    | ((
        name: string,
        args: unknown,
        options?: { readonly yes?: boolean | undefined } | undefined,
      ) => Promise<ActionRun>)
    | undefined;
  readonly runId: string | undefined;
  readonly object: RunObject;
  /** Who asked for the action: a person through a client. */
  readonly actor: Actor;
  /** Answers the run's current person wait; set when the action runs for a run. */
  readonly answer?: Answer | undefined;
}

/** Options for running an action through the registry. */
export interface ActionRunOptions {
  /** The object the action is on; absent when the action targets no object. */
  readonly object?: RunObject | StoredObject | undefined;
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
export interface CommandContext extends PluginBaseContext {
  /** The text the command reads from stdin, when its caller supplied one. */
  readonly input?: string | undefined;
  /** Every loaded flow name, so a command can refuse one that cannot start. */
  readonly flows: readonly string[];
}

/** Options for running a command through the registry. */
export interface CommandRunOptions {
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** The text the command reads from stdin; absent means the real stdin. */
  readonly input?: string | undefined;
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
  /** The object the action created, as `type:id`, when it said so. */
  readonly opens?: string | undefined;
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
   * Adds a flow this plugin generated, so `start` can name it and a later
   * process that sees the same run gets the same graph. Declaring a name again
   * with the same definition is a no-op; a different definition under a name
   * already in use is refused.
   */
  declareFlow(flow: FlowDefinition): void;
  /**
   * Answers the current person wait of a run this plugin owns. The kernel's
   * configured answer handler records the answer; a run that no longer waits
   * rejects with a `StateError`.
   */
  answer(runId: string, choice: string, note?: string): Promise<void>;
  /** What the kernel knows about runs, when the loop supplies it. */
  readonly runLookup?: RunLookup | undefined;
  /** Set when the kernel can cancel a run for this plugin. */
  readonly runs?: RunControl | undefined;
  /** The names of the plugins this process loaded. */
  readonly loaded: readonly string[];
}

/** One thing a plugin asks a person to know about; it waits on no run. */
export interface StandingItem {
  /** Names the item within its plugin; the same id is the same item. */
  readonly id: string;
  /** What the person reads. */
  readonly prompt: string;
  /**
   * The object the item is about. The item then carries the actions of the
   * plugins whose `when` holds for it, and the object's row, like a waiting run.
   */
  readonly object?: ObjectRef | undefined;
  /** False keeps a channel from announcing the item; it is still pending. */
  readonly announce?: boolean | undefined;
  /** Other objects the item stands for, such as the proposed tasks of a draft plan. */
  readonly covers?: readonly ObjectRef[] | undefined;
}

/** The context a plugin's `standing` hook receives. */
export interface StandingContext extends PluginBaseContext {
  /** The names of the plugins this process loaded. */
  readonly loaded: readonly string[];
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
  /** The loaded harness plugin names, in load order. */
  readonly harnesses?: readonly string[] | undefined;
  /** What a loaded harness plugin declares it can do; undefined when it is not loaded. */
  readonly harnessCapabilities?:
    | ((harness: string) => HarnessCapabilities | undefined)
    | undefined;
  /** Sends one event through the kernel's rules. */
  emit(event: SourceEvent): Promise<void>;
  /**
   * The client API HTTP and the TUI use, the same object: `list`, `get`,
   * `section`, `events`, `act`, `pending` and `answer`. `act` and `answer`
   * need an actor.
   */
  readonly client: ClientApi;
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
  /**
   * Items for the pending view that wait on no run: a problem the plugin sees
   * and a person should act on. The hook runs each time the view is built and
   * returns the items that hold now, so an item disappears when it is fixed.
   */
  readonly standing?:
    | ((ctx: StandingContext) => MaybePromise<readonly StandingItem[]>)
    | undefined;
  /** The JSON Schema of this plugin's `config.json` settings section. */
  readonly settings?: ActionArgsSchema | undefined;
  /**
   * True when the plugin's objects belong under a client's settings view
   * instead of a tab of their own (a bot: its page is a bot's settings). A
   * client gives such a plugin no tab; the types listing marks each of its
   * types `settings: true`.
   */
  readonly objectsUnderSettings?: boolean | undefined;
  /** Settings files this plugin keeps under a registered repository's `.operad/`. */
  readonly projectSettings?: ProjectSettingsDeclaration | undefined;
  /**
   * A harness plugin: the models a chat may pick (empty list: none can be
   * chosen). A function is called with the plugin's settings each time the
   * list is read, so a harness can ask the agent itself.
   */
  readonly models?:
    | HarnessModels
    | ((
        settings: Readonly<Record<string, JsonValue>>,
        context: HarnessModelContext,
      ) => HarnessModels)
    | undefined;
  /**
   * A harness plugin: the models a chat may pick, waiting for one refresh when
   * no list is kept yet. The reply asks this before it refuses a stored model.
   */
  readonly modelsReady?:
    | ((
        settings: Readonly<Record<string, JsonValue>>,
        context: HarnessModelContext,
      ) => MaybePromise<HarnessModels>)
    | undefined;
  /** A harness plugin: the efforts a chat may pick (empty list: none can be chosen), or a function of its settings. */
  readonly efforts?: HarnessEffortsSource | undefined;
  /** A harness plugin: what its agent does itself. */
  readonly capabilities?: HarnessCapabilities | undefined;
  /**
   * A harness plugin: whether its agent is signed in now. `true` or `false`
   * when it can tell, `undefined` when it cannot; only that answer is exposed,
   * never a credential. A function is called with the plugin's settings each
   * time the answer is read.
   */
  readonly signedIn?:
    | ((settings: Readonly<Record<string, JsonValue>>) => MaybePromise<boolean | undefined>)
    | undefined;
  /** Access profile fields this plugin's steps apply. */
  readonly enforces?: readonly string[] | undefined;
  /** What this plugin needs loaded before it can be used. */
  readonly requires?: PluginRequires | undefined;
  /** Starts a source; `operad serve` stops it on exit. */
  readonly start?: ((ctx: SourceContext) => MaybePromise<SourceHandle> | SourceHandle) | undefined;
  /** Runs when `operad init` checks the plugin; a string is the check's note. */
  readonly check?: ((ctx: PluginBaseContext) => MaybePromise<string | void>) | undefined;
}

/** One settings file under a repository's `.operad/`, with its schema. */
export interface ProjectSettingsFile {
  /**
   * The file's name in a setting's qualified name: `<plugin>.<name>.<path>`,
   * or `<plugin>.<path>` when the name equals the plugin's name.
   */
  readonly name: string;
  /** Where the file is, relative to the repository's `.operad/`. */
  readonly path: string;
  readonly schema: ActionArgsSchema;
  /**
   * The plugin's own check of the whole file as it would be written, run after
   * the schema and before the write. A string is the reason to refuse; nothing
   * is written and the client is told that reason as it is.
   */
  readonly check?:
    | ((ctx: ProjectSettingsContext) => MaybePromise<string | undefined>)
    | undefined;
  /**
   * Read-only values the plugin works out when settings are listed, by
   * property name. A property that has no stored value takes the value here.
   */
  readonly derived?:
    | ((ctx: ProjectSettingsContext) => MaybePromise<Readonly<Record<string, JsonValue>>>)
    | undefined;
}

/** What a project settings file's `check` and `derived` are given. */
export interface ProjectSettingsContext {
  readonly repository: SettingsRepository;
  /** The setting being changed, such as `dev.flows.mine`; empty when listing. */
  readonly name: string;
  /** The file's JSON object: as it would be written for `check`, as it is for `derived`. */
  readonly value: Readonly<Record<string, unknown>>;
}

/** A repository a plugin has registered. */
export interface SettingsRepository {
  readonly name: string;
  readonly path: string;
}

/** The project settings a plugin declares. */
export interface ProjectSettingsDeclaration {
  /** The registered repositories whose `.operad/` holds the files. */
  readonly repositories: (ctx: {
    readonly store: ObjectStore;
  }) => MaybePromise<readonly SettingsRepository[]>;
  readonly files: readonly ProjectSettingsFile[];
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
  readonly choiceInfo?: Readonly<Record<string, ChoiceInfo>> | undefined;
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
  readonly choiceInfo?: Readonly<Record<string, ChoiceInfo>> | undefined;
  readonly object: StoredObject;
  readonly actions: readonly PendingActionView[];
}
