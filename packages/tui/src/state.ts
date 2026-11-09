/**
 * The TUI's whole state and its one reducer. Every event is a client result, a
 * key or a resize; the reducer never fetches, never reads a clock and never
 * touches the terminal, so a test drives it as a plain value.
 */

import type {
  PendingItem,
  RowMark,
  RunningItem,
  ViewListPage,
  ViewAction,
  ViewObject,
  ViewRow,
  ViewSectionContent,
  ViewSectionInfo,
  ViewSectionPage,
} from "@operad-io/engine";
import type { TuiTypeInfo } from "./client.ts";
import { cachedLayout, layoutMarkdown, type LayoutLine } from "./layout.ts";
import { sanitize } from "./sanitize.ts";
import {
  actionFailed,
  bindingFor,
  confirmText,
  dropLast,
  fuzzyScore,
  inputKey,
  keyLabel,
  mainAction,
  mainKey,
  runKey,
  startAction,
  typed,
  isReserved,
  resolveBindings,
} from "./actions.ts";

/** The two terminal themes the view knows. */
export type TuiTheme = "light" | "dark";

/** What a tab lists. */
export type TuiTabKind = "pending" | "running" | "type";

/** The marker a row shows: one of the plugin's marks, or nothing. */
export type TuiMark = RowMark | "none";

/** The marks that stay when the kernel says a person waits; others draw `waiting`. */
const WAITING_KEEPS: readonly RowMark[] = [
  "waiting",
  "proposed",
  "rework_pending",
  "ready_to_merge",
];

/** One line of a list, in the words the view renders. */
export interface TuiRow {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly note?: string | undefined;
  readonly waiting: boolean;
  readonly running: boolean;
  /** The plugin's semantic mark, when the row carries one. */
  readonly mark?: RowMark | undefined;
  /** A short text shown after the state. */
  readonly badge?: string | undefined;
  /** Set on an error row; the view adds one red line under the row. */
  readonly error?: string | undefined;
  /** False for a row that names no object (a run, a candidate): it never opens. */
  readonly openable?: boolean | undefined;
}

/** One section of the open object, with the content fetched so far. */
export interface TuiSection {
  readonly id: string;
  readonly title: string;
  readonly live: boolean;
  readonly markdown: string;
  readonly next?: string | undefined;
  readonly loaded: boolean;
  readonly loading: boolean;
  /** The whole section has been fetched with `full=true`. */
  readonly full: boolean;
  /** The server cut the content at its size cap. */
  readonly capped: boolean;
  /** How many pages of content are in `markdown`; a refresh fetches as many. */
  readonly pages: number;
  readonly error?: string | undefined;
  /** The section's table of contents, when the plugin sent one. */
  readonly toc?: readonly ViewSectionPage[] | undefined;
  /** The index in `toc` of the first page `markdown` holds. */
  readonly pageStart: number;
  /** The first content line the pane shows. */
  readonly scroll: number;
  /** A live section keeps its end in view. */
  readonly following: boolean;
  /** Grows with each content change; an older answer is dropped. */
  readonly version: number;
}

/** The object the right pane shows, or the one that fills a narrow screen. */
export interface TuiObject {
  readonly id: string;
  /** The id of the list row it was opened from; the same row opens it once. */
  readonly source: string;
  readonly type: string;
  readonly link: string;
  readonly row: TuiRow;
  readonly sections: readonly TuiSection[];
  readonly active: number;
  /** The object response has not arrived yet; its row comes from the list. */
  readonly loading: boolean;
  /** The actions the object offers now, in the server's order. */
  readonly actions: readonly ViewAction[];
  readonly error?: string | undefined;
  readonly unavailable?: string | undefined;
  /** Grows with each open; an answer to an older open is dropped. */
  readonly version: number;
}

/** One key binding in force, from `GET /v1/keys`. */
export interface TuiBinding {
  readonly key: string;
  /** `<plugin>:<action>`. */
  readonly action: string;
  readonly source: "plugin" | "user";
}

/** What the keys type into: the `:` palette, a note, or a confirmation. */
export type TuiInput =
  | { readonly kind: "palette"; readonly query: string; readonly cursor: number }
  | { readonly kind: "pages"; readonly query: string; readonly cursor: number }
  | {
      readonly kind: "note";
      readonly action: string;
      readonly id: string;
      readonly text: string;
      readonly required: boolean;
      /** The action asks to confirm after the note. */
      readonly confirm: boolean;
    }
  | {
      readonly kind: "confirm";
      readonly action: string;
      readonly id: string;
      readonly note?: string | undefined;
    };

/** An action the reducer wants the caller to send with `POST /v1/act`. */
export interface TuiActionRequest {
  readonly action: string;
  readonly id: string;
  readonly note?: string | undefined;
  readonly confirmed?: boolean | undefined;
}

/** An object the reducer wants the caller to fetch. */
export interface TuiObjectRequest {
  readonly id: string;
  readonly version: number;
}

/** A section page the reducer wants the caller to fetch. */
export interface TuiSectionRequest {
  readonly objectId: string;
  readonly sectionId: string;
  readonly cursor?: string | undefined;
  /** The index in the table of contents of the page asked for; it replaces the text. */
  readonly jump?: number | undefined;
  readonly full: boolean;
  /** The section version the page was asked for. */
  readonly version: number;
  /** The open that asked: a page for an older open is dropped. */
  readonly objectVersion: number;
}

/** A list page the reducer wants the caller to fetch next. */
export interface TuiPageRequest {
  readonly tabId: string;
  readonly cursor: string;
  /** The list version the page was asked for; a newer list drops the answer. */
  readonly version: number;
}

/** The rows, cursor and paging state of one tab. */
export interface TuiList {
  readonly rows: readonly TuiRow[];
  readonly cursor: number;
  readonly next?: string | undefined;
  /** The first page has arrived. */
  readonly loaded: boolean;
  /** A next page is being fetched; a second request waits for its result. */
  readonly loading: boolean;
  /** A failed page fetch, kept until the next successful page. */
  readonly error?: string | undefined;
  /** Grows with each replace; an appended page for an older one is dropped. */
  readonly version: number;
  /** The filter changed and the rows of the new one have not arrived yet. */
  readonly switching?: boolean | undefined;
}

/** One tab: Pending, Running or one object type. */
export interface TuiTab {
  readonly id: string;
  readonly kind: TuiTabKind;
  /** The `/v1/types` name; set only for a type tab. */
  readonly type?: string | undefined;
  readonly title: string;
  readonly list: TuiList;
  /** The filters the type declares, in the server's order; unset without any. */
  readonly filters?: readonly TuiFilterInfo[] | undefined;
  /** The filter the list shows now; per tab, never saved. */
  readonly filter?: string | undefined;
  /** How many rows of the type the filter left out; unset on `all`. */
  readonly hidden?: number | undefined;
  /** How many times `f` cycled this tab's filter. */
  readonly filterSeq?: number | undefined;
}

/** One filter of a type: its name and the states it shows (`all` has none). */
export interface TuiFilterInfo {
  readonly name: string;
  readonly states?: readonly string[] | undefined;
}

/** The first page of a tab's list under a new filter, to be fetched. */
export interface TuiFilterRequest {
  readonly tabId: string;
  readonly filter: string;
  /** The tab's filter-cycle count when `f` was pressed; a later answer wins. */
  readonly seq: number;
}

/** Everything the view needs; nothing here is derived from a terminal handle. */
export interface TuiState {
  readonly tabs: readonly TuiTab[];
  readonly active: number;
  readonly width: number;
  readonly height: number;
  readonly theme: TuiTheme;
  /** The `?` key list is open. */
  readonly keys: boolean;
  readonly quit: boolean;
  /** `r` asked for a fresh set of lists; the caller clears it after fetching. */
  readonly refreshRequested: boolean;
  /** Set when `f` chose a filter and its first page must be fetched. */
  readonly filterRequest?: TuiFilterRequest | undefined;
  /** Set when the cursor nears the end of a list that has another page. */
  readonly pageRequest?: TuiPageRequest | undefined;
  /** The open object, if any. */
  readonly object?: TuiObject | undefined;
  /** The version of the next open; it never restarts, even after a close. */
  readonly objectVersion: number;
  /** Set when a row is opened and the caller must fetch the object. */
  readonly objectRequest?: TuiObjectRequest | undefined;
  /** Set when a section must be fetched. */
  readonly sectionRequest?: TuiSectionRequest | undefined;
  /** Grows each time a list cursor moves; the shell opens what it lands on. */
  readonly moveSeq: number;
  /** The cursor moved and the object pane has not followed it yet. */
  readonly followPending: boolean;
  /** Grows with each refresh; an answer to an older refresh is dropped. */
  readonly generation: number;
  /** The last failure to show in the footer; cleared by a good refresh. */
  readonly status?: string | undefined;
  /** The key bindings in force; a user binding beats a plugin default. */
  readonly bindings: readonly TuiBinding[];
  /** The palette, note or confirmation the keys are typing into. */
  readonly input?: TuiInput | undefined;
  /** One footer line (a refusal, or "not available") until the next key. */
  readonly notice?: string | undefined;
  /** Set when an action must be sent; the caller clears it as it sends. */
  readonly actionRequest?: TuiActionRequest | undefined;
  /** An action is on its way; a second one waits for the answer. */
  readonly acting: boolean;
  /** The server this screen talks to, named in the unreachable line. */
  readonly url?: string | undefined;
  /** Whether the server answers; the lists stay as they were when it does not. */
  readonly connection: TuiConnection;
}

/** What the last request said about the server. */
export type TuiConnection = "ok" | "unreachable" | "unauthorized";

/** The width at which the right pane appears. */
export const TWO_PANE_WIDTH = 100;

/** The number of rows from the end that make the reducer ask for a page. */
export const PAGE_AHEAD = 2;

/** Initial dimensions, matching a conventional 80 by 24 terminal. */
export const DEFAULT_WIDTH = 80;
export const DEFAULT_HEIGHT = 24;

export interface TuiStateOptions {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly theme?: TuiTheme | undefined;
  readonly url?: string | undefined;
}

function makeList(): TuiList {
  return {
    rows: [],
    cursor: 0,
    loaded: false,
    loading: false,
    version: 0,
  };
}

function makeTab(
  id: string,
  kind: TuiTabKind,
  title: string,
  type?: string,
  info?: TuiTypeInfo,
): TuiTab {
  const filters = filtersOf(info);
  const filter =
    filters === undefined
      ? undefined
      : (filters.find((f) => f.name === info?.defaultFilter) ?? filters[0])?.name;
  return {
    id,
    kind,
    ...(type === undefined ? {} : { type }),
    title,
    list: makeList(),
    ...(filters === undefined ? {} : { filters, filter }),
  };
}

function filtersOf(info: TuiTypeInfo | undefined): readonly TuiFilterInfo[] | undefined {
  const filters = info?.filters;
  return filters === undefined || filters.length === 0 ? undefined : filters;
}

/** The two fixed tabs; `/v1/types` adds the rest. */
export function initialState(options: TuiStateOptions = {}): TuiState {
  return {
    tabs: [
      makeTab("pending", "pending", "Pending"),
      makeTab("running", "running", "Running"),
    ],
    active: 0,
    width: Math.max(1, Math.trunc(options.width ?? DEFAULT_WIDTH)),
    height: Math.max(1, Math.trunc(options.height ?? DEFAULT_HEIGHT)),
    theme: options.theme ?? "dark",
    keys: false,
    quit: false,
    refreshRequested: false,
    objectVersion: 0,
    moveSeq: 0,
    followPending: false,
    generation: 0,
    bindings: [],
    acting: false,
    connection: "ok",
    ...(options.url === undefined ? {} : { url: options.url }),
  };
}

/** A short alias for callers that build the first state. */
export const createInitialState = initialState;

/** What the reducer accepts. */
export type TuiStateEvent =
  | {
      readonly type: "types";
      readonly types: readonly TuiTypeInfo[];
      readonly generation?: number | undefined;
    }
  | { readonly type: "filter-launched" }
  | {
      readonly type: "pending";
      readonly items: readonly PendingItem[];
      readonly generation?: number | undefined;
    }
  | {
      readonly type: "running";
      readonly items: readonly RunningItem[];
      readonly generation?: number | undefined;
    }
  | {
      readonly type: "page";
      readonly tabId: string;
      readonly page: ViewListPage;
      /** Replace the list instead of appending one page. */
      readonly replace?: boolean | undefined;
      /** The filter the page was asked under; a page for another one is dropped. */
      readonly filter?: string | undefined;
      /** The filter-cycle count it was asked under; an older one is dropped. */
      readonly filterSeq?: number | undefined;
      /** For a replace: the refresh it belongs to. */
      readonly generation?: number | undefined;
      /** For an append: the list version it was asked for. */
      readonly version?: number | undefined;
    }
  | {
      readonly type: "rows";
      readonly tabId: string;
      readonly rows: readonly ViewRow[];
      readonly next?: string | undefined;
      readonly replace?: boolean | undefined;
    }
  | {
      readonly type: "page-error";
      readonly tabId: string;
      readonly message: string;
      readonly version?: number | undefined;
    }
  /** One object arrived for an open request. */
  | {
      readonly type: "object";
      readonly object: ViewObject;
      readonly version?: number | undefined;
    }
  | {
      readonly type: "object-error";
      readonly id: string;
      readonly message: string;
      readonly version?: number | undefined;
    }
  /** One section arrived; `cursor` means its next page was appended. */
  | {
      readonly type: "section";
      readonly objectId: string;
      readonly sectionId: string;
      readonly content: ViewSectionContent;
      readonly cursor?: string | undefined;
      /** The table-of-contents index of a page that replaces the text. */
      readonly jump?: number | undefined;
      readonly full?: boolean | undefined;
      readonly version?: number | undefined;
      /** The open it was asked for; an older open drops it. */
      readonly objectVersion?: number | undefined;
      /** For a replace: how many pages the text holds. */
      readonly pages?: number | undefined;
    }
  | {
      readonly type: "section-error";
      readonly objectId: string;
      readonly sectionId: string;
      readonly message: string;
      readonly version?: number | undefined;
      readonly objectVersion?: number | undefined;
    }
  /** The debounce after a cursor move ended: open the row it landed on. */
  | { readonly type: "follow" }
  /** The caller launched the object request; it is asked for once. */
  | { readonly type: "object-launched" }
  /** The caller launched the section request; it is asked for once. */
  | { readonly type: "section-launched" }
  /** A refresh began; answers to the one before it are dropped. */
  | { readonly type: "refresh-start" }
  /** The caller launched the pending page request; it is asked for once. */
  | { readonly type: "page-launched" }
  /** Show a failure in the footer, or clear it with no message. */
  | {
      readonly type: "status";
      readonly message?: string | undefined;
      readonly generation?: number | undefined;
    }
  | {
      readonly type: "key";
      readonly key: string;
      /** The printable text the key types, when it types any. */
      readonly text?: string | undefined;
      readonly shift?: boolean | undefined;
      readonly ctrl?: boolean | undefined;
      readonly meta?: boolean | undefined;
    }
  | {
      readonly type: "resize";
      readonly width: number;
      readonly height: number;
      readonly theme?: TuiTheme | undefined;
    }
  | { readonly type: "theme"; readonly theme: TuiTheme }
  /** The key bindings in force arrived from `GET /v1/keys`. */
  | {
      readonly type: "keys";
      readonly bindings: readonly TuiBinding[];
      readonly generation?: number | undefined;
    }
  /** The caller sent the action request; it is sent once. */
  | { readonly type: "action-launched" }
  /** The action ran. */
  | { readonly type: "action-done" }
  /** The server refused the action; its status and message show as they came. */
  | {
      readonly type: "action-error";
      readonly message: string;
      readonly status?: number | undefined;
    }
  | { readonly type: "refreshed" }
  /** The server answered, or did not, or refused the token. */
  | { readonly type: "connection"; readonly connection: TuiConnection }
  /** One row was fetched again; it replaces the rows with its id in every list. */
  | { readonly type: "row"; readonly row: ViewRow }
  | { readonly type: "row-gone"; readonly id: string };

/** A duration as the Running list writes it. */
export function formatElapsed(ms: number): string {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (value < 1000) return `${Math.floor(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const whole = Math.floor(value / 1000);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

function rowId(row: ViewRow): string {
  return row.scope === undefined ? row.id : `${row.scope}/${row.id}`;
}

/** A `/v1/objects` row, unchanged except for the scope in its id. */
export function rowFromView(row: ViewRow): TuiRow {
  return {
    id: sanitize(rowId(row)),
    title: sanitize(row.title),
    state: sanitize(row.state),
    ...(row.note === undefined ? {} : { note: sanitize(row.note) }),
    waiting: row.waiting,
    running: row.running,
    ...(row.mark === undefined ? {} : { mark: row.mark }),
    ...(row.badge === undefined ? {} : { badge: sanitize(row.badge) }),
    ...(row.error === undefined ? {} : { error: sanitize(row.error) }),
  };
}

function rowFromPending(item: PendingItem): TuiRow {
  // A server that sends the object's row saves a read per item: the row names
  // the object, and the question stays visible as the note. An older server
  // sends no row, and the item shows its question and flow as before.
  if (item.row !== undefined) {
    return {
      id: sanitize(item.object ?? item.runId),
      title: sanitize(item.row.title),
      state: sanitize(item.row.state),
      note: sanitize(item.prompt),
      waiting: true,
      running: false,
      ...(item.row.mark === undefined ? {} : { mark: item.row.mark }),
      ...(item.row.badge === undefined ? {} : { badge: sanitize(item.row.badge) }),
      ...(item.row.error === undefined ? {} : { error: sanitize(item.row.error) }),
      ...(item.object === undefined ? { openable: false } : {}),
    };
  }
  return {
    id: sanitize(item.object ?? item.runId),
    title: sanitize(item.prompt),
    state: sanitize(item.flow),
    ...(item.step === null ? {} : { note: sanitize(item.step) }),
    waiting: true,
    running: false,
    ...(item.object === undefined ? { openable: false } : {}),
  };
}

function rowFromRunning(item: RunningItem): TuiRow {
  return {
    id: sanitize(item.object ?? item.runId),
    title: sanitize(
      item.object === null || item.object === undefined
        ? (item.title ?? item.flow)
        : item.title === null
          ? item.object
          : `${item.object}  ${item.title}`,
    ),
    state: sanitize(item.stepLabel ?? "-"),
    note: formatElapsed(item.stepElapsedMs ?? item.elapsedMs),
    waiting: false,
    running: true,
    openable: false,
  };
}

/** The marker a row puts in its first column. */
export function rowMark(row: TuiRow): TuiMark {
  if (row.waiting) {
    return row.mark !== undefined && WAITING_KEEPS.includes(row.mark)
      ? row.mark
      : "waiting";
  }
  if (row.mark !== undefined) return row.mark;
  if (row.running) return "running";
  return "none";
}

function clampCursor(list: TuiList): number {
  if (list.rows.length === 0) return 0;
  return Math.min(Math.max(0, list.cursor), list.rows.length - 1);
}

function withTab(state: TuiState, tabId: string, patch: (tab: TuiTab) => TuiTab): TuiState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.map((tab, at) => (at === index ? patch(tab) : tab));
  return { ...state, tabs };
}

function nearEnd(tab: TuiTab): boolean {
  const { list } = tab;
  if (list.rows.length === 0) return false;
  return list.cursor >= Math.max(0, list.rows.length - PAGE_AHEAD);
}

/** Sets one page request for a tab, and never a second while one is loading. */
function requestPage(state: TuiState, tab: TuiTab): TuiState {
  const { list } = tab;
  if (!nearEnd(tab) || list.next === undefined || list.loading) return state;
  if (state.pageRequest?.tabId === tab.id && state.pageRequest.cursor === list.next) {
    return state;
  }
  const updated = withTab(state, tab.id, (current) => ({
    ...current,
    list: { ...current.list, loading: true },
  }));
  return {
    ...updated,
    pageRequest: { tabId: tab.id, cursor: list.next, version: list.version },
  };
}

function activeTabOf(state: TuiState): TuiTab | undefined {
  return state.tabs[state.active];
}

/**
 * The rows a section's Markdown takes once wrapped to the pane, without its
 * trailing blank. `width` defaults to no wrapping for callers that only want
 * the renderer's own line count.
 */
export function markdownLineCount(
  markdown: string,
  width = Number.POSITIVE_INFINITY,
): number {
  return layoutMarkdown(
    markdown,
    Number.isFinite(width) ? width : undefined,
  ).length;
}

/**
 * The rows of a section at the pane's width. They are laid out once for each
 * content version of each open object and width, and kept: scrolling and
 * drawing read the same rows without wrapping the text again.
 */
export function sectionLayout(
  state: TuiState,
  section: TuiSection,
): readonly LayoutLine[] {
  const object = state.object;
  const key = `${object?.version ?? 0}\u0000${object?.id ?? ""}\u0000${section.id}`;
  return cachedLayout(
    key,
    section.version,
    section.markdown,
    sectionWidth(state),
  );
}

/** The layout's fixed columns (0-based): the list, its divider, the object pane. */
export const LIST_X = 1;
export const LIST_WIDTH = 35;
export const DIVIDER_X = LIST_X + LIST_WIDTH;
export const RIGHT_X = DIVIDER_X + 3;

/** The lines the body has: the header, its rule, the footer rule and the footer take four. */
export function bodyHeight(state: TuiState): number {
  return Math.max(1, state.height - 4);
}

/** How many Markdown lines fit under the object's title, state, tabs and rule. */
export function sectionViewport(state: TuiState): number {
  // title, state, a blank line, the section tabs, their rule and the hint line.
  return Math.max(1, bodyHeight(state) - 6);
}

/** The columns a section's Markdown has in the object pane. */
export function sectionWidth(state: TuiState): number {
  const start = twoPane(state) ? RIGHT_X : LIST_X;
  return Math.max(1, state.width - start - 1);
}

/** The section the object pane shows, if any. */
export function activeSection(state: TuiState): TuiSection | undefined {
  const object = state.object;
  return object === undefined ? undefined : object.sections[object.active];
}

function makeSection(info: ViewSectionInfo, previous?: TuiSection): TuiSection {
  const live = info.live === true;
  if (previous !== undefined && previous.id === info.id) {
    return { ...previous, title: info.title, live };
  }
  return {
    id: info.id,
    title: info.title,
    live,
    markdown: "",
    loaded: false,
    loading: false,
    full: false,
    capped: false,
    pages: 0,
    pageStart: 0,
    scroll: 0,
    following: live,
    version: 0,
  };
}

function withObject(state: TuiState, patch: (object: TuiObject) => TuiObject): TuiState {
  return state.object === undefined ? state : { ...state, object: patch(state.object) };
}

/** Rebuilds one section, keeping all the others as they are. */
function withSection(
  state: TuiState,
  sectionId: string,
  patch: (section: TuiSection) => TuiSection,
): TuiState {
  return withObject(state, (object) => ({
    ...object,
    sections: object.sections.map((section) =>
      section.id === sectionId ? patch(section) : section,
    ),
  }));
}

function bottomScroll(state: TuiState, section: TuiSection): number {
  return Math.max(0, sectionLayout(state, section).length - sectionViewport(state));
}

/** Asks for a section's first page or its next one, once. */
function requestSection(
  state: TuiState,
  index: number,
  options: {
    cursor?: string | undefined;
    jump?: number | undefined;
    full?: boolean | undefined;
    force?: boolean | undefined;
  } = {},
): TuiState {
  const object = state.object;
  const section = object?.sections[index];
  if (object === undefined || section === undefined) return state;
  const cursor = options.cursor;
  const full = options.full === true;
  if (
    options.force !== true &&
    cursor === undefined &&
    !full &&
    section.loaded
  ) {
    return state;
  }
  const current = state.sectionRequest;
  if (
    current !== undefined &&
    current.objectId === object.id &&
    current.sectionId === section.id &&
    current.cursor === cursor &&
    current.jump === options.jump &&
    current.full === full &&
    current.version === section.version &&
    current.objectVersion === object.version
  ) {
    return state;
  }
  const updated = withSection(state, section.id, (value) => ({
    ...value,
    loading: true,
    error: undefined,
  }));
  return {
    ...updated,
    sectionRequest: {
      objectId: object.id,
      sectionId: section.id,
      ...(cursor === undefined ? {} : { cursor }),
      ...(options.jump === undefined ? {} : { jump: options.jump }),
      full,
      version: section.version,
      objectVersion: object.version,
    },
  };
}

/** Selects a section tab and loads it if it has no content yet. */
function selectSection(state: TuiState, index: number): TuiState {
  const object = state.object;
  if (object === undefined || index < 0 || index >= object.sections.length) {
    return state;
  }
  if (index === object.active) return state;
  const moved = withObject(state, (value) => ({ ...value, active: index }));
  const section = object.sections[index];
  if (section === undefined || section.loaded) return moved;
  return requestSection(moved, index);
}

function moveSection(state: TuiState, delta: number): TuiState {
  const object = state.object;
  if (object === undefined || object.sections.length === 0) return state;
  const index = (object.active + delta + object.sections.length) % object.sections.length;
  return selectSection(state, index);
}

/** Opens the row under the list cursor. */
function openObject(state: TuiState): TuiState {
  const tab = activeTabOf(state);
  const row = tab?.list.rows[tab.list.cursor];
  if (row === undefined || row.openable === false) return state;
  const previous = state.object?.source === row.id ? state.object : undefined;
  const version = state.objectVersion + 1;
  const object: TuiObject = {
    id: row.id,
    source: row.id,
    type: previous?.type ?? (row.id.includes(":") ? row.id.slice(0, row.id.indexOf(":")) : row.id),
    link: previous?.link ?? "",
    row,
    // A request for the sections died with the old open, so none is loading.
    sections: (previous?.sections ?? []).map((section) => ({
      ...section,
      loading: false,
    })),
    active: previous?.active ?? 0,
    actions: previous?.actions ?? [],
    loading: true,
    version,
  };
  return {
    ...state,
    object,
    objectVersion: version,
    objectRequest: { id: row.id, version },
    sectionRequest: undefined,
  };
}

function closeObject(state: TuiState): TuiState {
  if (state.object === undefined) return state;
  return {
    ...state,
    object: undefined,
    objectRequest: undefined,
    sectionRequest: undefined,
  };
}

function applyObject(
  state: TuiState,
  view: ViewObject,
  version: number | undefined,
): TuiState {
  const previous = state.object;
  // A pane that was closed stays closed: a late answer never reopens it.
  if (previous === undefined) return state;
  if (
    version !== undefined &&
    version !== previous.version
  ) {
    return state;
  }
  const row = rowFromView(view.row);
  const oldSections = previous?.sections ?? [];
  const sections = view.sections.map((info) =>
    makeSection(
      { ...info, title: sanitize(info.title) },
      oldSections.find((section) => section.id === info.id),
    ),
  );
  const oldActive = previous?.sections[previous.active]?.id;
  const found =
    oldActive === undefined
      ? -1
      : sections.findIndex((section) => section.id === oldActive);
  const active =
    found >= 0
      ? found
      : Math.min(previous?.active ?? 0, Math.max(0, sections.length - 1));
  const object: TuiObject = {
    id: view.id,
    source: previous.source,
    type: view.type,
    link: view.link,
    row,
    sections,
    active,
    actions: view.actions,
    loading: false,
    ...(view.unavailable === undefined
      ? {}
      : { unavailable: sanitize(view.unavailable) }),
    version: previous?.version ?? version ?? 0,
  };
  let updated: TuiState = {
    ...state,
    object,
    objectRequest:
      state.objectRequest !== undefined &&
      (state.objectRequest.version === version ||
        state.objectRequest.version === previous?.version ||
        state.objectRequest.id === view.id)
        ? undefined
        : state.objectRequest,
    sectionRequest: undefined,
  };
  const section = sections[active];
  if (section !== undefined && !section.loaded) {
    updated = requestSection(updated, active);
  }
  return updated;
}

function applyObjectError(
  state: TuiState,
  id: string,
  message: string,
  version: number | undefined,
): TuiState {
  const object = state.object;
  if (object === undefined || object.id !== id) return state;
  if (version !== undefined && version !== object.version) return state;
  return {
    ...state,
    object: { ...object, loading: false, error: sanitize(message) },
    objectRequest: undefined,
    sectionRequest: undefined,
  };
}

/**
 * The line the server puts last when it cuts a section at its size cap
 * (`operad show <id> --section <section> --full`). Only that exact line, as the
 * last line, counts: the same words inside the text do not.
 */
const TRUNCATION_LINE =
  /^\[Truncated\. See all of it with `operad show .+ --section .+ --full`\.\]$/;

/** True when the text ends with the server's truncation line. */
export function isTruncated(markdown: string): boolean {
  const lines = markdown.split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return TRUNCATION_LINE.test(lines[lines.length - 1] ?? "");
}

/** Joins a page after the text before it. */
export function joinMarkdown(before: string, after: string): string {
  if (before.length === 0) return after;
  if (after.length === 0) return before;
  return `${before.replace(/\n?$/, "\n")}${after}`;
}

function applySection(
  state: TuiState,
  objectId: string,
  sectionId: string,
  content: ViewSectionContent,
  cursor: string | undefined,
  full: boolean,
  version: number | undefined,
  objectVersion: number | undefined,
  pages: number | undefined,
  jump: number | undefined,
): TuiState {
  const object = state.object;
  if (object === undefined || object.id !== objectId) return state;
  const section = object.sections.find((candidate) => candidate.id === sectionId);
  if (section === undefined) return state;
  if (version !== undefined && version !== section.version) return state;
  // A page asked for before the object was closed and opened again.
  if (objectVersion !== undefined && objectVersion !== object.version) return state;
  const appended = cursor !== undefined && jump === undefined;
  const markdown =
    !appended
      ? content.markdown
      : joinMarkdown(section.markdown, content.markdown);
  const capped = !full && isTruncated(markdown);
  const updated = withSection(state, sectionId, (value) => {
    const next: TuiSection = {
      ...value,
      markdown,
      next: content.next,
      loaded: true,
      loading: false,
      full: full || value.full,
      capped,
      pages: appended ? value.pages + 1 : (pages ?? 1),
      pageStart: jump ?? (appended ? value.pageStart : 0),
      ...(content.pages === undefined ? {} : { toc: content.pages }),
      error: undefined,
      version: value.version + 1,
    };
    const bottom = bottomScroll(state, next);
    if (jump !== undefined) return { ...next, scroll: 0, following: false };
    return {
      ...next,
      scroll: next.following ? bottom : Math.min(value.scroll, bottom),
    };
  });
  return {
    ...updated,
    sectionRequest:
      state.sectionRequest?.sectionId === sectionId ? undefined : state.sectionRequest,
  };
}

function applySectionError(
  state: TuiState,
  objectId: string,
  sectionId: string,
  message: string,
  version: number | undefined,
  objectVersion: number | undefined,
): TuiState {
  const object = state.object;
  const section = object?.sections.find((candidate) => candidate.id === sectionId);
  if (object === undefined || object.id !== objectId || section === undefined) {
    return state;
  }
  if (version !== undefined && version !== section.version) return state;
  if (objectVersion !== undefined && objectVersion !== object.version) return state;
  const updated = withSection(state, sectionId, (value) => ({
    ...value,
    loading: false,
    error: sanitize(message),
  }));
  return {
    ...updated,
    sectionRequest:
      state.sectionRequest?.sectionId === sectionId ? undefined : state.sectionRequest,
  };
}

/** Scrolls the open section; a page can ask for the section's next page. */
function scrollSection(state: TuiState, delta: number): TuiState {
  const object = state.object;
  const section = activeSection(state);
  if (object === undefined || section === undefined) return state;
  const bottom = bottomScroll(state, section);
  const start = section.following ? bottom : section.scroll;
  const next = Math.min(bottom, Math.max(0, start + delta));
  const following = delta < 0 ? false : section.live && next >= bottom;
  const moved = withSection(state, section.id, (value) => ({
    ...value,
    scroll: next,
    following,
  }));
  if (
    delta > 0 &&
    next >= bottom &&
    section.next !== undefined &&
    !section.loading
  ) {
    return requestSection(moved, object.active, { cursor: section.next });
  }
  return moved;
}

/** The page of the open section's table of contents the text ends in. */
export function currentPage(section: TuiSection): number {
  return section.pageStart + Math.max(1, section.pages) - 1;
}

/** "page 3/27 · docs/manual.md" for a section with a table of contents. */
export function pagePosition(section: TuiSection | undefined): string | undefined {
  const toc = section?.toc;
  if (section === undefined || toc === undefined || toc.length === 0 || !section.loaded) {
    return undefined;
  }
  const at = Math.min(currentPage(section), toc.length - 1);
  return `page ${at + 1}/${toc.length} · ${toc[at]?.label ?? ""}`;
}

/** Loads page `index` of the open section's table of contents and shows it at the top. */
function loadPage(state: TuiState, index: number): TuiState {
  const object = state.object;
  const section = activeSection(state);
  const page = section?.toc?.[index];
  if (object === undefined || page === undefined) return state;
  return requestSection(state, object.active, {
    jump: index,
    force: true,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  });
}

/** `n` and `N`: the next or previous page; the ends stay where they are. */
function stepPage(state: TuiState, delta: number): TuiState {
  const section = activeSection(state);
  const toc = section?.toc;
  if (section === undefined || toc === undefined || toc.length === 0 || section.loading) {
    return state;
  }
  const target = currentPage(section) + delta;
  if (target < 0) return { ...state, notice: "first page" };
  if (target >= toc.length) return { ...state, notice: "last page" };
  return loadPage(state, target);
}

/** `p`: the page picker, when the open section has pages; otherwise nothing. */
function openPagePicker(state: TuiState): TuiState {
  const toc = activeSection(state)?.toc;
  if (toc === undefined || toc.length === 0 || state.keys) return state;
  return { ...state, input: { kind: "pages", query: "", cursor: 0 } };
}

/** One line of the page picker: a page of the table of contents. */
export interface TuiPageEntry {
  readonly label: string;
  /** Its index in the table of contents. */
  readonly index: number;
}

/** The picker's lines for the typed query, best match first. */
export function pageEntries(state: TuiState): readonly TuiPageEntry[] {
  const toc = activeSection(state)?.toc ?? [];
  const query = state.input?.kind === "pages" ? state.input.query : "";
  return toc
    .map((page, index) => ({ label: page.label, index, score: fuzzyScore(query, page.label) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ label, index }) => ({ label, index }));
}

/** A key arrives while the page picker is open. */
function pagesKey(
  state: TuiState,
  input: Extract<TuiInput, { readonly kind: "pages" }>,
  event: { key: string; text?: string | undefined; ctrl?: boolean | undefined; meta?: boolean | undefined },
): TuiState {
  const key = event.key.toLowerCase();
  if (key === "escape" || key === "esc") return { ...state, input: undefined };
  const entries = pageEntries(state);
  const down = key === "down" || key === "arrowdown" || (event.ctrl === true && (key === "n" || key === "j"));
  const up = key === "up" || key === "arrowup" || (event.ctrl === true && (key === "p" || key === "k"));
  if (down || up) {
    const cursor = Math.min(
      Math.max(0, input.cursor + (down ? 1 : -1)),
      Math.max(0, entries.length - 1),
    );
    return { ...state, input: { ...input, cursor } };
  }
  if (key === "enter" || key === "return") {
    const chosen = entries[Math.min(input.cursor, entries.length - 1)];
    if (chosen === undefined) return state;
    return loadPage({ ...state, input: undefined }, chosen.index);
  }
  if (key === "backspace") {
    return { ...state, input: { ...input, query: dropLast(input.query), cursor: 0 } };
  }
  const text = event.ctrl === true || event.meta === true ? undefined : typed(event);
  return text === undefined
    ? state
    : { ...state, input: { ...input, query: input.query + text, cursor: 0 } };
}

function jumpSection(state: TuiState, to: "top" | "bottom"): TuiState {
  const object = state.object;
  const section = activeSection(state);
  if (object === undefined || section === undefined) return state;
  const bottom = bottomScroll(state, section);
  const moved = withSection(state, section.id, (value) => ({
    ...value,
    scroll: to === "top" ? 0 : bottom,
    following: to === "bottom" && value.live,
  }));
  if (
    to === "bottom" &&
    section.next !== undefined &&
    !section.loading
  ) {
    return requestSection(moved, object.active, { cursor: section.next });
  }
  return moved;
}


function move(state: TuiState, delta: number): TuiState {
  const tab = activeTabOf(state);
  if (tab === undefined || tab.list.rows.length === 0) return state;
  const next = clampCursor({
    ...tab.list,
    cursor: tab.list.cursor + delta,
  });
  if (next === tab.list.cursor) {
    // At the last row a further Down still asks for the page the previous
    // failed attempt or the end of the loaded rows left unread.
    return delta > 0 ? requestPage(state, tab) : state;
  }
  const moved = moveCursor(state, tab.id, next);
  const updated = activeTabOf(moved);
  return updated === undefined ? moved : requestPage(moved, updated);
}

/** Moves a tab's cursor; the object pane follows it after the shell's debounce. */
function moveCursor(state: TuiState, tabId: string, cursor: number): TuiState {
  const moved = withTab(state, tabId, (current) => ({
    ...current,
    list: { ...current.list, cursor },
  }));
  return { ...moved, moveSeq: state.moveSeq + 1, followPending: true };
}

function jump(state: TuiState, to: "top" | "bottom"): TuiState {
  const tab = activeTabOf(state);
  if (tab === undefined) return state;
  const cursor = to === "top" ? 0 : Math.max(0, tab.list.rows.length - 1);
  if (cursor === tab.list.cursor) return state;
  const moved = moveCursor(state, tab.id, cursor);
  const updated = activeTabOf(moved);
  return updated === undefined ? moved : requestPage(moved, updated);
}

function activate(state: TuiState, index: number): TuiState {
  if (index < 0 || index >= state.tabs.length || index === state.active) return state;
  // Another tab is another list: the object of the old one closes.
  return closeObject({ ...state, active: index, followPending: false });
}

/** The row the active list's cursor is on, if it can be opened. */
function selectedRow(state: TuiState): TuiRow | undefined {
  const tab = activeTabOf(state);
  const row = tab?.list.rows[tab.list.cursor];
  return row === undefined || row.openable === false ? undefined : row;
}

/** Enter: opens the selected row; on the row that is already open, nothing. */
function enter(state: TuiState): TuiState {
  const row = selectedRow(state);
  if (row === undefined) return state;
  const open = state.object;
  if (open !== undefined && open.source === row.id && open.error === undefined) {
    return { ...state, followPending: false };
  }
  return openObject({ ...state, followPending: false });
}

/**
 * The debounce after a cursor move ended: with the object pane beside the list,
 * the pane shows the row the cursor is on. A narrow screen opens nothing by
 * itself.
 */
function follow(state: TuiState): TuiState {
  if (!state.followPending) return state;
  const cleared = { ...state, followPending: false };
  if (!twoPane(cleared)) return cleared;
  const row = selectedRow(cleared);
  if (row === undefined) return cleared;
  if (cleared.object?.source === row.id) return cleared;
  return openObject(cleared);
}

function cycle(state: TuiState, delta: number): TuiState {
  if (state.tabs.length === 0) return state;
  const index = (state.active + delta + state.tabs.length) % state.tabs.length;
  return activate(state, index);
}

function isKey(key: string, ...names: string[]): boolean {
  const lowered = key.toLowerCase();
  return names.some((name) => lowered === name.toLowerCase());
}

/** The name keys.json uses for a key: `enter` and `escape`, however the terminal names them. */
function bindingLabel(label: string): string {
  const lowered = label.toLowerCase();
  if (lowered === "return") return "enter";
  if (lowered === "esc") return "escape";
  return label;
}

function handleKey(
  state: TuiState,
  event: {
    key: string;
    text?: string | undefined;
    shift?: boolean | undefined;
    ctrl?: boolean | undefined;
    meta?: boolean | undefined;
  },
): TuiState {
  const typing = state.input;
  const calm = state.notice === undefined ? state : { ...state, notice: undefined };
  if (typing?.kind === "pages") return pagesKey(calm, typing, event);
  if (typing !== undefined) return inputKey(calm, typing, event);
  // Ctrl-C is the renderer's exit; no other chord is ours.
  if (event.ctrl === true || event.meta === true) return calm;
  state = calm;
  const key = event.key;
  const shift = event.shift === true;
  const label = keyLabel(key, shift);
  // Reserved keys were dropped from the bindings; the rest, a user binding
  // first, run their action.
  const own = isReserved(label)
    ? undefined
    : bindingFor(state.bindings, bindingLabel(label));
  // The key list closes first, so the action acts on what the person sees.
  if (own !== undefined) return startAction({ ...state, keys: false }, own.action);
  if (key === ":" && !state.keys) {
    return { ...state, input: { kind: "palette", query: "", cursor: 0 } };
  }
  if (key === "?" || (key === "/" && shift)) {
    return { ...state, keys: !state.keys };
  }
  if (isKey(key, "q")) return { ...state, quit: true };
  if (state.keys) {
    // The list behind the key list is hidden, so no other key acts on it.
    return isKey(key, "escape", "esc") ? { ...state, keys: false } : state;
  }
  if (isKey(key, "enter", "return")) return enter(state);
  if (isKey(key, "escape", "esc")) {
    return closeObject({ ...state, followPending: false });
  }
  if (isKey(key, "[", "left", "arrowleft")) return moveSection(state, -1);
  if (isKey(key, "]", "right", "arrowright")) return moveSection(state, 1);
  const object = state.object;
  if (object !== undefined) {
    // The pane scrolls by page in both layouts; only on a narrow screen, where
    // the object fills the screen, do the list keys scroll it by line.
    const page = Math.max(1, sectionViewport(state) - 1);
    if (isKey(key, "pageup", "page-up", "prior", "b")) return scrollSection(state, -page);
    if (isKey(key, "pagedown", "page-down", "next", "space", " ")) {
      return scrollSection(state, page);
    }
    if (isKey(key, "home")) return jumpSection(state, "top");
    if (isKey(key, "end")) return jumpSection(state, "bottom");
    if (isKey(key, "p")) return openPagePicker(state);
    if (isKey(key, "n")) return stepPage(state, shift ? -1 : 1);
    if (isKey(key, "f")) {
      const section = activeSection(state);
      if (section !== undefined && section.capped && !section.full) {
        const at = section.pageStart;
        const cursor = section.toc?.[at]?.cursor;
        return requestSection(
          state,
          object.active,
          section.toc === undefined || at === 0
            ? { full: true }
            : { full: true, jump: at, force: true, ...(cursor === undefined ? {} : { cursor }) },
        );
      }
      return filterKeyApplies(state) ? cycleFilter(state) : state;
    }
    if (!twoPane(state)) {
      if (isKey(key, "up", "arrowup", "k")) return scrollSection(state, -1);
      if (isKey(key, "down", "arrowdown", "j")) return scrollSection(state, 1);
      if (key === "G" || (isKey(key, "g") && shift)) return jumpSection(state, "bottom");
      if (isKey(key, "g")) return jumpSection(state, "top");
    }
  }
  if (isKey(key, "f")) return cycleFilter(state);
  // A rotated token is not retried: the person runs the TUI again.
  if (isKey(key, "r") && state.connection === "unauthorized") return state;
  if (isKey(key, "r")) {
    const retry = { ...state, refreshRequested: true };
    const object = state.object;
    const section = object?.sections[object.active];
    // A section that failed to load asks again; the others refresh with the lists.
    return object !== undefined && section?.error !== undefined && !section.loading
      ? requestSection(retry, object.active, { force: true })
      : retry;
  }
  if (isKey(key, "tab")) return cycle(state, shift ? -1 : 1);
  if (isKey(key, "up", "arrowup", "k")) return move(state, -1);
  if (isKey(key, "down", "arrowdown", "j")) return move(state, 1);
  if (key === "G" || (isKey(key, "g") && shift)) return jump(state, "bottom");
  if (isKey(key, "g")) return jump(state, "top");
  if (/^[1-9]$/.test(key)) return activate(state, Number(key) - 1);
  return runKey(state, label) ?? state;
}

/** The filters are shown and `f` cycles them: the list is on screen. */
function filterKeyApplies(state: TuiState): boolean {
  const tab = activeTabOf(state);
  if (tab?.filters === undefined) return false;
  return state.object === undefined || twoPane(state);
}

/** `f`: the next filter of the type tab, its first page fetched again. */
function cycleFilter(state: TuiState): TuiState {
  const tab = activeTabOf(state);
  const filters = tab?.filters;
  if (tab === undefined || filters === undefined || filters.length === 0) return state;
  const at = filters.findIndex((f) => f.name === tab.filter);
  const next = filters[(at + 1) % filters.length]?.name;
  if (next === undefined || next === tab.filter) return state;
  const changed = withTab(state, tab.id, (current) => ({
    ...current,
    filter: next,
    filterSeq: (current.filterSeq ?? 0) + 1,
    hidden: undefined,
    // The rows stay until the new ones arrive; a page of the old filter is
    // dropped by its version, and its paging cursor is no longer valid.
    list: {
      ...current.list,
      next: undefined,
      loading: false,
      switching: true,
      version: current.list.version + 1,
    },
  }));
  const quiet =
    changed.pageRequest?.tabId === tab.id ? { ...changed, pageRequest: undefined } : changed;
  return {
    ...quiet,
    filterRequest: { tabId: tab.id, filter: next, seq: (tab.filterSeq ?? 0) + 1 },
  };
}

/** What the header adds after the current type tab: the filter and what it hides. */
export function filterHeader(
  tab: TuiTab | undefined,
): { readonly filter: string; readonly hidden: string } | undefined {
  if (tab?.kind !== "type" || tab.filters === undefined || tab.filter === undefined) {
    return undefined;
  }
  const hidden =
    tab.filter !== "all" && (tab.hidden ?? 0) > 0 ? ` · ${tab.hidden} hidden` : "";
  return { filter: ` · ${tab.filter}`, hidden };
}

function typeTitle(type: TuiTypeInfo): string {
  return type.title.length === 0 ? type.type : type.title;
}

function applyTypes(state: TuiState, types: readonly TuiTypeInfo[]): TuiState {
  const fixed = state.tabs.filter((tab) => tab.kind !== "type");
  const existing = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const seen = new Set<string>();
  const typeTabs: TuiTab[] = [];
  for (const info of types) {
    if (seen.has(info.type)) continue;
    seen.add(info.type);
    const id = `type:${info.type}`;
    const old = existing.get(id);
    if (old === undefined) {
      typeTabs.push(makeTab(id, "type", typeTitle(info), info.type, info));
      continue;
    }
    // A known tab keeps its chosen filter while the type still declares it.
    const fresh = makeTab(id, "type", old.title, info.type, info);
    const kept = fresh.filters?.some((f) => f.name === old.filter) === true;
    typeTabs.push({
      ...old,
      filters: fresh.filters,
      filter: kept ? old.filter : fresh.filter,
    });
  }
  const tabs = [...fixed, ...typeTabs];
  const activeId = state.tabs[state.active]?.id;
  const found = tabs.findIndex((tab) => tab.id === activeId);
  return {
    ...state,
    tabs,
    active: found < 0 ? Math.min(state.active, Math.max(0, tabs.length - 1)) : found,
  };
}

/** Keeps the cursor on the same object when the rows are replaced. */
function cursorAfterReplace(old: TuiList, rows: readonly TuiRow[]): number {
  const selected = old.rows[old.cursor]?.id;
  if (selected !== undefined) {
    const found = rows.findIndex((row) => row.id === selected);
    if (found >= 0) return found;
  }
  // A new filter that hides the selection starts at the top; a live refresh
  // keeps the place, which is the next row.
  if (old.switching === true) return 0;
  return clampCursor({ ...old, rows });
}

/** True when two ids name one object, with or without scope or type. */
export function sameObject(a: string, b: string): boolean {
  if (a === b) return true;
  const tail = (id: string): string => id.slice(Math.max(id.lastIndexOf(":"), id.lastIndexOf("/")) + 1);
  return tail(a) !== "" && tail(a) === tail(b);
}

/** Puts a fresh row in place of the rows of the same object; the cursor stays. */
function replaceRow(state: TuiState, row: TuiRow): TuiState {
  let changed = false;
  let selectedLeft = false;
  const tabs = state.tabs.map((tab, index) => {
    if (tab.kind !== "type") return tab;
    const states = tab.filters?.find((f) => f.name === tab.filter)?.states;
    const at = tab.list.rows.findIndex((old) => sameObject(old.id, row.id));
    if (
      at >= 0 &&
      states !== undefined &&
      row.state !== "error" &&
      !states.includes(row.state)
    ) {
      // The object no longer matches the filter: it leaves the list, and the
      // cursor keeps its place, which is now the next row.
      changed = true;
      if (index === state.active && at === tab.list.cursor) selectedLeft = true;
      const rows = tab.list.rows.filter((_, i) => i !== at);
      const cursor = Math.min(tab.list.cursor, Math.max(0, rows.length - 1));
      return {
        ...tab,
        hidden: (tab.hidden ?? 0) + 1,
        list: { ...tab.list, rows, cursor },
      };
    }
    const rows = tab.list.rows.map((old) => {
      if (!sameObject(old.id, row.id)) return old;
      changed = true;
      return row;
    });
    return changed && rows.some((r, i) => r !== tab.list.rows[i])
      ? { ...tab, list: { ...tab.list, rows } }
      : tab;
  });
  if (!changed) return state;
  const next = { ...state, tabs };
  return selectedLeft
    ? { ...next, moveSeq: next.moveSeq + 1, followPending: true }
    : next;
}

/** Drops the row of an object that is gone from the server. */
function removeRow(state: TuiState, id: string): TuiState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.kind !== "type") return tab;
    const at = tab.list.rows.findIndex((row) => sameObject(row.id, id));
    if (at < 0) return tab;
    changed = true;
    const rows = tab.list.rows.filter((_, i) => i !== at);
    const cursor = Math.min(tab.list.cursor, Math.max(0, rows.length - 1));
    return { ...tab, list: { ...tab.list, rows, cursor } };
  });
  return changed ? { ...state, tabs } : state;
}

function replaceRows(
  tab: TuiTab,
  rows: readonly TuiRow[],
  next: string | undefined,
): TuiTab {
  const cursor = cursorAfterReplace(tab.list, rows);
  return {
    ...tab,
    list: {
      ...tab.list,
      rows,
      cursor,
      next,
      loaded: true,
      // The page that was in flight for the old rows is dropped when it lands.
      loading: false,
      error: undefined,
      switching: undefined,
      version: tab.list.version + 1,
    },
  };
}

function clearRequest(before: TuiState, after: TuiState, tabId: string): TuiState {
  return before.pageRequest?.tabId === tabId
    ? { ...after, pageRequest: undefined }
    : after;
}

function applyPending(state: TuiState, items: readonly PendingItem[]): TuiState {
  const rows = items.map(rowFromPending);
  return withTab(state, "pending", (tab) => replaceRows(tab, rows, undefined));
}

function applyRunning(state: TuiState, items: readonly RunningItem[]): TuiState {
  const rows = items.map(rowFromRunning);
  return withTab(state, "running", (tab) => replaceRows(tab, rows, undefined));
}

function appendPage(
  state: TuiState,
  tabId: string,
  rows: readonly TuiRow[],
  next: string | undefined,
  replace: boolean,
  version: number | undefined,
  filter?: string | undefined,
  hidden?: number | undefined,
  filterSeq?: number | undefined,
): TuiState {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) return state;
  if (filterSeq !== undefined && filterSeq !== (tab.filterSeq ?? 0)) return state;
  if (!replace && version !== undefined && version !== tab.list.version) {
    return state;
  }
  // An answer to a filter that is no longer the chosen one is never shown.
  if (filter !== undefined && tab.filter !== undefined && filter !== tab.filter) {
    return state;
  }
  const wasSwitching = replace && tab.list.switching === true;
  const selected = tab.list.rows[tab.list.cursor]?.id;
  const updated = withTab(state, tabId, (current) => {
    if (replace) return { ...replaceRows(current, rows, next), hidden };
    const list: TuiList = {
      ...current.list,
      rows: [...current.list.rows, ...rows],
      loaded: true,
      loading: false,
      next,
      error: undefined,
    };
    return {
      ...current,
      ...(hidden === undefined ? {} : { hidden }),
      list: { ...list, cursor: clampCursor(list) },
    };
  });
  const cleared = clearRequest(state, updated, tabId);
  if (!wasSwitching) return cleared;
  // The new filter moved the selection: the object pane follows it.
  const after = cleared.tabs.find((candidate) => candidate.id === tabId);
  if (after === undefined || after.list.rows[after.list.cursor]?.id === selected) {
    return cleared;
  }
  if (cleared.tabs[cleared.active]?.id !== tabId) return cleared;
  if (after.list.rows.length === 0) return closeObject(cleared);
  return { ...cleared, moveSeq: cleared.moveSeq + 1, followPending: true };
}

function applyPageError(
  state: TuiState,
  tabId: string,
  message: string,
  version: number | undefined,
): TuiState {
  const current = state.tabs.find((candidate) => candidate.id === tabId);
  if (current === undefined) return state;
  if (version !== undefined && version !== current.list.version) return state;
  const updated = withTab(state, tabId, (tab) => ({
    ...tab,
    list: { ...tab.list, loading: false, error: sanitize(message) },
  }));
  if (updated === state) return state;
  if (state.pageRequest?.tabId === tabId) {
    return { ...updated, pageRequest: undefined };
  }
  return updated;
}

/** An answer to a refresh that is no longer the current one. */
function stale(state: TuiState, generation: number | undefined): boolean {
  return generation !== undefined && generation !== state.generation;
}

/** The pure reducer: the same state and event always give the same state. */
export function reduce(state: TuiState, event: TuiStateEvent): TuiState {
  switch (event.type) {
    case "types":
      return stale(state, event.generation)
        ? state
        : applyTypes(state, event.types);
    case "pending":
      return stale(state, event.generation)
        ? state
        : applyPending(state, event.items);
    case "running":
      return stale(state, event.generation)
        ? state
        : applyRunning(state, event.items);
    case "page":
      if (event.replace === true && stale(state, event.generation)) return state;
      return appendPage(
        state,
        event.tabId,
        event.page.rows.map(rowFromView),
        event.page.next,
        event.replace === true,
        event.version,
        event.filter,
        event.page.hidden,
        event.filterSeq,
      );
    case "filter-launched":
      return state.filterRequest === undefined
        ? state
        : { ...state, filterRequest: undefined };
    case "rows":
      return appendPage(
        state,
        event.tabId,
        event.rows.map(rowFromView),
        event.next,
        event.replace === true,
        undefined,
      );
    case "page-error":
      return applyPageError(state, event.tabId, event.message, event.version);
    case "object":
      return applyObject(state, event.object, event.version);
    case "object-error":
      return applyObjectError(state, event.id, event.message, event.version);
    case "section":
      return applySection(
        state,
        event.objectId,
        event.sectionId,
        event.content,
        event.cursor,
        event.full === true,
        event.version,
        event.objectVersion,
        event.pages,
        event.jump,
      );
    case "section-error":
      return applySectionError(
        state,
        event.objectId,
        event.sectionId,
        event.message,
        event.version,
        event.objectVersion,
      );
    case "follow":
      return follow(state);
    case "refresh-start":
      return { ...state, generation: state.generation + 1 };
    case "page-launched":
      return state.pageRequest === undefined
        ? state
        : { ...state, pageRequest: undefined };
    case "object-launched":
      return state.objectRequest === undefined
        ? state
        : { ...state, objectRequest: undefined };
    case "section-launched":
      return state.sectionRequest === undefined
        ? state
        : { ...state, sectionRequest: undefined };
    case "status":
      if (stale(state, event.generation)) return state;
      return {
        ...state,
        status: event.message === undefined ? undefined : sanitize(event.message),
      };
    case "key":
      return handleKey(state, event);
    case "resize":
      return {
        ...state,
        width: Math.max(1, Math.trunc(event.width)),
        height: Math.max(1, Math.trunc(event.height)),
        ...(event.theme === undefined ? {} : { theme: event.theme }),
      };
    case "theme":
      return { ...state, theme: event.theme };
    case "keys":
    {
      if (stale(state, event.generation)) return state;
      const resolved = resolveBindings(event.bindings);
      return {
        ...state,
        bindings: resolved.bindings,
        ...(resolved.notice === undefined ? {} : { notice: resolved.notice }),
      };
    }
    case "action-launched":
      return state.actionRequest === undefined
        ? state
        : { ...state, actionRequest: undefined };
    case "action-done":
      return { ...state, acting: false, actionRequest: undefined };
    case "action-error":
      return actionFailed(state, event.status, event.message);
    case "connection":
      return state.connection === event.connection
        ? state
        : { ...state, connection: event.connection };
    case "row-gone":
      return removeRow(state, event.id);
    case "row":
      return replaceRow(state, rowFromView(event.row));
    case "refreshed":
      return state.refreshRequested
        ? { ...state, refreshRequested: false }
        : state;
  }
}

/** True when the terminal is wide enough for the list and the object pane. */
export function twoPane(state: TuiState): boolean {
  return state.width >= TWO_PANE_WIDTH;
}

/** The active tab, if any. */
export function activeTab(state: TuiState): TuiTab | undefined {
  return state.tabs[state.active];
}

/** The tab whose cursor the keys move. */
export function activeRows(state: TuiState): readonly TuiRow[] {
  return activeTab(state)?.list.rows ?? [];
}

/** The label a tab shows, with Pending's badge count. */
export function tabLabel(tab: TuiTab): string {
  if (tab.kind === "pending" && tab.list.rows.length > 0) {
    return `${tab.title} ${tab.list.rows.length}`;
  }
  return tab.title;
}

/** The header line, exactly as the design names it. */
export function headerText(state: TuiState): string {
  const pending = state.tabs.find((tab) => tab.kind === "pending");
  const running = state.tabs.find((tab) => tab.kind === "running");
  const types = state.tabs
    .filter((tab) => tab.kind === "type")
    .map((tab) => tab.title);
  return `operad ─ ${[
    `Pending ${pending?.list.rows.length ?? 0}`,
    `Running ${running?.list.rows.length ?? 0}`,
    ...types,
  ].join(" · ")}`;
}

/** The footer for the current screen. */
export function footerText(state: TuiState): string {
  let common: string;
  const filtering = filterKeyApplies(state);
  if (state.object === undefined) {
    common = `j/k move  enter open  1-9 tab  g/G ends  ${filtering ? "f filter  " : ""}r refresh  ? keys  q quit`;
  } else if (twoPane(state)) {
    const section = activeSection(state);
    const capped = section !== undefined && section.capped && !section.full;
    const pages = pagePosition(section) === undefined ? "" : "p pages  n/N page  ";
    common = `j/k row  space/b scroll  [ ] section  ${pages}${filtering && !capped ? "f filter" : "f full"}  esc close  ? keys  q quit`;
  } else {
    const pages = pagePosition(activeSection(state)) === undefined ? "" : "p pages  n/N page  ";
    common = `j/k scroll  space/b page  g/G ends  [ ] section  ${pages}f full  esc back  ? keys  q quit`;
  }
  const main = mainAction(state);
  const actions =
    state.object === undefined || main === undefined
      ? ""
      : `${mainKey(state) === undefined ? "" : `${mainKey(state)} `}${main.name}${state.object.actions.length > 1 ? "  : more" : ""}  `;
  return state.keys ? `${actions}${common}  ? closes the key list` : `${actions}${common}`;
}

/** Every key the TUI reads, in the order the key list shows them. */
export const KEY_LIST: readonly (readonly [string, string])[] = [
  ["1–9", "open that tab (closes the open object)"],
  ["tab / shift-tab", "next or previous tab"],
  ["↑↓ / j k", "move the row; on a narrow screen with an object open, scroll it"],
  ["g / G", "first or last row; on a narrow screen with an object open, its top or bottom"],
  ["enter", "open the selected row (on a narrow screen); does nothing on the open row"],
  ["PgUp PgDn / b space", "scroll the open section a page"],
  ["Home / End", "top of the open section, or its end (follows a live one)"],
  ["[ ] / ← →", "the previous or next section"],
  ["p", "pick a page of the open section (when it has pages)"],
  ["n / N", "the next or previous page of the open section"],
  ["f", "load the whole open section when it is capped; otherwise, on a tab with filters, the next filter"],
  ["r", "fetch the lists again"],
  ["escape", "close the key list, or the open object"],
  ["?", "show or hide this key list"],
  ["q", "quit"],
];

/** The lines one row takes: always one; an error row shows its text elsewhere. */
export function rowLines(_row: TuiRow): number {
  return 1;
}

/**
 * The rows `[start, end)` that fit in `available` lines around the cursor. The
 * lines after the rows (`loading more…` and a page error) are kept free.
 */
export function listWindow(
  list: TuiList,
  available: number,
): { readonly start: number; readonly end: number } {
  const count = list.rows.length;
  if (count === 0) return { start: 0, end: 0 };
  const tail = (list.loading ? 1 : 0) + (list.error === undefined ? 0 : 1);
  const room = Math.max(1, Math.trunc(available) - tail);
  const cursor = Math.min(Math.max(0, list.cursor), count - 1);
  let start = cursor;
  let end = cursor + 1;
  let used = rowLines(list.rows[cursor] as TuiRow);
  for (;;) {
    let grew = false;
    const after = list.rows[end];
    if (after !== undefined && used + rowLines(after) <= room) {
      used += rowLines(after);
      end += 1;
      grew = true;
    }
    const before = list.rows[start - 1];
    if (before !== undefined && used + rowLines(before) <= room) {
      used += rowLines(before);
      start -= 1;
      grew = true;
    }
    if (!grew) return { start, end };
  }
}

/** The red footer line an action leaves: a confirmation, or a refusal. */
export function noticeText(state: TuiState): string | undefined {
  return confirmText(state) ?? state.notice;
}

/** The footer when a failure is showing: the reason, then the way out. */
export function statusText(state: TuiState): string | undefined {
  if (state.connection === "unreachable") {
    return `no server at ${state.url ?? "the address"}: is \`operad serve\` running? retrying  q quit`;
  }
  if (state.connection === "unauthorized") {
    return "the token was rotated: run the TUI again or pass --token  q quit";
  }
  return state.status === undefined ? undefined : `${state.status}  q quit`;
}
