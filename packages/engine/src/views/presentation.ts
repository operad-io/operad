/**
 * The presentation kernel: the one API every client calls. It knows no plugin
 * name; it asks the loaded plugins for rows, sections and actions and adds the
 * flags and the history section the kernel itself owns.
 */

import { readFileSync } from "node:fs";
import { objectLink } from "../http/link.ts";
import type { LogBackend, RunInfo } from "../log/types.ts";
import {
  followsChanges,
  type FollowOptions,
} from "../platform/index.ts";
import { runTimes } from "./running.ts";
import type { PluginRegistry, ActionInfo } from "../plugin/registry.ts";
import { rankOf, sortByRank, splitActionName } from "../plugin/registry.ts";
import { messageOf } from "../plugin/errors.ts";
import { createPluginLogger } from "../plugin/logger.ts";
import { FileSecretStore } from "../plugin/secrets.ts";
import {
  assertWhere,
  CursorError,
  decodeCursor,
  encodeCursor,
  MAX_PAGE_LIMIT,
  pageLimit,
  whereFingerprint,
  WhereError,
} from "../plugin/paging.ts";
import { ALL_FILTER, filterShows, typeFilters, type TypeFilter } from "../plugin/filters.ts";
import { ActionArgsError, fileProperties, noteProperty, validateActionArgs } from "../plugin/action-schema.ts";
import { attachmentDir, UploadMissingError, Uploads } from "./uploads.ts";
import type {
  ActionTypeDefinition,
  Actor,
  FactWriter,
  FactsOptions,
  FactsPage,
  ListOptions,
  ObjectRef,
  ObjectViews,
  PluginFact,
  PluginStore,
  StoredObject,
  RowMark,
  ViewContext,
} from "../plugin/types.ts";
import { ROW_BADGE_MAX, ROW_MARKS } from "../plugin/types.ts";
import {
  localMinute,
  runHistoryLines,
  type HistoryFact,
} from "./history.ts";
import { readState } from "../runner/service.ts";
import { recordAnswer } from "../runner/answer.ts";
import { StateError } from "../runner/errors.ts";
import { listPending, type CandidateSource, type PendingItem } from "./pending.ts";
import {
  listSettings,
  setSetting,
  SettingsError,
  type SettingInfo,
  type SettingsOptions,
} from "./settings.ts";
import { isRecord } from "../util.ts";
import { configPath } from "../config/config.ts";
import { prepareSettings } from "../plugin/settings.ts";
import type { JsonValue } from "../log/types.ts";

/** The final section the kernel adds to every object. */
export const HISTORY_SECTION = "history";

/** The default time a section's `load` may take. */
export const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

/** The default number of bytes a section may return. */
export const DEFAULT_SECTION_CAP_BYTES = 256 * 1024;

/** The default time `row` may take before it is an error row. */
export const DEFAULT_ROW_TIMEOUT_MS = 50;

/** The default number of ids an event consumer remembers. */
export const DEFAULT_MAX_EVENT_IDS = 1024;

/**
 * How often the kernel announces one object whose live section grows. A
 * section that grows faster than this is announced at most once per window;
 * the last growth in the window is announced when the window ends.
 */
export const GROWTH_EVENT_INTERVAL_MS = 250;

/** A row as a client sees it: the plugin's row plus the kernel's two flags. */
export interface ViewRow {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly note?: string | undefined;
  /** Why the object waits, whole and separate from `note`; absent when it does not. */
  readonly wait?: string | undefined;
  /** The namespace the id lives in; set only when the list shows it. */
  readonly scope?: string | undefined;
  /** The row's state is final for its type; absent when the plugin did not say. */
  readonly final?: boolean | undefined;
  /** The plugin's semantic mark; the precedence against the flags is the client's. */
  readonly mark?: RowMark | undefined;
  /** A short text shown after the state. */
  readonly badge?: string | undefined;
  /** The object one level up, exactly as the plugin's row names it. */
  readonly parent?: string | undefined;
  /** The siblings this object waits for, exactly as the plugin's row names them. */
  readonly after?: readonly string[] | undefined;
  /** A person wait is open on this object. */
  readonly waiting: boolean;
  /** The object's run is working. */
  readonly running: boolean;
  /** Set when the plugin's `row` failed; the row is then an error row. */
  readonly error?: string | undefined;
}

/** One entry in a detail page's section directory. */
export interface ViewSectionInfo {
  readonly id: string;
  readonly title: string;
  readonly live?: boolean | undefined;
}

/** An action a client may offer for an object right now. */
export interface ViewAction extends ActionInfo {
  /** The key bound to this action, when one is. */
  readonly key?: string | undefined;
}

/** How a run ended: the outcome, the reason line of a failure, and when. */
export interface ViewRunEnd {
  readonly outcome: "done" | "failed" | "cancelled";
  /** The reason the run recorded; left out when it recorded none. */
  readonly reason?: string | undefined;
  /** When the run ended, in milliseconds since the epoch. */
  readonly endedAt: number;
}

/** What `get` returns: a row, the section directory and the actions. */
export interface ViewObject {
  readonly id: string;
  readonly type: string;
  /** The link that opens this object in the app. */
  readonly link: string;
  readonly row: ViewRow;
  readonly sections: readonly ViewSectionInfo[];
  readonly actions: readonly ViewAction[];
  /** Set when the object's plugin is no longer loaded. */
  readonly unavailable?: string | undefined;
  /** How the object's newest run ended; absent when it has no run or that run is still going. */
  readonly lastRun?: ViewRunEnd | undefined;
  /** The ids of the objects of this type whose row has this one in `after`. */
  readonly dependents?: readonly string[] | undefined;
}

/** What one section read returns. */
export interface ViewSectionContent {
  readonly markdown: string;
  readonly next?: string | undefined;
  /** The section's table of contents, passed through from the plugin. */
  readonly pages?: readonly ViewSectionPage[] | undefined;
  /**
   * An opaque position the finished content goes to. Pass it back as `after`
   * to read only what follows it. The plugin owns its meaning.
   */
  readonly mark?: string | undefined;
  /**
   * The part that is still changing, always its whole current text. The size
   * cap never cuts it; it shortens the finished page instead.
   */
  readonly tail?: string | undefined;
  /**
   * Present on a read that asked with `after`: true when `markdown` holds only
   * what follows the mark, false when the plugin answered with a whole page
   * and the client must replace its content instead of appending.
   */
  readonly delta?: boolean | undefined;
}

/** One entry of a section's table of contents. */
export interface ViewSectionPage {
  readonly label: string;
  readonly cursor?: string | undefined;
}

/** One change a client may react to. */
export interface ViewEvent {
  readonly id: string;
}

/** Why a presentation call refused. */
export type ViewErrorKind =
  | "not-found"
  | "ambiguous"
  | "no-views"
  | "section"
  | "timeout"
  | "action"
  | "not-available"
  | "unavailable"
  | "note"
  | "confirm"
  | "args"
  | "where"
  | "filter"
  | "cursor";

function settingsViewError(error: unknown): unknown {
  return error instanceof SettingsError
    ? new ViewError(error.kind, error.message, { cause: error })
    : error;
}

/** A presentation call cannot do what was asked. */
export class ViewError extends Error {
  readonly kind: ViewErrorKind;

  constructor(kind: ViewErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ViewError";
    this.kind = kind;
  }
}

export interface ViewsOptions extends FollowOptions {
  readonly registry: PluginRegistry;
  readonly store?: PluginStore | undefined;
  readonly log?: LogBackend | undefined;
  readonly cwd?: string | undefined;
  /** A namespace named explicitly, handed to each type's `resolve`. */
  readonly scope?: string | undefined;
  readonly clock?: (() => number) | undefined;
  readonly rowTimeoutMs?: number | undefined;
  readonly loadTimeoutMs?: number | undefined;
  readonly sectionCapBytes?: number | undefined;
  readonly maxEventIds?: number | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
  /** The operad home whose `config.json` holds the global settings. */
  readonly home?: string | undefined;
}

export interface ActOptions {
  /** The person's values, already named as the action's schema names them. */
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  /** `args` for the note property, kept as `--note` convenience. */
  readonly note?: string | undefined;
  readonly yes?: boolean | undefined;
  /** Where the person asked: the command line or the HTTP interface. */
  readonly surface?: "cli" | "http" | undefined;
  /** Who asked; the CLI passes `{ via: "cli", id: <user> }`. */
  readonly actor: Actor;
}

/**
 * The in-process client API: the calls HTTP and the TUI make. A source plugin's
 * `start` receives the same `Views` object that serves them, narrowed to these.
 * `act` and `answer` both take an actor naming the person who acted.
 */
export type ClientApi = Pick<
  Views,
  "list" | "get" | "section" | "events" | "act" | "pending" | "answer"
>;

/** What answers one open question of a pending item. */
export interface AnswerViewOptions {
  readonly runId: string;
  /** The wait id the pending item named. */
  readonly waitId: string;
  readonly choice: string;
  readonly note?: string | undefined;
  /** Confirms an action-backed choice whose action asks to confirm. */
  readonly confirmed?: boolean | undefined;
  /** Where the person asked: the command line or the HTTP interface. */
  readonly surface?: "cli" | "http" | undefined;
  /** Who answered. */
  readonly actor: Actor;
}

/** How many hidden rows would draw each mark role. */
export interface ViewHiddenCounts {
  readonly done: number;
  readonly cancelled: number;
  readonly other: number;
}

/** One page of rows and where to continue. */
export interface ViewListPage {
  readonly rows: readonly ViewRow[];
  readonly next?: string | undefined;
  /** How many rows of the type the filter left out; absent without a filter or on `all`. */
  readonly hidden?: number | undefined;
  /** The hidden rows by the mark role they would draw; present with `hidden`. */
  readonly hiddenCounts?: ViewHiddenCounts | undefined;
}

/** The mark role a hidden row adds to: done, cancelled or other. */
function hiddenRole(row: ViewRow): keyof ViewHiddenCounts {
  if (row.mark === "cancelled" || /(^|\.)cancelled$/i.test(row.state)) {
    return "cancelled";
  }
  if (row.mark === "done" || (row.mark === undefined && /^(done|merged)$/i.test(row.state))) {
    return "done";
  }
  return "other";
}

/** What a hierarchy list adds to the flat list's options. */
export interface TreeListOptions extends ListOptions {
  /** Which filter to apply; each type's default filter when absent. */
  readonly filter?: string | undefined;
  /** Only rows with no parent. */
  readonly root?: boolean | undefined;
  /** Only rows whose parent is this object id. */
  readonly parent?: string | undefined;
}

/** An action that ran. */
export interface ViewActionRun {
  readonly plugin: string;
  readonly action: string;
  readonly name: string;
  readonly value: unknown;
  /** The object the action created, as `type:id`; only one that exists. */
  readonly opens?: string | undefined;
  /** The result was already true, so nothing ran; `value` says so. */
  readonly settled?: true | undefined;
}

export interface SectionOptions {
  /** Return the whole section, without the size cap. */
  readonly full?: boolean | undefined;
  /** Return only the finished content after this mark from an earlier read. */
  readonly after?: string | undefined;
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function pagesOf(value: unknown): readonly ViewSectionPage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pages: ViewSectionPage[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    const label = textOf(entry.label);
    if (label === undefined) continue;
    const cursor = textOf(entry.cursor);
    pages.push(cursor === undefined ? { label } : { label, cursor });
  }
  return pages;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function splitId(id: string): { readonly type: string; readonly id: string } | undefined {
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return undefined;
  return { type: id.slice(0, at), id: id.slice(at + 1) };
}

function capBytes(markdown: string, limit: number): string {
  const bytes = Buffer.from(markdown, "utf8");
  if (bytes.length <= limit) return markdown;
  let end = limit;
  // A UTF-8 continuation byte at `end` means the character that started before
  // it does not fit; back off to the boundary so decoding adds no U+FFFD and
  // the result never grows past the limit.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function truncationNote(id: string, sectionId: string): string {
  return `\n\n[Truncated. See all of it with \`operad show ${id} --section ${sectionId} --full\`.]\n`;
}

/** The envelope a section mark carries, so a mark is used only where it was made. */
const SECTION_MARK_KIND = "section-mark";

function encodeSectionMark(
  type: string,
  id: string,
  section: string,
  mark: string,
): string {
  return encodeCursor({ kind: SECTION_MARK_KIND, type, id, section, mark });
}

/**
 * The plugin's own mark inside an opaque one this section gave, or a refusal a
 * person can read when the mark names another section or object.
 */
function decodeSectionMark(
  value: string,
  type: string,
  id: string,
  section: string,
): string {
  const label = `section "${section}" of "${id}"`;
  let decoded: Record<string, unknown>;
  try {
    decoded = decodeCursor(value, label);
  } catch {
    throw new ViewError(
      "cursor",
      `${label}: "after" is not a mark this section gave; read the section once without "after" first`,
    );
  }
  if (decoded.kind !== SECTION_MARK_KIND) {
    throw new ViewError(
      "cursor",
      `${label}: "after" is not a mark this section gave; read the section once without "after" first`,
    );
  }
  if (
    decoded.type !== type ||
    decoded.id !== id ||
    decoded.section !== section
  ) {
    const madeFor =
      typeof decoded.section === "string" &&
      typeof decoded.type === "string" &&
      typeof decoded.id === "string"
        ? `the mark was made for section "${decoded.section}" of "${decoded.type}:${decoded.id}"`
        : "the mark was made for another section or object";
    throw new ViewError(
      "cursor",
      `${label}: ${madeFor}; read this section without "after" first`,
    );
  }
  const mark = decoded.mark;
  if (typeof mark !== "string") {
    throw new ViewError(
      "cursor",
      `${label}: "after" is not a mark this section gave; read the section once without "after" first`,
    );
  }
  return mark;
}

interface ResolvedObject {
  readonly type: string;
  readonly id: string;
  readonly object: StoredObject | undefined;
}

interface RunFlags {
  readonly waiting: boolean;
  readonly running: boolean;
}

/** A bounded, coalescing stream of ids. */
class EventStream implements AsyncIterable<ViewEvent> {
  private readonly pending = new Set<string>();
  private readonly max: number;
  private readonly listeners: Set<(id: string) => void>;
  private readonly flush: () => void;
  private closed = false;
  private resume: (() => void) | undefined;

  constructor(
    max: number,
    listeners: Set<(id: string) => void>,
    flush: () => void,
  ) {
    this.max = Math.max(1, max);
    this.listeners = listeners;
    this.flush = flush;
  }

  readonly listener = (id: string): void => {
    if (this.closed) return;
    if (this.pending.size >= this.max && !this.pending.has(id)) {
      const oldest = this.pending.values().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.delete(id);
    this.pending.add(id);
    this.wake();
  };

  [Symbol.asyncIterator](): AsyncIterator<ViewEvent> {
    this.listeners.add(this.listener);
    return {
      next: () => this.next(),
      return: async () => this.stop(),
      throw: async () => this.stop(),
    };
  }

  private async next(): Promise<IteratorResult<ViewEvent>> {
    // A growth held back for the rate window becomes due with the clock, not
    // only when another change arrives.
    this.flush();
    while (!this.closed && this.pending.size === 0) {
      await new Promise<void>((resolve) => {
        this.resume = resolve;
      });
    }
    if (this.closed) return { done: true, value: undefined };
    const id = this.pending.values().next().value;
    if (id === undefined) return { done: false, value: { id: "" } };
    this.pending.delete(id);
    return { done: false, value: { id } };
  }

  private stop(): IteratorResult<ViewEvent> {
    this.closed = true;
    this.listeners.delete(this.listener);
    this.wake();
    return { done: true, value: undefined };
  }

  private wake(): void {
    const resume = this.resume;
    this.resume = undefined;
    resume?.();
  }
}

/** The fact an action leaves on its object to say who asked. */
const ACTION_FACT = "action_invoked";

/** An object named for a short list: its type, id, state and title. */
export interface RecentObject {
  readonly type: string;
  readonly id: string;
  readonly state: string;
  readonly title: string;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** One object fact in words, with the time it happened. */
function describeFact(fact: PluginFact): string {
  const time = new Date(fact.at).toISOString();
  if (fact.type === ACTION_FACT) {
    const data = fact.data;
    const action =
      typeof data.action === "string" ? data.action.replace("/", ":") : "an action";
    const actor = isRecord(data.actor) ? data.actor : {};
    const who: string[] = [];
    if (typeof actor.via === "string") who.push(`via ${actor.via}`);
    if (typeof actor.id === "string") who.push(`as ${actor.id}`);
    return `${time}  ${action}${who.length === 0 ? "" : ` (${who.join(", ")})`}`;
  }
  return `${time}  changed by ${fact.cause}`;
}

/** The in-process presentation API. */
export class Views {
  private readonly registry: PluginRegistry;
  private readonly store: PluginStore;
  private readonly log: LogBackend | undefined;
  private readonly cwd: string;
  private readonly scope: string | undefined;
  private readonly clock: () => number;
  private readonly rowTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly sectionCapBytes: number;
  private readonly maxEventIds: number;
  private readonly onLog: (message: string) => void;
  private readonly home: string;
  private readonly uploads: Uploads;
  private readonly eventListeners = new Set<(id: string) => void>();
  /** When each object's live growth was last announced, for the rate limit. */
  private readonly growthAnnouncedAt = new Map<string, number>();
  /** Objects whose growth was held back in the current rate window. */
  private readonly growthPending = new Set<string>();
  /** The timer that announces an object when its rate window ends. */
  private readonly growthTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: (() => void)[] = [];
  private candidateSource: CandidateSource | undefined;
  private preparing: Promise<void> | undefined;

  constructor(options: ViewsOptions) {
    this.registry = options.registry;
    this.store = options.store ?? options.registry.store;
    this.log = options.log;
    this.cwd = options.cwd ?? options.registry.workdir;
    this.scope = options.scope;
    this.clock = options.clock ?? (() => Date.now());
    this.rowTimeoutMs = options.rowTimeoutMs ?? DEFAULT_ROW_TIMEOUT_MS;
    this.loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    this.sectionCapBytes =
      options.sectionCapBytes ?? DEFAULT_SECTION_CAP_BYTES;
    this.maxEventIds = options.maxEventIds ?? DEFAULT_MAX_EVENT_IDS;
    this.onLog = options.onLog ?? ((message) => console.error(message));
    this.home = options.home ?? options.registry.home;
    this.uploads = new Uploads({ home: this.home, clock: this.clock });

    if (followsChanges(options)) {
      if (typeof this.store.subscribe === "function") {
        this.unsubscribe.push(
          this.store.subscribe((object) => this.publish(object.id)),
        );
      }
      if (typeof this.log?.subscribe === "function") {
        this.unsubscribe.push(
          this.log.subscribe((change) => {
            const parsed = change.object === undefined
              ? undefined
              : splitId(change.object);
            if (parsed === undefined) return;
            if (parsed.type === "flow") return;
            this.publish(parsed.id, true);
          }),
        );
      }
    }
  }

  /** Runs each object type's `prepare` once; a failure is tried again next time. */
  private prepared(): Promise<void> {
    if (this.preparing === undefined) {
      const running = (async () => {
        for (const entry of this.registry.objectTypes()) {
          await entry.definition.prepare?.({
            store: this.store,
            home: this.registry.home,
            settings: this.registry.settingsFor(entry.plugin),
          });
        }
      })();
      this.preparing = running;
      running.catch(() => {
        if (this.preparing === running) this.preparing = undefined;
      });
    }
    return this.preparing;
  }

  /**
   * One plugin's settings from the file now, validated and with defaults. The
   * registry's copy stands in when the file or the section is unusable.
   */
  private settingsInForce(plugin: string): Readonly<Record<string, JsonValue>> {
    const fallback = this.registry.settingsFor(plugin);
    const schema = this.registry
      .settingsDeclarations()
      .find((entry) => entry.plugin === plugin)?.schema;
    if (schema === undefined) return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath(this.registry.home), "utf8"));
    } catch {
      return fallback;
    }
    const plugins = isRecord(parsed) ? parsed.plugins : undefined;
    const entry = isRecord(plugins) ? plugins[plugin] : undefined;
    const section = isRecord(entry) ? entry.settings : undefined;
    try {
      return prepareSettings(schema, section, plugin);
    } catch {
      return fallback;
    }
  }

  /** An object after its type's `prepare` runs with the settings in force now. */
  private async refreshedObject(
    type: string,
    id: string,
  ): Promise<StoredObject | undefined> {
    const entry = this.registry.objectTypes().find((item) => item.type === type);
    const prepare = entry?.definition.prepare;
    if (entry !== undefined && prepare !== undefined) {
      try {
        await prepare({
          store: this.store,
          home: this.registry.home,
          settings: this.settingsInForce(entry.plugin),
        });
      } catch (error) {
        this.onLog(
          `plugin "${entry.plugin}": prepare failed: ${messageOf(error)}`,
        );
      }
    }
    return this.store.get(type, id);
  }

  /** Closes the change listeners this view opened. */
  close(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    for (const timer of this.growthTimers.values()) clearTimeout(timer);
    this.growthTimers.clear();
    this.growthPending.clear();
    this.growthAnnouncedAt.clear();
  }

  /** The filter a list of this type uses when the caller names none. */
  defaultFilterOf(type: string): string | undefined {
    return typeFilters(this.registry.objectType(type))?.default;
  }

  /**
   * One page of rows for a type, with the kernel's flags. A `filter` keeps the
   * rows whose state it names and counts the rest in `hidden`; a list without
   * one shows every row.
   */
  async list(
    type: string,
    options: TreeListOptions = {},
  ): Promise<ViewListPage> {
    await this.prepared();
    const tree = options;
    const { filter, root: _root, parent: _parent, ...listOptions } = options;
    if (tree.root === true || tree.parent !== undefined) {
      return this.listTree(type, options);
    }
    if (filter !== undefined) return this.listFiltered(type, filter, listOptions);
    return this.listPlain(type, listOptions);
  }

  /**
   * The rows of one level of the hierarchy: `root` keeps rows with no parent,
   * `parent` keeps rows whose parent is that object. Without a type it covers
   * every type that has views, in the order the plugins declare them, and each
   * type's rows in the order its own list has. A parent that names no object
   * lists nothing. A filter applies per type (each type's default when none is
   * named; a type that does not declare the named filter shows every row), and
   * `hidden` counts the rows of the level the filter left out.
   */
  async listTree(
    type: string | undefined,
    options: TreeListOptions,
  ): Promise<ViewListPage> {
    await this.prepared();
    const root = options.root === true;
    const parent = options.parent;
    if (root && parent !== undefined) {
      throw new ViewError("args", "root and parent cannot be combined");
    }
    if (!root && (parent === undefined || parent.trim().length === 0)) {
      throw new ViewError("args", "parent needs an object id");
    }
    const label = type === undefined ? "list" : `list "${type}"`;
    const types: string[] = [];
    if (type === undefined) {
      for (const entry of this.registry.objectTypes()) {
        if (types.includes(entry.type)) continue;
        if (this.registry.viewsFor(entry.type) === undefined) continue;
        types.push(entry.type);
      }
    } else {
      if (this.registry.viewsFor(type) === undefined) {
        throw new ViewError(
          "no-views",
          `no loaded plugin shows objects of type "${type}"`,
        );
      }
      types.push(type);
    }
    const fingerprint = whereFingerprint(options.where ?? {});
    let after: { readonly t: number; readonly id: string } | undefined;
    if (options.cursor !== undefined) {
      try {
        const cursor = decodeCursor(options.cursor, label);
        const mark = cursor.after;
        if (
          cursor.kind !== "tree" ||
          (cursor.type ?? undefined) !== type ||
          (cursor.filter ?? undefined) !== options.filter ||
          cursor.where !== fingerprint ||
          (cursor.root === true) !== root ||
          (cursor.parent ?? undefined) !== parent ||
          !isRecord(mark) ||
          typeof mark.t !== "number" ||
          typeof mark.id !== "string"
        ) {
          throw new CursorError(`${label}: the cursor was made for a different list`);
        }
        after = { t: mark.t, id: mark.id };
      } catch (error) {
        if (error instanceof CursorError) {
          throw new ViewError("cursor", error.message, { cause: error });
        }
        throw error;
      }
    }
    const limit = (() => {
      try {
        return pageLimit(options.limit);
      } catch (error) {
        throw new ViewError("args", messageOf(error), { cause: error });
      }
    })();

    const accepted = root || parent === undefined ? undefined : await this.parentForms(parent);
    const flags = await this.allRunFlags();
    const shown: { readonly t: number; readonly id: string; readonly row: ViewRow }[] = [];
    let hidden = 0;
    const hiddenCounts = { done: 0, cancelled: 0, other: 0 };
    let counted = false;
    for (const [t, name] of types.entries()) {
      const owner = this.registry.viewsFor(name);
      if (owner === undefined) continue;
      const declared = typeFilters(this.registry.objectType(name));
      let chosen: TypeFilter | undefined;
      const wanted = options.filter ?? declared?.default;
      if (wanted !== undefined) {
        chosen = declared?.filters.find((candidate) => candidate.name === wanted);
        if (chosen === undefined && type !== undefined) {
          throw new ViewError(
            "filter",
            declared === undefined
              ? `type "${name}": this type has no filters`
              : `type "${name}": unknown filter "${wanted}"; allowed: ${declared.filters
                  .map((candidate) => candidate.name)
                  .join(", ")}`,
          );
        }
        if (chosen?.name === ALL_FILTER) chosen = undefined;
      }
      if (chosen !== undefined) counted = true;
      const withScope = await this.scopeShown(owner.plugin, name, owner.views);
      let cursor: string | undefined;
      do {
        let page;
        try {
          page = await this.store.list(name, {
            ...(options.where === undefined ? {} : { where: options.where }),
            ...(options.index === undefined ? {} : { index: options.index }),
            ...(cursor === undefined ? {} : { cursor }),
            limit: MAX_PAGE_LIMIT,
          });
        } catch (error) {
          if (error instanceof WhereError || error instanceof CursorError) {
            throw new ViewError(
              error instanceof CursorError ? "cursor" : "where",
              error.message,
              { cause: error },
            );
          }
          throw error;
        }
        for (const object of page.objects) {
          const row = this.listRow(owner.plugin, name, object, flags, withScope);
          const rowParent = row.parent;
          const inLevel =
            accepted === undefined ? rowParent === undefined : rowParent !== undefined && accepted.has(rowParent);
          if (!inLevel) continue;
          if (chosen === undefined || filterShows(chosen, row.state)) {
            shown.push({ t, id: object.id, row });
          } else {
            hidden += 1;
            hiddenCounts[hiddenRole(row)] += 1;
          }
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }

    let start = 0;
    if (after !== undefined) {
      const resume = after;
      const next = shown.findIndex(
        (entry) => entry.t > resume.t || (entry.t === resume.t && entry.id > resume.id),
      );
      start = next >= 0 ? next : shown.length;
    }
    const slice = shown.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const more = start + limit < shown.length && last !== undefined;
    return {
      rows: slice.map((entry) => entry.row),
      ...(more
        ? {
            next: encodeCursor({
              kind: "tree",
              type: type ?? null,
              filter: options.filter ?? null,
              where: fingerprint,
              root,
              parent: parent ?? null,
              after: { t: last.t, id: last.id },
            }),
          }
        : {}),
      ...(counted ? { hidden, hiddenCounts } : {}),
    };
  }

  /** The spellings a row's `parent` may use for the object this id names. */
  private async parentForms(parent: string): Promise<ReadonlySet<string>> {
    const forms = new Set<string>([parent]);
    try {
      const resolved = await this.resolve(parent);
      forms.add(objectKey(resolved.type, resolved.id));
      forms.add(resolved.id);
    } catch {
      // An id that names nothing, or names two things, matches only as written.
    }
    return forms;
  }

  private async listFiltered(
    type: string,
    name: string,
    options: ListOptions,
  ): Promise<ViewListPage> {
    const declared = typeFilters(this.registry.objectType(type));
    if (declared === undefined) {
      throw new ViewError("filter", `type "${type}": this type has no filters`);
    }
    const chosen = declared.filters.find((candidate) => candidate.name === name);
    if (chosen === undefined) {
      throw new ViewError(
        "filter",
        `type "${type}": unknown filter "${name}"; allowed: ${declared.filters
          .map((candidate) => candidate.name)
          .join(", ")}`,
      );
    }
    if (chosen.name === ALL_FILTER) return this.listPlain(type, options);

    const owner = this.registry.viewsFor(type);
    if (owner === undefined) {
      throw new ViewError(
        "no-views",
        `no loaded plugin shows objects of type "${type}"`,
      );
    }
    const label = `list "${type}"`;
    const fingerprint = whereFingerprint(options.where ?? {});
    let after: string | undefined;
    if (options.cursor !== undefined) {
      try {
        const cursor = decodeCursor(options.cursor, label);
        if (
          cursor.kind !== "filtered" ||
          cursor.type !== type ||
          cursor.filter !== chosen.name ||
          cursor.where !== fingerprint ||
          typeof cursor.after !== "string"
        ) {
          throw new CursorError(`${label}: the cursor was made for a different list`);
        }
        after = cursor.after;
      } catch (error) {
        if (error instanceof CursorError) {
          throw new ViewError("cursor", error.message, { cause: error });
        }
        throw error;
      }
    }
    const limit = (() => {
      try {
        return pageLimit(options.limit);
      } catch (error) {
        throw new ViewError("args", messageOf(error), { cause: error });
      }
    })();

    // The state is the plugin's row, so every object is read to be judged.
    const flags = await this.allRunFlags();
    const withScope = await this.scopeShown(owner.plugin, type, owner.views);
    const shown: { readonly id: string; readonly row: ViewRow }[] = [];
    let hidden = 0;
    const hiddenCounts = { done: 0, cancelled: 0, other: 0 };
    let cursor: string | undefined;
    do {
      let page;
      try {
        page = await this.store.list(type, {
          ...(options.where === undefined ? {} : { where: options.where }),
          ...(options.index === undefined ? {} : { index: options.index }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: MAX_PAGE_LIMIT,
        });
      } catch (error) {
        if (error instanceof WhereError || error instanceof CursorError) {
          throw new ViewError(
            error instanceof CursorError ? "cursor" : "where",
            error.message,
            { cause: error },
          );
        }
        throw error;
      }
      for (const object of page.objects) {
        const row = this.listRow(owner.plugin, type, object, flags, withScope);
        if (filterShows(chosen, row.state)) shown.push({ id: object.id, row });
        else {
          hidden += 1;
          hiddenCounts[hiddenRole(row)] += 1;
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);

    let start = 0;
    if (after !== undefined) {
      const resume = after;
      const at = shown.findIndex((entry) => entry.id === resume);
      const next = shown.findIndex((entry) => entry.id > resume);
      start = at >= 0 ? at + 1 : next >= 0 ? next : shown.length;
    }
    const slice = shown.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const more = start + limit < shown.length && last !== undefined;
    return {
      rows: slice.map((entry) => entry.row),
      ...(more
        ? {
            next: encodeCursor({
              kind: "filtered",
              type,
              filter: chosen.name,
              where: fingerprint,
              after: last.id,
            }),
          }
        : {}),
      hidden,
      hiddenCounts,
    };
  }

  private async listPlain(type: string, options: ListOptions): Promise<ViewListPage> {
    const owner = this.registry.viewsFor(type);
    if (owner === undefined) {
      throw new ViewError(
        "no-views",
        `no loaded plugin shows objects of type "${type}"`,
      );
    }

    if (options.where !== undefined) {
      try {
        assertWhere(
          options.index ?? this.registry.indexFor(type) ?? Object.keys(options.where),
          options.where,
          `list "${type}"`,
        );
      } catch (error) {
        if (error instanceof WhereError) {
          throw new ViewError("where", error.message, { cause: error });
        }
        throw error;
      }
    }

    let page;
    try {
      page = await this.store.list(type, options);
    } catch (error) {
      if (error instanceof WhereError || error instanceof CursorError) {
        throw new ViewError(
          error instanceof CursorError ? "cursor" : "where",
          error.message,
          { cause: error },
        );
      }
      throw error;
    }
    const flags = await this.allRunFlags();
    const withScope = await this.scopeShown(owner.plugin, type, owner.views);
    const rows = page.objects.map((object) =>
      this.listRow(owner.plugin, type, object, flags, withScope),
    );
    return { rows, ...(page.next === undefined ? {} : { next: page.next }) };
  }

  /**
   * The rows `list` would show for these objects, keyed `<type>:<id>`. One
   * read of the run flags serves them all. An object that is gone, or whose
   * type no loaded plugin shows, gets an error row, and a plugin whose `row`
   * throws gets the same error row `list` shows; this never throws for one
   * object.
   */
  async rowsOf(
    objects: readonly ObjectRef[],
  ): Promise<ReadonlyMap<string, ViewRow>> {
    const rows = new Map<string, ViewRow>();
    if (objects.length === 0) return rows;
    const flags = await this.allRunFlags();
    const shown = new Map<string, boolean>();
    for (const ref of objects) {
      const key = objectKey(ref.type, ref.id);
      if (rows.has(key)) continue;
      const owner = this.registry.viewsFor(ref.type);
      let stored: StoredObject | undefined;
      try {
        stored = await this.store.get(ref.type, ref.id);
      } catch (error) {
        this.onLog(`could not read "${key}": ${messageOf(error)}`);
      }
      if (owner === undefined || stored === undefined) {
        rows.set(
          key,
          this.errorRow(
            ref.id,
            owner === undefined
              ? `no loaded plugin shows objects of type "${ref.type}"`
              : `no object "${key}"`,
          ),
        );
        continue;
      }
      let withScope = shown.get(ref.type);
      if (withScope === undefined) {
        withScope = await this.scopeShown(owner.plugin, ref.type, owner.views);
        shown.set(ref.type, withScope);
      }
      rows.set(key, this.listRow(owner.plugin, ref.type, stored, flags, withScope));
    }
    return rows;
  }

  /** One list row: the plugin's row with the run flags and, when shown, its scope. */
  private listRow(
    plugin: string,
    type: string,
    object: StoredObject,
    flags: ReadonlyMap<string, RunFlags>,
    withScope: boolean,
  ): ViewRow {
    const { scope, ...row } = this.guardedRow(plugin, type, object);
    const flag = flags.get(objectKey(type, object.id)) ?? {
      waiting: false,
      running: false,
    };
    return {
      ...row,
      ...(withScope && scope !== undefined ? { scope } : {}),
      // A plugin's own `waiting` is an object a person must act on that has no run.
      waiting: row.waiting || flag.waiting,
      running: flag.running,
    };
  }

  /** One page of one object's facts in sequence order. */
  async facts(id: string, options: FactsOptions = {}): Promise<FactsPage> {
    const resolved = await this.resolve(id);
    return this.store.facts({ type: resolved.type, id: resolved.id }, options);
  }

  /** One object: its row, its section directory and the actions available now. */
  async get(id: string): Promise<ViewObject> {
    const resolved = await this.resolve(id);
    const owner = this.registry.viewsFor(resolved.type);
    const object = resolved.object;
    if (
      object === undefined &&
      owner !== undefined &&
      !(await this.hasRun(resolved.type, resolved.id)) &&
      this.store.facts({ type: resolved.type, id: resolved.id }, { limit: 1 }).facts.length === 0
    ) {
      // A plugin that scopes ids claims any well-formed id; nothing stored or
      // recorded under it means the id matches nothing.
      throw new ViewError(
        "not-found",
        `no object "${id}" of type "${resolved.type}"`,
      );
    }
    const flags = await this.flagsFor(resolved.type, resolved.id);

    let row: ViewRow;
    let sections: ViewSectionInfo[] = [];
    const actions: ViewAction[] = [];
    let unavailable: string | undefined;
    let dependents: readonly string[] = [];

    if (owner !== undefined && object !== undefined) {
      const { scope, ...guarded } = this.guardedRow(
        owner.plugin,
        resolved.type,
        object,
      );
      row = { ...guarded, ...flags, waiting: guarded.waiting || flags.waiting };
      try {
        sections = this.sectionDirectory(owner.plugin, object);
      } catch (error) {
        this.onLog(
          `plugin "${owner.plugin}": sections failed for "${resolved.type}:${resolved.id}": ${messageOf(error)}`,
        );
        sections = [];
      }
      actions.push(...(await this.availableActions(resolved.type, object)));
      dependents = await this.dependentsOf(owner.plugin, resolved.type, row.id, scope);
    } else {
      row = {
        id: resolved.id,
        title: resolved.id,
        state: "unknown",
        ...flags,
      };
      if (owner === undefined) {
        unavailable = `the plugin that owns "${resolved.type}" is not loaded; showing history only`;
      }
    }

    sections = sections.filter((section) => section.id !== HISTORY_SECTION);
    sections.push({ id: HISTORY_SECTION, title: "History" });
    const lastRun = await this.lastRunEnd(resolved.type, resolved.id);

    return {
      id: resolved.id,
      type: resolved.type,
      link: objectLink(resolved.type, resolved.id),
      row,
      sections,
      actions,
      ...(unavailable === undefined ? {} : { unavailable }),
      ...(lastRun === undefined ? {} : { lastRun }),
      ...(dependents.length === 0 ? {} : { dependents }),
    };
  }

  /**
   * The ids of the objects of a type whose row names `rowId` in `after`. A row
   * with a scope names only rows of its own scope.
   */
  private async dependentsOf(
    plugin: string,
    type: string,
    rowId: string,
    scope: string | undefined,
  ): Promise<readonly string[]> {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list(type, cursor === undefined ? {} : { cursor });
      for (const object of page.objects) {
        const row = this.guardedRow(plugin, type, object);
        if (
          row.id !== rowId &&
          row.scope === scope &&
          row.after?.includes(rowId) === true
        ) {
          found.push(row.id);
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return found.sort();
  }

  /** The Markdown of one section; `history` is served by the kernel. */
  async section(
    id: string,
    sectionId: string,
    cursor?: string,
    options: SectionOptions = {},
  ): Promise<ViewSectionContent> {
    const resolved = await this.resolve(id);
    const after =
      options.after === undefined
        ? undefined
        : decodeSectionMark(options.after, resolved.type, resolved.id, sectionId);
    if (sectionId === HISTORY_SECTION) {
      const markdown = await this.historyMarkdown(
        resolved.type,
        resolved.id,
        options.full === true,
      );
      return this.finishSection(
        id,
        sectionId,
        markdown,
        undefined,
        undefined,
        undefined,
        options.full === true,
        after === undefined ? undefined : false,
      );
    }

    const owner = this.registry.viewsFor(resolved.type);
    if (owner === undefined) {
      throw new ViewError(
        "unavailable",
        `the plugin that owns "${resolved.type}" is not loaded; only "${HISTORY_SECTION}" is available`,
      );
    }
    const object = resolved.object;
    if (object === undefined) {
      throw new ViewError(
        "not-found",
        `no object "${id}" of type "${resolved.type}"`,
      );
    }
    const directory = this.sectionDirectory(owner.plugin, object);
    const section = directory.find((entry) => entry.id === sectionId);
    if (section === undefined) {
      throw new ViewError(
        "section",
        `object "${id}" has no section "${sectionId}"`,
      );
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new ViewError(
            "timeout",
            `section "${sectionId}" of "${id}" did not answer within ${this.loadTimeoutMs}ms`,
          ),
        );
      }, this.loadTimeoutMs);
    });

    let content: unknown;
    try {
      const ctx = this.viewContext(owner.plugin, controller.signal);
      const work = Promise.resolve().then(() =>
        owner.views.load(ctx, object, sectionId, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(after === undefined ? {} : { after }),
        }),
      );
      content = await Promise.race([work, timeout]);
    } catch (error) {
      if (error instanceof ViewError) throw error;
      throw new ViewError(
        "section",
        `section "${sectionId}" of "${id}" failed: ${messageOf(error)}`,
        { cause: error },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const markdown = isRecord(content) ? textOf(content.markdown) : undefined;
    if (markdown === undefined) {
      throw new ViewError(
        "section",
        `section "${sectionId}" of "${id}": load must return { markdown, next? }`,
      );
    }
    const next = isRecord(content) ? textOf(content.next) : undefined;
    const pages = isRecord(content) ? pagesOf(content.pages) : undefined;
    const rawMark = isRecord(content) ? textOf(content.mark) : undefined;
    const tail = isRecord(content) ? textOf(content.tail) : undefined;
    // A plugin that ignored `after` answers with a whole page; only one that
    // says its answer is the delta may be appended to by a client.
    const honoured =
      isRecord(content) && content.delta === true && after !== undefined;
    const mark =
      rawMark === undefined
        ? undefined
        : encodeSectionMark(resolved.type, resolved.id, section.id, rawMark);
    const finished = this.finishSection(
      id,
      section.id,
      markdown,
      next,
      mark,
      tail,
      options.full === true,
      after === undefined ? undefined : honoured,
    );
    return pages === undefined ? finished : { ...finished, pages };
  }

  /** An async stream of ids that changed. Repeated ids coalesce. */
  events(): AsyncIterable<ViewEvent> {
    return new EventStream(
      this.maxEventIds,
      this.eventListeners,
      () => this.flushDueGrowth(),
    );
  }

  /** Every setting in a scope (global and every repository when omitted). */
  async settings(scope?: string | undefined): Promise<readonly SettingInfo[]> {
    try {
      return await listSettings(this.settingsOptions(), scope);
    } catch (error) {
      throw settingsViewError(error);
    }
  }

  /** Changes one setting; a refusal writes nothing. */
  async set(
    name: string,
    value: unknown,
    options: { readonly scope?: string | undefined; readonly confirmed?: boolean | undefined } = {},
  ): Promise<SettingInfo> {
    try {
      return await setSetting(this.settingsOptions(), name, value, options);
    } catch (error) {
      throw settingsViewError(error);
    }
  }

  private settingsOptions(): SettingsOptions {
    return { registry: this.registry, store: this.store, home: this.home };
  }

  /**
   * Answers one question of a pending item by the wait id it named. A closed
   * question is refused, as it is for the command line and a plugin action.
   */
  async answer(options: AnswerViewOptions): Promise<void> {
    const who: unknown = (options as { actor?: unknown } | undefined)?.actor;
    if (
      !isRecord(who) ||
      typeof who.via !== "string" ||
      who.via.length === 0 ||
      typeof who.id !== "string" ||
      who.id.length === 0
    ) {
      throw new ViewError(
        "args",
        "answer needs an actor: { via, id } says who answered",
      );
    }
    if (this.log === undefined) {
      throw new ViewError(
        "not-available",
        "this server has no run log, so it cannot answer a question",
      );
    }
    const pending = await listPending(this.log, this.registry);
    const item = pending.find(
      (candidate) =>
        candidate.runId === options.runId && candidate.waitId === options.waitId,
    );
    // A wait whose choices are the object's actions answers through that
    // action, so its note, confirmation and object update still happen.
    const throughAction =
      item !== undefined &&
      item.choices.every((name) =>
        item.actions.some((action) => action.action === name),
      )
        ? item.actions.find((action) => action.action === options.choice)
        : undefined;
    if (item !== undefined && throughAction !== undefined) {
      const info = this.resolveActionInfo(
        `${throughAction.plugin}:${throughAction.action}`,
      );
      if (item.object === undefined) {
        throw new ViewError(
          "not-found",
          `the pending item "${options.waitId}" names no object`,
        );
      }
      await this.act(info.name, item.object, {
        ...(options.note === undefined ? {} : { note: options.note }),
        ...(options.surface === undefined ? {} : { surface: options.surface }),
        yes: options.confirmed === true,
        actor: options.actor,
      });
      return;
    }
    try {
      await recordAnswer({
        log: this.log,
        runId: options.runId,
        waitId: options.waitId,
        choice: options.choice,
        ...(options.note === undefined ? {} : { note: options.note }),
        actor: options.actor,
      });
    } catch (error) {
      if (error instanceof StateError) {
        throw new ViewError("not-available", error.message, { cause: error });
      }
      throw error;
    }
  }

  /**
   * Where `pending` gets the trigger candidates and refused starts, the same
   * source HTTP passes `listPending`. The host that owns the kernel sets it.
   */
  useCandidates(source: CandidateSource | undefined): void {
    this.candidateSource = source;
  }

  /** What waits for a person: the pending view, as HTTP serves it. */
  async pending(): Promise<readonly PendingItem[]> {
    if (this.log === undefined) {
      throw new ViewError(
        "not-available",
        "this server has no run log, so it cannot list what is pending",
      );
    }
    return listPending(this.log, this.registry, this.candidateSource, this);
  }

  /** Runs one action by `<plugin>:<action>`, honouring note and confirm. */
  async act(
    name: string,
    id: string | undefined,
    options: ActOptions,
  ): Promise<ViewActionRun> {
    // The type asks for an actor; a caller outside the type checker (a plugin
    // in plain JavaScript) is refused here, before anything runs.
    const who: unknown = (options as { actor?: unknown } | undefined)?.actor;
    if (
      !isRecord(who) ||
      typeof who.via !== "string" ||
      who.via.length === 0 ||
      typeof who.id !== "string" ||
      who.id.length === 0
    ) {
      throw new ViewError(
        "args",
        `action "${name}" needs an actor: { via, id } says who asked`,
      );
    }
    // An action that targets no object names no id. The kernel has no such
    // action today, but the HTTP body allows it, so the views say why it
    // cannot run instead of refusing the request before looking it up.
    if (id === undefined) {
      const info = this.resolveActionInfo(name);
      throw new ViewError(
        "not-found",
        `action "${info.name}" targets ${info.on} objects; pass the object id`,
      );
    }
    const resolved = await this.resolve(id);
    const object = resolved.object;
    if (object === undefined) {
      throw new ViewError(
        "not-found",
        `no object "${id}" of type "${resolved.type}"`,
      );
    }

    const owner = this.registry.viewsFor(resolved.type);
    const subject =
      owner === undefined
        ? resolved.id
        : this.guardedRow(owner.plugin, resolved.type, object).id;
    const target = this.resolveAction(name, resolved.type, subject);
    const env = this.registry.actionEnv();

    // A result that is already true is not an error: the plugin says so and
    // nothing runs.
    if (target.action.settled !== undefined) {
      let message: string | undefined;
      try {
        message = await target.action.settled(object, options.args ?? {}, env);
      } catch (error) {
        this.onLog(
          `plugin "${target.plugin}": action "${target.action.name}": settled failed: ${messageOf(error)}`,
        );
      }
      if (message !== undefined && message.length > 0) {
        return {
          plugin: target.plugin,
          action: target.action.name,
          name: target.info.name,
          value: message,
          settled: true,
        };
      }
    }

    let holds: unknown;
    try {
      holds = await target.action.when(object.data, env);
    } catch (error) {
      this.onLog(
        `plugin "${target.plugin}": action "${target.action.name}": when failed: ${messageOf(error)}`,
      );
      throw new ViewError(
        "not-available",
        `${subject} cannot ${target.info.name} now`,
      );
    }
    if (holds !== true) {
      throw new ViewError("not-available", await this.refusal(target, object, subject));
    }

    const args: Record<string, unknown> = { ...(options.args ?? {}) };
    const note = noteProperty(target.action.args);
    if (
      note !== undefined &&
      options.note !== undefined &&
      args[note.name] === undefined
    ) {
      args[note.name] = options.note;
    }
    if (
      note?.required === true &&
      (args[note.name] === undefined ||
        (typeof args[note.name] === "string" &&
          (args[note.name] as string).trim().length === 0))
    ) {
      throw new ViewError(
        "note",
        `action "${target.info.name}" needs a note; pass --${note.name} <text>`,
      );
    }

    let personArgs: Record<string, unknown>;
    try {
      personArgs = validateActionArgs(
        target.action.argsFor?.(object, env) ?? target.action.args,
        args,
        `action "${target.info.name}"`,
      );
    } catch (error) {
      if (error instanceof ActionArgsError) {
        throw new ViewError("args", error.message, { cause: error });
      }
      throw error;
    }

    if (target.action.confirm === true && options.yes !== true) {
      const hint =
        options.surface === "http"
          ? 'send "confirmed": true in the request body'
          : "pass --yes";
      throw new ViewError(
        "confirm",
        `action "${target.info.name}" needs confirmation; ${hint}`,
      );
    }

    // An uploaded file is taken only now that nothing else can refuse the call;
    // the action gets the stored path where the client sent the reference.
    const stored = await this.takeFiles(
      target.action.argsFor?.(object, env) ?? target.action.args,
      personArgs,
      resolved.type,
      resolved.id,
      target.info.name,
    );

    const runId = await this.waitingRunId(resolved.type, resolved.id);
    const result = await this.registry.runAction(
      `${target.plugin}/${target.action.name}`,
      stored,
      {
        object,
        ...(runId === undefined ? {} : { runId }),
        actor: options.actor,
        cwd: this.cwd,
      },
    );
    const opens = await this.existingOpens(target.info.name, result.opens);
    return {
      plugin: target.plugin,
      action: target.action.name,
      name: target.info.name,
      value: result.value,
      ...(opens === undefined ? {} : { opens }),
    };
  }

  /** Replaces each file argument's upload reference with the path the file is stored at. */
  private async takeFiles(
    schema: Parameters<typeof fileProperties>[0],
    args: Record<string, unknown>,
    type: string,
    id: string,
    label: string,
  ): Promise<Record<string, unknown>> {
    const files = fileProperties(schema);
    if (files.every((file) => args[file.name] === undefined)) return args;
    const dir = attachmentDir(this.home, type, id);
    const next: Record<string, unknown> = { ...args };
    for (const file of files) {
      const value = args[file.name];
      if (value === undefined) continue;
      const refs = Array.isArray(value) ? value : [value];
      const paths: string[] = [];
      for (const ref of refs) {
        try {
          paths.push((await this.uploads.take(String(ref), dir)).path);
        } catch (error) {
          if (error instanceof UploadMissingError) {
            throw new ViewError("args", `action "${label}": args.${file.name}: ${error.message}`, { cause: error });
          }
          throw error;
        }
      }
      next[file.name] = file.many ? paths : paths[0];
    }
    return next;
  }

  /** `opens` when it names an object that exists; otherwise the log says why. */
  private async existingOpens(action: string, opens: string | undefined): Promise<string | undefined> {
    if (opens === undefined) return undefined;
    const typed = splitId(opens);
    if (typed === undefined) {
      this.onLog(`action "${action}": opens "${opens}" is not <type>:<id>; not passed on`);
      return undefined;
    }
    let found: ResolvedObject | undefined;
    try {
      found = await this.resolve(opens);
    } catch (error) {
      this.onLog(`action "${action}": opens "${opens}" cannot be resolved (${messageOf(error)}); not passed on`);
      return undefined;
    }
    if (found.object === undefined) {
      this.onLog(`action "${action}": opens "${opens}" names no existing object; not passed on`);
      return undefined;
    }
    return opens;
  }

  private finishSection(
    id: string,
    sectionId: string,
    markdown: string,
    next: string | undefined,
    mark: string | undefined,
    tail: string | undefined,
    full: boolean,
    delta: boolean | undefined,
  ): ViewSectionContent {
    const result = (
      shownMarkdown: string,
      shownTail: string | undefined,
    ): ViewSectionContent => ({
      markdown: shownMarkdown,
      ...(next === undefined ? {} : { next }),
      ...(mark === undefined ? {} : { mark }),
      ...(shownTail === undefined ? {} : { tail: shownTail }),
      ...(delta === undefined ? {} : { delta }),
    });
    if (full) return result(markdown, tail);

    const suffix = truncationNote(id, sectionId);
    const limit = this.sectionCapBytes;
    const markdownBytes = Buffer.byteLength(markdown, "utf8");
    const tailBytes = tail === undefined ? 0 : Buffer.byteLength(tail, "utf8");
    if (markdownBytes + tailBytes <= limit) return result(markdown, tail);

    // The cap covers the finished page, the changing tail and the note
    // together. The tail is never cut: if even the tail and the note do not
    // fit, the section is refused and the client asks for it whole.
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    if (tailBytes + suffixBytes > limit) {
      throw new ViewError(
        "section",
        `section "${sectionId}" of "${id}" is over the ${limit}-byte size cap; ${suffix.trim()}`,
      );
    }
    const body = capBytes(markdown, limit - suffixBytes - tailBytes);
    return result(`${body}${suffix}`, tail);
  }

  private resolveActionInfo(name: string): ActionInfo {
    const target = splitActionName(name);
    const candidates = this.registry.actions().filter((info) =>
      target === undefined
        ? info.action === name
        : info.plugin === target.plugin && info.action === target.action,
    );
    if (candidates.length === 0) {
      throw new ViewError(
        "action",
        `there is no action "${name}"`,
      );
    }
    if (candidates.length > 1) {
      throw new ViewError(
        "ambiguous",
        `action "${name}" is offered by ${candidates.map((info) => `"${info.name}"`).join(", ")}; use "<plugin>:<action>"`,
      );
    }
    const only = candidates[0];
    if (only === undefined) {
      throw new ViewError("action", `there is no action "${name}"`);
    }
    return only;
  }

  /**
   * The line for an action this object cannot take at all: it starts with the
   * object's own name, like every refusal, and says where the action works.
   */
  private notOffered(subject: string, name: string, type: string): ViewError {
    const target = splitActionName(name);
    const types = [
      ...new Set(
        this.registry
          .actions()
          .filter((info) =>
            target === undefined
              ? info.action === name
              : info.plugin === target.plugin && info.action === target.action,
          )
          .map((info) => info.on),
      ),
    ];
    return new ViewError(
      "action",
      types.length === 0
        ? `${subject} has no action "${name}"`
        : `${subject} is a ${type}; ${name} works on ${types.join(" or ")}`,
    );
  }

  private resolveAction(
    name: string,
    type: string,
    subject: string,
  ): {
    readonly plugin: string;
    readonly action: ActionTypeDefinition;
    readonly info: ActionInfo;
  } {
    let target = splitActionName(name);
    if (target === undefined) {
      const candidates = this.registry
        .actions()
        .filter((info) => info.action === name && info.on === type);
      if (candidates.length === 0) throw this.notOffered(subject, name, type);
      if (candidates.length > 1) {
        throw new ViewError(
          "ambiguous",
          `action "${name}" is offered by ${candidates.map((info) => `"${info.name}"`).join(", ")}; use "<plugin>:<action>"`,
        );
      }
      const only = candidates[0];
      if (only === undefined) throw this.notOffered(subject, name, type);
      target = { plugin: only.plugin, action: only.action };
    }

    const info = this.registry
      .actions()
      .find(
        (entry) =>
          entry.name === `${target.plugin}:${target.action}` &&
          entry.on === type,
      );
    if (info === undefined) throw this.notOffered(subject, name, type);
    const found = this.actionDefinition(target.plugin, target.action, type);
    if (found === undefined) throw this.notOffered(subject, name, type);
    return { plugin: target.plugin, action: found, info };
  }

  private actionDefinition(
    pluginName: string,
    actionName: string,
    objectType?: string | undefined,
  ): ActionTypeDefinition | undefined {
    return this.registry.actionDefinition(pluginName, actionName, objectType);
  }

  private async availableActions(
    type: string,
    object: StoredObject,
  ): Promise<readonly ViewAction[]> {
    const keys = new Map(this.registry.keyBindings().map((item) => [item.name, item.key]));
    const actions: (ViewAction & { readonly rank: number })[] = [];
    const env = this.registry.actionEnv();
    for (const info of this.registry.actions()) {
      if (info.on !== type) continue;
      const action = this.registry.actionDefinition(
        info.plugin,
        info.action,
        info.on,
      );
      if (action === undefined) continue;
      let holds: unknown;
      try {
        holds = await action.when(object.data, env);
      } catch (error) {
        this.onLog(
          `plugin "${info.plugin}": action "${info.action}": when failed: ${messageOf(error)}`,
        );
        continue;
      }
      if (holds !== true) continue;
      const key = keys.get(info.name);
      const args = action.argsFor?.(object, env) ?? info.args;
      actions.push({
        ...info,
        ...(args === undefined ? {} : { args }),
        ...(key === undefined ? {} : { key }),
        rank: rankOf(action, object.data),
      });
    }
    return sortByRank(actions).map(({ rank: _rank, ...view }) => view);
  }

  private async resolve(id: string): Promise<ResolvedObject> {
    await this.prepared();
    const typed = splitId(id);
    // A qualified id names its namespace; a different `--repo` is a mistake.
    const qualified = (typed?.id ?? id).split("/");
    if (this.scope !== undefined && qualified.length > 1 && qualified[0] !== this.scope) {
      throw new ViewError(
        "args",
        `"${id}" is in repository "${qualified[0]}", but --repo names "${this.scope}"`,
      );
    }
    // A plugin may refuse a qualified id whose namespace is not valid (an
    // unregistered repository) even when an object is still stored under it.
    // A typed id is checked only by its own type's hook.
    if (qualified.length > 1) {
      await this.resolveWithPlugins(typed?.id ?? id, typed?.type);
    }
    if (typed !== undefined) {
      const object = await this.store.get(typed.type, typed.id);
      if (object !== undefined || (await this.hasRun(typed.type, typed.id))) {
        return { type: typed.type, id: typed.id, object };
      }
      // A typed bare id (`task:T-0043-x`) names a scoped object the same way
      // the bare id does, limited to its type: the operad app opens a row as
      // `<type>:<row id>`, and a row's id carries no namespace.
      if (!typed.id.includes("/")) {
        const scoped = await this.resolveWithPlugins(typed.id, typed.type);
        if (scoped !== undefined) return scoped;
        const suffixed: ResolvedObject[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await this.store.list(
            typed.type,
            cursor === undefined ? {} : { cursor },
          );
          for (const object of page.objects) {
            if (!object.id.endsWith(`/${typed.id}`)) continue;
            suffixed.push({ type: typed.type, id: object.id, object });
          }
          if (page.next === undefined) break;
          cursor = page.next;
        }
        if (suffixed.length > 1) {
          throw new ViewError(
            "ambiguous",
            `"${id}" is ambiguous: use ${suffixed
              .map((match) => `${match.type}:${match.id}`)
              .sort()
              .join(", ")}`,
          );
        }
        const only = suffixed[0];
        if (only !== undefined) return only;
      }
    }

    const matches: ResolvedObject[] = [];
    for (const entry of this.registry.objectTypes()) {
      const object = await this.store.get(entry.type, id);
      if (object !== undefined) {
        matches.push({ type: entry.type, id, object });
      }
    }
    if (matches.length > 1) {
      throw new ViewError(
        "ambiguous",
        `"${id}" is ambiguous: use ${matches.map((match) => `${match.type}:${id}`).sort().join(", ")}`,
      );
    }
    const only = matches[0];
    if (only !== undefined) return only;

    // A plugin may scope a bare id to a namespace of its own (the dev plugin
    // scopes plans and tasks to a repository). A returned key is the answer
    // even when no object is stored there, so the lookup cannot fall through to
    // another namespace; the kernel's suffix lookup runs only when none claims
    // the id.
    if (!id.includes(":")) {
      const scoped = await this.resolveWithPlugins(id);
      if (scoped !== undefined) return scoped;
    }

    // An object key may carry a namespace before a slash (a plugin's objects
    // can be scoped, such as one plan per repository). A bare id then still
    // names the object when exactly one key ends with `/<id>`.
    if (!id.includes("/")) {
      const suffixed: ResolvedObject[] = [];
      for (const entry of this.registry.objectTypes()) {
        let cursor: string | undefined;
        for (;;) {
          const page = await this.store.list(
            entry.type,
            cursor === undefined ? {} : { cursor },
          );
          for (const object of page.objects) {
            if (object.id === id || !object.id.endsWith(`/${id}`)) continue;
            suffixed.push({ type: entry.type, id: object.id, object });
          }
          if (page.next === undefined) break;
          cursor = page.next;
        }
      }
      if (suffixed.length > 1) {
        throw new ViewError(
          "ambiguous",
          `"${id}" is ambiguous: use ${suffixed
            .map((match) => `${match.type}:${match.id}`)
            .sort()
            .join(", ")}`,
        );
      }
      const scoped = suffixed[0];
      if (scoped !== undefined) return scoped;
    }

    // A match in a declared type wins: types seen only in the facts (a type no
    // loaded plugin declares any more) are looked at last, through the store's
    // lookup by object id, when nothing else claimed the id.
    const undeclared: ResolvedObject[] = [];
    for (const type of this.store.objectTypesOf(id)) {
      undeclared.push({ type, id, object: await this.store.get(type, id) });
    }
    if (undeclared.length > 1) {
      throw new ViewError(
        "ambiguous",
        `"${id}" is ambiguous: use ${undeclared.map((match) => `${match.type}:${id}`).sort().join(", ")}`,
      );
    }
    const orphan = undeclared[0];
    if (orphan !== undefined) return orphan;

    if (this.log !== undefined) {
      const found = (await this.log.runs({ object: id }))[0];
      const parsed = found === undefined ? undefined : splitId(found.object);
      if (parsed !== undefined) {
        const object = await this.store.get(parsed.type, parsed.id);
        return { type: parsed.type, id: parsed.id, object };
      }
    }

    throw new ViewError("not-found", `no object "${id}"`);
  }

  /**
   * Asks each object type's `resolve` hook for the key of a bare id. More than
   * one type claiming the id is ambiguous, and the typed form is the answer.
   */
  private async resolveWithPlugins(
    id: string,
    onlyType?: string,
  ): Promise<ResolvedObject | undefined> {
    const matches: ResolvedObject[] = [];
    for (const entry of this.registry.objectTypes()) {
      if (onlyType !== undefined && entry.type !== onlyType) continue;
      const resolve = entry.definition.resolve;
      if (resolve === undefined) continue;
      let key: unknown;
      try {
        key = await resolve(
          {
            cwd: this.cwd,
            store: this.store,
            ...(this.scope === undefined ? {} : { scope: this.scope }),
          },
          entry.type,
          id,
        );
      } catch (error) {
        // A plugin refuses with a ViewError when it knows why the id is wrong.
        if (error instanceof ViewError) throw error;
        this.onLog(
          `plugin "${entry.plugin}": resolve failed for "${entry.type}:${id}": ${messageOf(error)}`,
        );
        continue;
      }
      if (typeof key !== "string" || key.length === 0) continue;
      matches.push({
        type: entry.type,
        id: key,
        object: await this.store.get(entry.type, key),
      });
    }
    if (matches.length > 1) {
      throw new ViewError(
        "ambiguous",
        `"${id}" is ambiguous: use ${matches
          .map((match) => `${match.type}:${match.id}`)
          .sort()
          .join(", ")}`,
      );
    }
    return matches[0];
  }

  /** How the newest run of an object ended, read from its ending fact. */
  private async lastRunEnd(type: string, id: string): Promise<ViewRunEnd | undefined> {
    if (this.log === undefined) return undefined;
    const runs = await this.log.runs({ object: objectKey(type, id) });
    let newest: RunInfo | undefined;
    for (const run of runs) if (newest === undefined || run.startedAt >= newest.startedAt) newest = run;
    if (newest === undefined || newest.active) return undefined;
    let found: ViewRunEnd | undefined;
    try {
      for await (const fact of this.log.read(newest.runId)) {
        if (fact.kind !== "run_ended") continue;
        const payload = fact.payload;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
        const status = payload.status;
        if (status !== "done" && status !== "failed" && status !== "cancelled") continue;
        const reason = payload.reason;
        found = {
          outcome: status,
          ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
          endedAt: fact.time,
        };
      }
    } catch (error) {
      this.onLog(`could not read how the run of "${type}:${id}" ended: ${messageOf(error)}`);
    }
    return found;
  }

  private async hasRun(type: string, id: string): Promise<boolean> {
    if (this.log === undefined) return false;
    const runs = await this.log.runs({ object: objectKey(type, id) });
    return runs.length > 0;
  }

  private guardedRow(
    plugin: string,
    type: string,
    object: StoredObject,
  ): ViewRow {
    const owner = this.registry.viewsFor(type);
    const views = owner?.views;
    if (views === undefined) {
      return this.errorRow(object.id, `no loaded plugin shows objects of type "${type}"`);
    }

    // A row is synchronous, so the clock cannot tell its own time from time
    // the process lost to the machine: a process descheduled between the two
    // reads makes a fast row look slow. A row over the limit is measured once
    // more, and is an error only when both times are over.
    let outcome: unknown;
    let elapsed = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = this.clock();
      try {
        outcome = views.row(object);
      } catch (error) {
        return this.failRow(plugin, object, error);
      }
      elapsed = this.clock() - started;
      if (elapsed <= this.rowTimeoutMs || isThenable(outcome)) break;
    }

    if (isThenable(outcome)) {
      Promise.resolve(outcome).catch(() => undefined);
      return this.failRow(
        plugin,
        object,
        new Error("row returned a Promise; row must be synchronous"),
      );
    }
    if (elapsed > this.rowTimeoutMs) {
      return this.failRow(
        plugin,
        object,
        new Error(`row took ${elapsed}ms; the limit is ${this.rowTimeoutMs}ms`),
      );
    }
    if (!isRecord(outcome)) {
      return this.failRow(plugin, object, new Error("row returned no row"));
    }
    const id = textOf(outcome.id);
    const title = textOf(outcome.title);
    const state = textOf(outcome.state);
    if (id === undefined || title === undefined || state === undefined) {
      return this.failRow(
        plugin,
        object,
        new Error("row must return { id, title, state, note? }"),
      );
    }
    const note = textOf(outcome.note);
    const wait = textOf(outcome.wait);
    const scope = textOf(outcome.scope);
    let mark: RowMark | undefined;
    if (outcome.mark !== undefined) {
      const found = ROW_MARKS.find((allowed) => allowed === outcome.mark);
      if (found === undefined) {
        return this.failRow(
          plugin,
          object,
          new Error(
            `row mark ${JSON.stringify(outcome.mark)} is not allowed; the marks are ${ROW_MARKS.join(", ")}`,
          ),
        );
      }
      mark = found;
    }
    const badge = outcome.badge;
    if (badge !== undefined) {
      if (
        typeof badge !== "string" ||
        /[\r\n]/.test(badge) ||
        Array.from(badge).length > ROW_BADGE_MAX
      ) {
        return this.failRow(
          plugin,
          object,
          new Error(
            `row badge must be a single line of at most ${ROW_BADGE_MAX} characters`,
          ),
        );
      }
    }
    const parent = outcome.parent;
    if (parent !== undefined && (typeof parent !== "string" || parent.length === 0)) {
      return this.failRow(
        plugin,
        object,
        new Error("row parent must be a non-empty object id"),
      );
    }
    const after = outcome.after;
    if (
      after !== undefined &&
      (!Array.isArray(after) ||
        Array.from(after).some((entry) => typeof entry !== "string" || entry.length === 0))
    ) {
      return this.failRow(
        plugin,
        object,
        new Error("row after must be an array of non-empty object ids"),
      );
    }
    return {
      id,
      title,
      state,
      ...(note === undefined ? {} : { note }),
      ...(wait === undefined ? {} : { wait }),
      ...(typeof parent === "string" ? { parent } : {}),
      ...(Array.isArray(after) ? { after: Array.from(after) } : {}),
      ...(scope === undefined ? {} : { scope }),
      ...(outcome.final === true ? { final: true } : {}),
      ...(mark === undefined ? {} : { mark }),
      ...(typeof badge === "string" ? { badge } : {}),
      waiting: outcome.waiting === true,
      running: false,
    };
  }

  private failRow(
    plugin: string,
    object: StoredObject,
    error: unknown,
  ): ViewRow {
    const message = messageOf(error);
    this.onLog(
      `plugin "${plugin}": row failed for "${object.type}:${object.id}": ${message}`,
    );
    return this.errorRow(object.id, message);
  }

  private errorRow(id: string, message: string): ViewRow {
    return {
      id,
      title: id,
      state: "error",
      note: message,
      waiting: false,
      running: false,
      error: message,
    };
  }

  private sectionDirectory(
    plugin: string,
    object: StoredObject,
  ): ViewSectionInfo[] {
    const views = this.registry.viewsFor(object.type)?.views;
    if (views === undefined) return [];
    const raw = views.sections(object);
    if (!Array.isArray(raw)) {
      throw new Error("sections must return an array");
    }
    const sections: ViewSectionInfo[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) {
        throw new Error("each section must be { id, title, live? }");
      }
      const id = textOf(entry.id);
      const title = textOf(entry.title);
      if (id === undefined || title === undefined) {
        throw new Error("each section must be { id, title, live? }");
      }
      if (id === HISTORY_SECTION) {
        this.onLog(
          `plugin "${plugin}": section "${HISTORY_SECTION}" is reserved; the kernel serves it`,
        );
        continue;
      }
      const live = entry.live;
      if (live !== undefined && typeof live !== "boolean") {
        throw new Error("section.live must be a boolean");
      }
      sections.push({ id, title, ...(live === true ? { live } : {}) });
    }
    return sections;
  }

  private viewContext(plugin: string, signal: AbortSignal): ViewContext {
    const log = this.log;
    // One read of the log's runs serves every run this view asks about.
    let runs: ReturnType<LogBackend["runs"]> | undefined;
    return {
      plugin,
      home: this.registry.home,
      cwd: this.cwd,
      store: this.store,
      facts: this.factsFor(`view:${plugin}`),
      logger: createPluginLogger(this.store.root, plugin, "views"),
      signal,
      settings: this.registry.settingsFor(plugin),
      settingsInForce: (name: string) => this.settingsInForce(name),
      refreshedObject: (type: string, id: string) =>
        this.refreshedObject(type, id),
      secrets: new FileSecretStore({ home: this.registry.home, plugin }),
      ...(log === undefined
        ? {}
        : {
            runTimes: (runId: string) => {
              runs ??= log.runs();
              return runTimes(log, runId, runs);
            },
          }),
    };
  }

  private factsFor(cause: string): FactWriter {
    return {
      append: (input) =>
        this.store.append({ ...input, cause: input.cause ?? cause }),
    };
  }

  private async flagsFor(type: string, id: string): Promise<RunFlags> {
    const flags = await this.allRunFlags();
    return flags.get(objectKey(type, id)) ?? { waiting: false, running: false };
  }

  private async allRunFlags(): Promise<Map<string, RunFlags>> {
    const flags = new Map<string, RunFlags>();
    if (this.log === undefined) return flags;
    const runs = await this.log.runs({ active: true });
    for (const run of runs) {
      const parsed = splitId(run.object);
      if (parsed === undefined) continue;
      let state;
      try {
        state = await readState(this.log, run.runId);
      } catch (error) {
        this.onLog(`run "${run.runId}": could not read its state: ${messageOf(error)}`);
        continue;
      }
      if (state.status === "ended") continue;
      const key = objectKey(parsed.type, parsed.id);
      const previous = flags.get(key) ?? { waiting: false, running: false };
      flags.set(key, {
        waiting: previous.waiting || state.status === "waiting_person",
        running:
          previous.running || state.status !== "waiting_person",
      });
    }
    return flags;
  }

  private async waitingRunId(
    type: string,
    id: string,
  ): Promise<string | undefined> {
    if (this.log === undefined) return undefined;
    const runs = await this.log.runs({ active: true });
    for (const run of runs) {
      if (run.object !== objectKey(type, id)) continue;
      try {
        const state = await readState(this.log, run.runId);
        if (state.status === "waiting_person") return run.runId;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async historyMarkdown(
    type: string,
    id: string,
    full: boolean,
  ): Promise<string> {
    const actions = this.personActions(type, id);
    const runs =
      this.log === undefined
        ? []
        : (await this.log.runs({ object: objectKey(type, id) }))
            .sort((left, right) => left.startedAt - right.startedAt);
    if (runs.length === 0 && actions.length === 0) return "No history yet.\n";

    const lines: string[] = [];
    if (actions.length > 0) {
      lines.push("## Person actions");
      for (const action of actions) lines.push(`- ${action}`);
      lines.push("");
    }
    for (const run of runs) {
      if (this.log === undefined) break;
      lines.push(`## ${run.flow} run · started ${localMinute(run.startedAt)}`);
      try {
        const facts: HistoryFact[] = [];
        for await (const fact of this.log.read(run.runId)) facts.push(fact);
        for (const line of runHistoryLines(facts, { now: this.clock(), full })) {
          lines.push(line.startsWith("**") ? line : `- ${line}`);
        }
      } catch (error) {
        lines.push(`- could not read this run: ${messageOf(error)}`);
      }
      lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  /** Every fact of one object, oldest first. */
  private objectFacts(type: string, id: string): readonly PluginFact[] {
    const facts: PluginFact[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = this.store.facts(
        { type, id },
        cursor === undefined ? {} : { cursor },
      );
      facts.push(...page.facts);
      if (page.next === undefined) return facts;
      cursor = page.next;
    }
  }

  /** The actions a person ran on an object, one line each, with who ran it. */
  private personActions(type: string, id: string): readonly string[] {
    const lines: string[] = [];
    for (const fact of this.objectFacts(type, id)) {
      if (fact.type !== ACTION_FACT) continue;
      lines.push(describeFact(fact));
    }
    return lines;
  }

  /**
   * What happened to an object in its own words: the actions people ran on it
   * and each change, oldest first. An object that never had a run still has
   * these.
   */
  async objectHistory(id: string): Promise<readonly string[]> {
    const resolved = await this.resolve(id);
    return this.objectFacts(resolved.type, resolved.id).map(describeFact);
  }

  /** The objects that changed most recently, newest first. */
  async recent(limit: number): Promise<readonly RecentObject[]> {
    const found: { readonly at: number; readonly entry: RecentObject }[] = [];
    for (const entry of this.registry.objectTypes()) {
      const owner = this.registry.viewsFor(entry.type);
      if (owner === undefined) continue;
      for (const object of await this.allObjects(entry.type)) {
        const row = this.guardedRow(owner.plugin, entry.type, object);
        found.push({
          at: object.at,
          entry: {
            type: entry.type,
            id: row.id,
            state: row.state,
            title: row.title,
          },
        });
      }
    }
    found.sort((left, right) => right.at - left.at);
    return found.slice(0, limit).map((item) => item.entry);
  }

  /** The ids nearest to a name that matched nothing, nearest first. */
  async closest(id: string, limit: number): Promise<readonly RecentObject[]> {
    const wanted = (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id)
      .toLowerCase();
    const scored: { readonly score: number; readonly entry: RecentObject }[] = [];
    for (const entry of this.registry.objectTypes()) {
      const owner = this.registry.viewsFor(entry.type);
      if (owner === undefined) continue;
      for (const object of await this.allObjects(entry.type)) {
        const row = this.guardedRow(owner.plugin, entry.type, object);
        const candidate = row.id.toLowerCase();
        const near = candidate.includes(wanted) || wanted.includes(candidate);
        scored.push({
          score: near ? 0 : editDistance(wanted, candidate),
          entry: {
            type: entry.type,
            id: row.id,
            state: row.state,
            title: row.title,
          },
        });
      }
    }
    scored.sort(
      (left, right) =>
        left.score - right.score || left.entry.id.localeCompare(right.entry.id),
    );
    return scored.slice(0, limit).map((item) => item.entry);
  }

  private async allObjects(type: string): Promise<readonly StoredObject[]> {
    const objects: StoredObject[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.store.list(
        type,
        cursor === undefined ? {} : { cursor },
      );
      objects.push(...page.objects);
      if (page.next === undefined) return objects;
      cursor = page.next;
    }
  }

  /** The line an action refusal prints: the plugin's reason, or a plain one. */
  private async refusal(
    target: { readonly action: ActionTypeDefinition; readonly info: ActionInfo },
    object: StoredObject,
    subject: string,
  ): Promise<string> {
    try {
      const why = await target.action.why?.(object, this.registry.actionEnv());
      if (why !== undefined && why.length > 0) return why;
    } catch (error) {
      this.onLog(`action "${target.info.name}": why failed: ${messageOf(error)}`);
    }
    return `${subject} cannot ${target.info.name} now`;
  }

  private async scopeShown(
    plugin: string,
    type: string,
    views: ObjectViews,
  ): Promise<boolean> {
    if (views.showScope === undefined) return false;
    try {
      const ctx = this.viewContext(plugin, new AbortController().signal);
      return (await views.showScope(ctx)) === true;
    } catch (error) {
      this.onLog(
        `plugin "${plugin}": showScope failed for "${type}": ${messageOf(error)}`,
      );
      return false;
    }
  }

  /**
   * Announces an object. A run's growth can arrive far faster than a client
   * can read it, so growth is announced at most once per object per window;
   * the last growth in a window is announced when the window ends. An object's
   * own stored change is always announced.
   */
  private publish(id: string, growth = false): void {
    if (growth) {
      const now = this.clock();
      const last = this.growthAnnouncedAt.get(id);
      if (last !== undefined && now - last < GROWTH_EVENT_INTERVAL_MS) {
        this.growthPending.add(id);
        this.scheduleGrowth(id, GROWTH_EVENT_INTERVAL_MS - (now - last));
        return;
      }
      this.growthPending.delete(id);
      this.clearGrowthTimer(id);
      this.growthAnnouncedAt.set(id, now);
    }
    this.announce(id);
  }

  private announce(id: string): void {
    for (const listener of this.eventListeners) listener(id);
  }

  /** Announces a held-back growth once its window has passed, or waits again. */
  private flushGrowth(id: string): void {
    if (!this.growthPending.has(id)) return;
    const now = this.clock();
    const last = this.growthAnnouncedAt.get(id);
    if (last !== undefined && now - last < GROWTH_EVENT_INTERVAL_MS) {
      this.scheduleGrowth(id, GROWTH_EVENT_INTERVAL_MS - (now - last));
      return;
    }
    this.growthPending.delete(id);
    this.clearGrowthTimer(id);
    this.growthAnnouncedAt.set(id, now);
    this.announce(id);
  }

  /** Announces every held-back growth whose window has passed by the clock. */
  private flushDueGrowth(): void {
    for (const id of [...this.growthPending]) {
      const last = this.growthAnnouncedAt.get(id);
      if (last === undefined || this.clock() - last >= GROWTH_EVENT_INTERVAL_MS) {
        this.flushGrowth(id);
      }
    }
  }

  /** The one timer per object that wakes a reader when its window ends. */
  private scheduleGrowth(id: string, waitMs: number): void {
    if (this.growthTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.growthTimers.delete(id);
      this.flushGrowth(id);
    }, Math.max(0, waitMs));
    this.growthTimers.set(id, timer);
  }

  private clearGrowthTimer(id: string): void {
    const timer = this.growthTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.growthTimers.delete(id);
  }
}

/** Builds the presentation API for a registry and its store. */
export function createViews(options: ViewsOptions): Views {
  return new Views(options);
}
