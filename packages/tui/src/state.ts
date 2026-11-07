/**
 * The TUI's whole state and its one reducer. Every event is a client result, a
 * key or a resize; the reducer never fetches, never reads a clock and never
 * touches the terminal, so a test drives it as a plain value.
 */

import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewRow,
} from "@operad-io/engine";
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

/** A list page the reducer wants the caller to fetch next. */
export interface TuiPageRequest {
  readonly tabId: string;
  readonly cursor: string;
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
  };
}

/** A short alias for callers that build the first state. */
export const createInitialState = initialState;

/** What the reducer accepts. */
export type TuiStateEvent =
  | { readonly type: "types"; readonly types: readonly TuiTypeInfo[] }
  | { readonly type: "pending"; readonly items: readonly PendingItem[] }
  | { readonly type: "running"; readonly items: readonly RunningItem[] }
  | {
      readonly type: "page";
      readonly tabId: string;
      readonly page: ViewListPage;
      /** Replace the list instead of appending one page. */
      readonly replace?: boolean | undefined;
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
    }
  | { readonly type: "key"; readonly key: string; readonly shift?: boolean | undefined }
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
  return { ...updated, pageRequest: { tabId: tab.id, cursor: list.next } };
}

function activeTabOf(state: TuiState): TuiTab | undefined {
  return state.tabs[state.active];
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

function handleKey(state: TuiState, event: { key: string; shift?: boolean | undefined }): TuiState {
  const key = event.key;
  const shift = event.shift === true;
  if (key === "?" || (key === "/" && shift)) {
    return { ...state, keys: !state.keys };
  }
  if (isKey(key, "q")) return { ...state, quit: true };
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

function applyPending(state: TuiState, items: readonly PendingItem[]): TuiState {
  const rows = items.map(rowFromPending);
  return withTab(state, "pending", (tab) => {
    const list = { ...tab.list, rows, loaded: true, loading: false };
    return { ...tab, list: { ...list, cursor: clampCursor(list), error: undefined } };
  });
}

function applyRunning(state: TuiState, items: readonly RunningItem[]): TuiState {
  const rows = items.map(rowFromRunning);
  return withTab(state, "running", (tab) => {
    const list = { ...tab.list, rows, loaded: true, loading: false };
    return { ...tab, list: { ...list, cursor: clampCursor(list), error: undefined } };
  });
}

function appendPage(
  state: TuiState,
  tabId: string,
  rows: readonly TuiRow[],
  next: string | undefined,
  replace: boolean,
): TuiState {
  const updated = withTab(state, tabId, (tab) => {
    const merged = replace ? rows : [...tab.list.rows, ...rows];
    const list: TuiList = {
      ...tab.list,
      rows: merged,
      loaded: true,
      loading: false,
      ...(next === undefined ? { next: undefined } : { next }),
      error: undefined,
    };
    return { ...tab, list: { ...list, cursor: clampCursor(list) } };
  });
  if (updated === state) return state;
  if (state.pageRequest?.tabId === tabId) {
    return { ...updated, pageRequest: undefined };
  }
  return updated;
}

function applyPageError(state: TuiState, tabId: string, message: string): TuiState {
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

/** The pure reducer: the same state and event always give the same state. */
export function reduce(state: TuiState, event: TuiStateEvent): TuiState {
  switch (event.type) {
    case "types":
      return applyTypes(state, event.types);
    case "pending":
      return applyPending(state, event.items);
    case "running":
      return applyRunning(state, event.items);
    case "page":
      return appendPage(
        state,
        event.tabId,
        event.page.rows.map(rowFromView),
        event.page.next,
        event.replace === true,
      );
    case "rows":
      return appendPage(
        state,
        event.tabId,
        event.rows.map(rowFromView),
        event.next,
        event.replace === true,
      );
    case "page-error":
      return applyPageError(state, event.tabId, event.message);
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
  const common = "1–9/tab switch · ↑↓/j k move · g G top/bottom · r refetch · ? keys · q quit";
  return state.keys ? `${common} · ? closes the key list` : common;
}

/** Every key the TUI reads, in the order the key list shows them. */
export const KEY_LIST: readonly (readonly [string, string])[] = [
  ["1–9", "open that tab"],
  ["tab / shift-tab", "next or previous tab"],
  ["↑↓ / j k", "move the cursor"],
  ["g / G", "go to the top or the bottom"],
  ["r", "fetch the lists again"],
  ["?", "show or hide this key list"],
  ["q", "quit"],
];
