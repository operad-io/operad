/**
 * The TUI's whole state and its one reducer. Every event is a client result, a
 * key or a resize; the reducer never fetches, never reads a clock and never
 * touches the terminal, so a test drives it as a plain value.
 */

import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewRow,
  ViewSectionContent,
  ViewSectionInfo,
} from "@operad-io/engine";
import { renderMarkdownLines } from "@operad-io/engine";
import type { TuiTypeInfo } from "./client.ts";

/** The two terminal themes the view knows. */
export type TuiTheme = "light" | "dark";

/** What a tab lists. */
export type TuiTabKind = "pending" | "running" | "type";

/** The marker a row shows: a person waits, a run works, or nothing. */
export type TuiMark = "waiting" | "running" | "none";

/** One line of a list, in the words the view renders. */
export interface TuiRow {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly note?: string | undefined;
  readonly waiting: boolean;
  readonly running: boolean;
  /** Set on an error row; the view adds one red line under the row. */
  readonly error?: string | undefined;
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
  readonly error?: string | undefined;
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
  readonly type: string;
  readonly link: string;
  readonly row: TuiRow;
  readonly sections: readonly TuiSection[];
  readonly active: number;
  /** The object response has not arrived yet; its row comes from the list. */
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly unavailable?: string | undefined;
  /** Grows with each open; an answer to an older open is dropped. */
  readonly version: number;
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
  readonly full: boolean;
  /** The section version the page was asked for. */
  readonly version: number;
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
}

/** One tab: Pending, Running or one object type. */
export interface TuiTab {
  readonly id: string;
  readonly kind: TuiTabKind;
  /** The `/v1/types` name; set only for a type tab. */
  readonly type?: string | undefined;
  readonly title: string;
  readonly list: TuiList;
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
  /** Set when the cursor nears the end of a list that has another page. */
  readonly pageRequest?: TuiPageRequest | undefined;
  /** The open object, if any. */
  readonly object?: TuiObject | undefined;
  /** Set when a row is opened and the caller must fetch the object. */
  readonly objectRequest?: TuiObjectRequest | undefined;
  /** Set when a section must be fetched. */
  readonly sectionRequest?: TuiSectionRequest | undefined;
  /** Grows with each refresh; an answer to an older refresh is dropped. */
  readonly generation: number;
  /** The last failure to show in the footer; cleared by a good refresh. */
  readonly status?: string | undefined;
}

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
): TuiTab {
  return {
    id,
    kind,
    ...(type === undefined ? {} : { type }),
    title,
    list: makeList(),
  };
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
    generation: 0,
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
      readonly full?: boolean | undefined;
      readonly version?: number | undefined;
    }
  | {
      readonly type: "section-error";
      readonly objectId: string;
      readonly sectionId: string;
      readonly message: string;
      readonly version?: number | undefined;
    }
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
  | { readonly type: "refreshed" };

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
    id: rowId(row),
    title: row.title,
    state: row.state,
    ...(row.note === undefined ? {} : { note: row.note }),
    waiting: row.waiting,
    running: row.running,
    ...(row.error === undefined ? {} : { error: row.error }),
  };
}

function rowFromPending(item: PendingItem): TuiRow {
  return {
    id: item.object ?? item.runId,
    title: item.prompt,
    state: item.flow,
    ...(item.step === null ? {} : { note: item.step }),
    waiting: true,
    running: false,
  };
}

function rowFromRunning(item: RunningItem): TuiRow {
  return {
    id: item.runId,
    title: item.flow,
    state: item.stepLabel ?? "-",
    note: formatElapsed(item.elapsedMs),
    waiting: false,
    running: true,
  };
}

/** The marker a row puts in its first column. */
export function rowMark(row: TuiRow): TuiMark {
  if (row.waiting) return "waiting";
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

/** The lines the Markdown renderer gives a section, without its trailing blank. */
export function markdownLineCount(markdown: string): number {
  const lines = renderMarkdownLines(markdown);
  while (lines.length > 0 && (lines[lines.length - 1]?.text ?? "") === "") {
    lines.pop();
  }
  return lines.length;
}

/** How many Markdown lines fit under the object's row and section tabs. */
export function sectionViewport(state: TuiState): number {
  const body = Math.max(1, state.height - 3);
  const inner = twoPane(state) ? Math.max(1, body - 4) : body;
  return Math.max(1, inner - 3);
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
  return Math.max(0, markdownLineCount(section.markdown) - sectionViewport(state));
}

/** Asks for a section's first page or its next one, once. */
function requestSection(
  state: TuiState,
  index: number,
  options: { cursor?: string | undefined; full?: boolean | undefined; force?: boolean | undefined } = {},
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
    current.full === full &&
    current.version === section.version
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
      full,
      version: section.version,
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
  if (row === undefined) return state;
  const previous = state.object?.id === row.id ? state.object : undefined;
  const version = (previous?.version ?? 0) + 1;
  const object: TuiObject = {
    id: row.id,
    type: previous?.type ?? (row.id.includes(":") ? row.id.slice(0, row.id.indexOf(":")) : row.id),
    link: previous?.link ?? "",
    row,
    sections: previous?.sections ?? [],
    active: previous?.active ?? 0,
    loading: true,
    version,
  };
  return {
    ...state,
    object,
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
  if (
    version !== undefined &&
    previous !== undefined &&
    version !== previous.version
  ) {
    return state;
  }
  const row = rowFromView(view.row);
  const oldSections = previous?.sections ?? [];
  const sections = view.sections.map((info) =>
    makeSection(info, oldSections.find((section) => section.id === info.id)),
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
    type: view.type,
    link: view.link,
    row,
    sections,
    active,
    loading: false,
    ...(view.unavailable === undefined ? {} : { unavailable: view.unavailable }),
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
    object: { ...object, loading: false, error: message },
    objectRequest: undefined,
    sectionRequest: undefined,
  };
}

function joinMarkdown(before: string, after: string): string {
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
): TuiState {
  const object = state.object;
  if (object === undefined || object.id !== objectId) return state;
  const section = object.sections.find((candidate) => candidate.id === sectionId);
  if (section === undefined) return state;
  if (version !== undefined && version !== section.version) return state;
  const markdown =
    cursor === undefined
      ? content.markdown
      : joinMarkdown(section.markdown, content.markdown);
  const capped = !full && /\[Truncated\./.test(markdown);
  const updated = withSection(state, sectionId, (value) => {
    const next: TuiSection = {
      ...value,
      markdown,
      next: content.next,
      loaded: true,
      loading: false,
      full: full || value.full,
      capped,
      error: undefined,
      version: value.version + 1,
    };
    const following = next.following;
    return {
      ...next,
      scroll: following
        ? Math.max(0, markdownLineCount(markdown) - sectionViewport(state))
        : Math.min(value.scroll, Math.max(0, markdownLineCount(markdown) - sectionViewport(state))),
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
): TuiState {
  const object = state.object;
  const section = object?.sections.find((candidate) => candidate.id === sectionId);
  if (object === undefined || object.id !== objectId || section === undefined) {
    return state;
  }
  if (version !== undefined && version !== section.version) return state;
  const updated = withSection(state, sectionId, (value) => ({
    ...value,
    loading: false,
    error: message,
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
  const moved = withTab(state, tab.id, (current) => ({
    ...current,
    list: { ...current.list, cursor: next },
  }));
  const updated = activeTabOf(moved);
  return updated === undefined ? moved : requestPage(moved, updated);
}

function jump(state: TuiState, to: "top" | "bottom"): TuiState {
  const tab = activeTabOf(state);
  if (tab === undefined) return state;
  const cursor = to === "top" ? 0 : Math.max(0, tab.list.rows.length - 1);
  if (cursor === tab.list.cursor) return state;
  const moved = withTab(state, tab.id, (current) => ({
    ...current,
    list: { ...current.list, cursor },
  }));
  const updated = activeTabOf(moved);
  return updated === undefined ? moved : requestPage(moved, updated);
}

function activate(state: TuiState, index: number): TuiState {
  if (index < 0 || index >= state.tabs.length || index === state.active) return state;
  return { ...state, active: index };
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

function handleKey(
  state: TuiState,
  event: {
    key: string;
    shift?: boolean | undefined;
    ctrl?: boolean | undefined;
    meta?: boolean | undefined;
  },
): TuiState {
  // Ctrl-C is the renderer's exit; no other chord is ours.
  if (event.ctrl === true || event.meta === true) return state;
  const key = event.key;
  const shift = event.shift === true;
  if (key === "?" || (key === "/" && shift)) {
    return { ...state, keys: !state.keys };
  }
  if (isKey(key, "q")) return { ...state, quit: true };
  if (state.keys) {
    // The list behind the key list is hidden, so no other key acts on it.
    return isKey(key, "escape", "esc") ? { ...state, keys: false } : state;
  }
  if (isKey(key, "enter", "return")) return openObject(state);
  if (isKey(key, "escape", "esc")) return closeObject(state);
  if (isKey(key, "[", "left", "arrowleft")) return moveSection(state, -1);
  if (isKey(key, "]", "right", "arrowright")) return moveSection(state, 1);
  if (state.object !== undefined) {
    const page = Math.max(1, sectionViewport(state) - 1);
    if (isKey(key, "up", "arrowup", "k")) return scrollSection(state, -1);
    if (isKey(key, "down", "arrowdown", "j")) return scrollSection(state, 1);
    if (isKey(key, "pageup", "page-up", "prior")) return scrollSection(state, -page);
    if (isKey(key, "pagedown", "page-down", "next")) return scrollSection(state, page);
    if (key === "G" || (isKey(key, "g") && shift)) return jumpSection(state, "bottom");
    if (isKey(key, "g")) return jumpSection(state, "top");
    if (isKey(key, "f")) {
      const object = state.object;
      const section = activeSection(state);
      return object !== undefined && section !== undefined && section.capped && !section.full
        ? requestSection(state, object.active, { full: true })
        : state;
    }
  }
  if (isKey(key, "r")) return { ...state, refreshRequested: true };
  if (isKey(key, "tab")) return cycle(state, shift ? -1 : 1);
  if (isKey(key, "up", "arrowup", "k")) return move(state, -1);
  if (isKey(key, "down", "arrowdown", "j")) return move(state, 1);
  if (key === "G" || (isKey(key, "g") && shift)) return jump(state, "bottom");
  if (isKey(key, "g")) return jump(state, "top");
  if (/^[1-9]$/.test(key)) return activate(state, Number(key) - 1);
  return state;
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
    typeTabs.push(
      existing.get(id) ?? makeTab(id, "type", typeTitle(info), info.type),
    );
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
  return clampCursor({ ...old, rows });
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
): TuiState {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) return state;
  if (!replace && version !== undefined && version !== tab.list.version) {
    return state;
  }
  const updated = withTab(state, tabId, (current) => {
    if (replace) return replaceRows(current, rows, next);
    const list: TuiList = {
      ...current.list,
      rows: [...current.list.rows, ...rows],
      loaded: true,
      loading: false,
      next,
      error: undefined,
    };
    return { ...current, list: { ...list, cursor: clampCursor(list) } };
  });
  return clearRequest(state, updated, tabId);
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
    list: { ...tab.list, loading: false, error: message },
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
      );
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
      );
    case "section-error":
      return applySectionError(
        state,
        event.objectId,
        event.sectionId,
        event.message,
        event.version,
      );
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
      return { ...state, status: event.message };
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
  const common =
    state.object === undefined
      ? "1–9/tab switch · ↑↓/j k move · enter open · g G top/bottom · r refetch · ? keys · q quit"
      : "↑↓/j k scroll · PgUp PgDn page · G follow · [ ]/←→ sections · f full · esc back · ? keys · q quit";
  return state.keys ? `${common} · ? closes the key list` : common;
}

/** Every key the TUI reads, in the order the key list shows them. */
export const KEY_LIST: readonly (readonly [string, string])[] = [
  ["1–9", "open that tab"],
  ["tab / shift-tab", "next or previous tab"],
  ["↑↓ / j k", "move the cursor, or scroll the open section"],
  ["enter", "open the selected row"],
  ["g / G", "the top or the bottom, or follow a live section"],
  ["PgUp / PgDn", "scroll the open section a page"],
  ["[ ] / ← →", "the previous or next section"],
  ["f", "load the whole open section when it is capped"],
  ["r", "fetch the lists again"],
  ["escape", "close the key list, or the open object"],
  ["?", "show or hide this key list"],
  ["q", "quit"],
];

/** The lines one row takes: an error row adds a line under it. */
export function rowLines(row: TuiRow): number {
  return row.error === undefined ? 1 : 2;
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
  const tail = (list.loading ? 1 : 0) + (list.error === undefined ? 0 : 2);
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

/** The footer when a failure is showing: the reason, then the way out. */
export function statusText(state: TuiState): string | undefined {
  return state.status === undefined ? undefined : `${state.status} · q quit`;
}
