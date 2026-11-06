/**
 * The presentation kernel: the one API every client calls. It knows no plugin
 * name; it asks the loaded plugins for rows, sections and actions and adds the
 * flags and the history section the kernel itself owns.
 */

import type { LogBackend } from "../log/types.ts";
import type { PluginRegistry, ActionInfo } from "../plugin/registry.ts";
import { splitActionName } from "../plugin/registry.ts";
import { messageOf } from "../plugin/errors.ts";
import { createPluginLogger } from "../plugin/logger.ts";
import { assertWhere, CursorError, WhereError } from "../plugin/paging.ts";
import { ActionArgsError, noteProperty, validateActionArgs } from "../plugin/action-schema.ts";
import type {
  ActionTypeDefinition,
  Actor,
  FactWriter,
  FactsOptions,
  FactsPage,
  ListOptions,
  PluginStore,
  StoredObject,
  ViewContext,
} from "../plugin/types.ts";
import { historyEntries, formatHistoryEntry } from "./history.ts";
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
  | "unavailable"
  | "note"
  | "confirm"
  | "args"
  | "where"
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
  /** Who asked; the CLI passes `{ via: "cli", id: <user> }`. */
  readonly actor: Actor;
}

/** One page of rows and where to continue. */
export interface ViewListPage {
  readonly rows: readonly ViewRow[];
  readonly next?: string | undefined;
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

/** The in-process presentation API. */
export class Views {
  private readonly registry: PluginRegistry;
  private readonly store: PluginStore;
  private readonly log: LogBackend | undefined;
  private readonly cwd: string;
  private readonly clock: () => number;
  private readonly rowTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly sectionCapBytes: number;
  private readonly maxEventIds: number;
  private readonly onLog: (message: string) => void;
  private readonly eventListeners = new Set<(id: string) => void>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(options: ViewsOptions) {
    this.registry = options.registry;
    this.store = options.store ?? options.registry.store;
    this.log = options.log;
    this.cwd = options.cwd ?? options.registry.workdir;
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

  /** Closes the change listeners this view opened. */
  close(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }

  /** One page of rows for a type, with the kernel's flags. */
  async list(type: string, options: ListOptions = {}): Promise<ViewListPage> {
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
    const rows: ViewRow[] = [];
    for (const object of page.objects) {
      const row = this.guardedRow(owner.plugin, type, object);
      const flag = flags.get(objectKey(type, object.id)) ?? {
        waiting: false,
        running: false,
      };
      rows.push({ ...row, waiting: flag.waiting, running: flag.running });
    }
    return { rows, ...(page.next === undefined ? {} : { next: page.next }) };
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
    const flags = await this.flagsFor(resolved.type, resolved.id);

    let row: ViewRow;
    let sections: ViewSectionInfo[] = [];
    const actions: ViewAction[] = [];
    let unavailable: string | undefined;

    if (owner !== undefined && object !== undefined) {
      row = { ...this.guardedRow(owner.plugin, resolved.type, object), ...flags };
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
      const markdown = await this.historyMarkdown(resolved.type, resolved.id);
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
    return this.finishSection(
      id,
      section.id,
      section.title,
      markdown,
      next,
      options.full === true,
    );
  }

  /** An async stream of ids that changed. Repeated ids coalesce. */
  events(): AsyncIterable<ViewEvent> {
    return new EventStream(this.maxEventIds, this.eventListeners);
  }

  /** Runs one action by `<plugin>:<action>`, honouring note and confirm. */
  async act(
    name: string,
    id: string,
    options: ActOptions,
  ): Promise<ViewActionRun> {
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
        "action",
        `action "${target.info.name}" is not available now`,
      );
    }
    if (holds !== true) {
      throw new ViewError(
        "action",
        `action "${target.info.name}" is not available now`,
      );
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
      throw new ViewError(
        "confirm",
        `action "${target.info.name}" needs confirmation; pass --yes`,
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
      .find((entry) => entry.name === `${target.plugin}:${target.action}`);
    if (info === undefined || info.on !== type) {
      throw new ViewError(
        "action",
        `action "${name}" is not available for objects of type "${type}"`,
      );
    }
    const found = this.actionDefinition(target.plugin, target.action);
    if (found === undefined) {
      throw new ViewError("action", `action "${name}" is not loaded`);
    }
    return { plugin: target.plugin, action: found, info };
  }

  private actionDefinition(
    pluginName: string,
    actionName: string,
  ): ActionTypeDefinition | undefined {
    return this.registry.actionDefinition(pluginName, actionName);
  }

  private async availableActions(
    type: string,
    object: StoredObject,
  ): Promise<readonly ViewAction[]> {
    const keys = new Map(this.registry.keyBindings().map((item) => [item.name, item.key]));
    const actions: ViewAction[] = [];
    for (const info of this.registry.actions()) {
      if (info.on !== type) continue;
      const action = this.registry.actionDefinition(info.plugin, info.action);
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
    const typed = splitId(id);
    if (typed !== undefined) {
      const object = await this.store.get(typed.type, typed.id);
      if (object !== undefined || (await this.hasRun(typed.type, typed.id))) {
        return { type: typed.type, id: typed.id, object };
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
    return {
      id,
      title,
      state,
      ...(note === undefined ? {} : { note }),
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
    return {
      plugin,
      home: this.registry.home,
      cwd: this.cwd,
      store: this.store,
      facts: this.factsFor(`view:${plugin}`),
      logger: createPluginLogger(this.store.root, plugin, "views"),
      signal,
    };
  }

  private factsFor(cause: string): FactWriter {
    return {
      append: (input) =>
        this.store.append(input.cause === undefined ? { ...input, cause } : input),
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

  private async historyMarkdown(type: string, id: string): Promise<string> {
    if (this.log === undefined) return "No history yet.\n";
    const runs = (await this.log.runs())
      .filter((run) => run.object === objectKey(type, id))
      .sort((left, right) => left.startedAt - right.startedAt);
    if (runs.length === 0) return "No history yet.\n";

    const lines: string[] = [];
    for (const run of runs) {
      lines.push(`## ${run.runId} (${run.flow})`);
      try {
        for await (const entry of historyEntries(this.log.read(run.runId))) {
          lines.push(`- ${formatHistoryEntry(entry)}`);
        }
      } catch (error) {
        lines.push(`- could not read this run: ${messageOf(error)}`);
      }
      lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  private publish(id: string): void {
    for (const listener of this.eventListeners) listener(id);
  }
}

/** Builds the presentation API for a registry and its store. */
export function createViews(options: ViewsOptions): Views {
  return new Views(options);
}
