/**
 * The presentation kernel: the one API every client calls. It knows no plugin
 * name; it asks the loaded plugins for rows, sections and actions and adds the
 * flags and the history section the kernel itself owns.
 */

import { objectLink } from "../http/link.ts";
import type { LogBackend } from "../log/types.ts";
import { currentRunStep, endedRunStep } from "./running.ts";
import type { PluginRegistry, ActionInfo } from "../plugin/registry.ts";
import { splitActionName } from "../plugin/registry.ts";
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
import { ActionArgsError, noteProperty, validateActionArgs } from "../plugin/action-schema.ts";
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

/** A row as a client sees it: the plugin's row plus the kernel's two flags. */
export interface ViewRow {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly note?: string | undefined;
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
}

/** What one section read returns. */
export interface ViewSectionContent {
  readonly markdown: string;
  readonly next?: string | undefined;
  /** The section's table of contents, passed through from the plugin. */
  readonly pages?: readonly ViewSectionPage[] | undefined;
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

/** A presentation call cannot do what was asked. */
export class ViewError extends Error {
  readonly kind: ViewErrorKind;

  constructor(kind: ViewErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ViewError";
    this.kind = kind;
  }
}

export interface ViewsOptions {
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

/** One page of rows and where to continue. */
export interface ViewListPage {
  readonly rows: readonly ViewRow[];
  readonly next?: string | undefined;
  /** How many rows of the type the filter left out; absent without a filter or on `all`. */
  readonly hidden?: number | undefined;
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
}

export interface SectionOptions {
  /** Return the whole section, without the size cap. */
  readonly full?: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  private closed = false;
  private resume: (() => void) | undefined;

  constructor(max: number, listeners: Set<(id: string) => void>) {
    this.max = Math.max(1, max);
    this.listeners = listeners;
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
  private readonly eventListeners = new Set<(id: string) => void>();
  private readonly unsubscribe: (() => void)[] = [];
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
          this.publish(parsed.id);
        }),
      );
    }
  }

  /** Runs each object type's `prepare` once; a failure is tried again next time. */
  private prepared(): Promise<void> {
    if (this.preparing === undefined) {
      const running = (async () => {
        for (const entry of this.registry.objectTypes()) {
          await entry.definition.prepare?.({ store: this.store });
        }
      })();
      this.preparing = running;
      running.catch(() => {
        if (this.preparing === running) this.preparing = undefined;
      });
    }
    return this.preparing;
  }

  /** Closes the change listeners this view opened. */
  close(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
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
      ...(counted ? { hidden } : {}),
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
        else hidden += 1;
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
      waiting: flag.waiting,
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
      this.objectFacts(resolved.type, resolved.id).length === 0
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

    if (owner !== undefined && object !== undefined) {
      const { scope: _scope, ...guarded } = this.guardedRow(
        owner.plugin,
        resolved.type,
        object,
      );
      row = { ...guarded, ...flags };
      try {
        sections = this.sectionDirectory(owner.plugin, object);
      } catch (error) {
        this.onLog(
          `plugin "${owner.plugin}": sections failed for "${resolved.type}:${resolved.id}": ${messageOf(error)}`,
        );
        sections = [];
      }
      actions.push(...(await this.availableActions(resolved.type, object)));
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

    return {
      id: resolved.id,
      type: resolved.type,
      link: objectLink(resolved.type, resolved.id),
      row,
      sections,
      actions,
      ...(unavailable === undefined ? {} : { unavailable }),
    };
  }

  /** The Markdown of one section; `history` is served by the kernel. */
  async section(
    id: string,
    sectionId: string,
    cursor?: string,
    options: SectionOptions = {},
  ): Promise<ViewSectionContent> {
    const resolved = await this.resolve(id);
    if (sectionId === HISTORY_SECTION) {
      const markdown = await this.historyMarkdown(
        resolved.type,
        resolved.id,
        options.full === true,
      );
      return this.finishSection(
        id,
        sectionId,
        "History",
        markdown,
        undefined,
        options.full === true,
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
        owner.views.load(
          ctx,
          object,
          sectionId,
          cursor === undefined ? {} : { cursor },
        ),
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
    const finished = this.finishSection(
      id,
      section.id,
      section.title,
      markdown,
      next,
      options.full === true,
    );
    return pages === undefined ? finished : { ...finished, pages };
  }

  /** An async stream of ids that changed. Repeated ids coalesce. */
  events(): AsyncIterable<ViewEvent> {
    return new EventStream(this.maxEventIds, this.eventListeners);
  }

  /** Runs one action by `<plugin>:<action>`, honouring note and confirm. */
  async act(
    name: string,
    id: string | undefined,
    options: ActOptions,
  ): Promise<ViewActionRun> {
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

    const target = this.resolveAction(name, resolved.type);
    let holds: unknown;
    try {
      holds = await target.action.when(object.data);
    } catch (error) {
      this.onLog(
        `plugin "${target.plugin}": action "${target.action.name}": when failed: ${messageOf(error)}`,
      );
      throw new ViewError(
        "not-available",
        `action "${target.info.name}" is not available now`,
      );
    }
    if (holds !== true) {
      throw new ViewError("not-available", this.refusal(target, object));
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
        target.action.args,
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

    const runId = await this.waitingRunId(resolved.type, resolved.id);
    const result = await this.registry.runAction(
      `${target.plugin}/${target.action.name}`,
      personArgs,
      {
        object,
        ...(runId === undefined ? {} : { runId }),
        actor: options.actor,
        cwd: this.cwd,
      },
    );
    return {
      plugin: target.plugin,
      action: target.action.name,
      name: target.info.name,
      value: result.value,
    };
  }

  private finishSection(
    id: string,
    sectionId: string,
    _title: string,
    markdown: string,
    next: string | undefined,
    full: boolean,
  ): ViewSectionContent {
    if (full) {
      return {
        markdown,
        ...(next === undefined ? {} : { next }),
      };
    }
    const suffix = truncationNote(id, sectionId);
    const limit = this.sectionCapBytes;
    if (Buffer.byteLength(markdown, "utf8") <= limit) {
      return {
        markdown,
        ...(next === undefined ? {} : { next }),
      };
    }
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const body = capBytes(markdown, Math.max(0, limit - suffixBytes));
    return {
      markdown: `${body}${suffix}`,
      ...(next === undefined ? {} : { next }),
    };
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
        `no loaded plugin declares action "${name}"`,
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
      throw new ViewError("action", `no loaded plugin declares action "${name}"`);
    }
    return only;
  }

  private resolveAction(
    name: string,
    type: string,
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
      if (candidates.length === 0) {
        throw new ViewError(
          "action",
          `no loaded plugin declares action "${name}"`,
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
        throw new ViewError("action", `no loaded plugin declares action "${name}"`);
      }
      target = { plugin: only.plugin, action: only.action };
    }

    const info = this.registry
      .actions()
      .find(
        (entry) =>
          entry.name === `${target.plugin}:${target.action}` &&
          entry.on === type,
      );
    if (info === undefined) {
      throw new ViewError(
        "action",
        `action "${name}" is not available for objects of type "${type}"`,
      );
    }
    const found = this.actionDefinition(target.plugin, target.action, type);
    if (found === undefined) {
      throw new ViewError("action", `action "${name}" is not loaded`);
    }
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
    const actions: ViewAction[] = [];
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
        holds = await action.when(object.data);
      } catch (error) {
        this.onLog(
          `plugin "${info.plugin}": action "${info.action}": when failed: ${messageOf(error)}`,
        );
        continue;
      }
      if (holds !== true) continue;
      const key = keys.get(info.name);
      actions.push({
        ...info,
        ...(key === undefined ? {} : { key }),
      });
    }
    return actions;
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
    const seen = new Set(matches.map((match) => match.type));
    for (const fact of this.store.facts?.() ?? []) {
      const object = fact.object;
      if (object === undefined || object.id !== id) continue;
      if (seen.has(object.type)) continue;
      const stored = await this.store.get(object.type, object.id);
      seen.add(object.type);
      matches.push({ type: object.type, id, object: stored });
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

    if (this.log !== undefined) {
      const runs = await this.log.runs();
      const found = runs.find((run) => run.object === id);
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

  private async hasRun(type: string, id: string): Promise<boolean> {
    if (this.log === undefined) return false;
    const runs = await this.log.runs();
    return runs.some((run) => run.object === objectKey(type, id));
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

    const started = this.clock();
    let outcome: unknown;
    try {
      outcome = views.row(object);
    } catch (error) {
      return this.failRow(plugin, object, error);
    }
    const elapsed = this.clock() - started;

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
        after.some((entry) => typeof entry !== "string" || entry.length === 0))
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
      ...(typeof parent === "string" ? { parent } : {}),
      ...(Array.isArray(after) ? { after: [...after] } : {}),
      ...(scope === undefined ? {} : { scope }),
      ...(outcome.final === true ? { final: true } : {}),
      ...(mark === undefined ? {} : { mark }),
      ...(typeof badge === "string" ? { badge } : {}),
      waiting: false,
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
    return {
      plugin,
      home: this.registry.home,
      cwd: this.cwd,
      store: this.store,
      facts: this.factsFor(`view:${plugin}`),
      logger: createPluginLogger(this.store.root, plugin, "views"),
      signal,
      settings: this.registry.settingsFor(plugin),
      secrets: new FileSecretStore({ home: this.registry.home, plugin }),
      ...(log === undefined
        ? {}
        : {
            runStep: (runId: string) => currentRunStep(log, runId),
            runEnd: (runId: string) => endedRunStep(log, runId),
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
        : (await this.log.runs())
            .filter((run) => run.object === objectKey(type, id))
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
      lines.push(`<sub>run ${run.runId}</sub>`);
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
  private refusal(
    target: { readonly action: ActionTypeDefinition; readonly info: ActionInfo },
    object: StoredObject,
  ): string {
    try {
      const why = target.action.why?.(object);
      if (why !== undefined && why.length > 0) return why;
    } catch (error) {
      this.onLog(`action "${target.info.name}": why failed: ${messageOf(error)}`);
    }
    return `action "${target.info.name}" is not available now`;
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

  private publish(id: string): void {
    for (const listener of this.eventListeners) listener(id);
  }
}

/** Builds the presentation API for a registry and its store. */
export function createViews(options: ViewsOptions): Views {
  return new Views(options);
}
