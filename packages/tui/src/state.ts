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
import type { TuiSetting, TuiTypeInfo } from "./client.ts";
import { cachedLayout, layoutMarkdown, type LayoutLine } from "./layout.ts";
import type { ArgField } from "./args.ts";
import { sanitize } from "./sanitize.ts";
import { displayWidth, graphemes, wrapText } from "./wrap.ts";
import {
  actionFailed,
  bindingFor,
  chosenEntry,
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
  remember,
  withNotice,
  type TuiCommand,
} from "./actions.ts";

/** The two terminal themes the view knows. */
export type TuiTheme = "light" | "dark";

/** How a page draws its next level: nested by `after`, or one flat list. */
export type TuiChildLayout = "tree" | "list";

/** What a tab lists. */
export type TuiTabKind = "pending" | "running" | "plugin";

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
  /** The sibling ids this row waits for. */
  readonly after?: readonly string[] | undefined;
  /** Set on an error row; the view adds one red line under the row. */
  readonly error?: string | undefined;
  /** False for a row that names no object (a run, a candidate): it never opens. */
  readonly openable?: boolean | undefined;
  /** The parts of the dim second line; unset means state, badge and note. */
  readonly detail?: readonly string[] | undefined;
  /** The row names no object: its first line is the title alone. */
  readonly unnamed?: boolean | undefined;
  /** The object type, for a row of a plugin tab or of a page's next level. */
  readonly type?: string | undefined;
  /** The id of the top-level object whose group the row is in. */
  readonly parent?: string | undefined;
  /** On the first row of a group: the top-level object the group is named for. */
  readonly group?: TuiRow | undefined;
  /** The row is a top-level object with nothing under it, shown as its own group row. */
  readonly bare?: boolean | undefined;
}

/** The next level under the open object: its rows and where the cursor is in them. */
export interface TuiChildren {
  readonly rows: readonly TuiRow[];
  readonly cursor: number;
  /** The keys move in this list instead of the left one. */
  readonly focused: boolean;
  /** How many children the list's filter left out; they still call for progress. */
  readonly hidden?: number | undefined;
  /** How many hidden children are done. */
  readonly hiddenDone?: number | undefined;
  /** How many hidden children are cancelled. */
  readonly hiddenCancelled?: number | undefined;
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
  /** Where in `markdown` each page after the first one it holds begins (a character offset). */
  readonly pageMarks: readonly number[];
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
  /** The next level under the object, once it has arrived. */
  readonly children?: TuiChildren | undefined;
  /** The page this one was opened from (a child opened from its parent). */
  readonly back?: TuiObject | undefined;
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
  | { readonly kind: "themes"; readonly cursor: number }
  | {
      readonly kind: "note";
      readonly action: string;
      readonly id: string;
      readonly text: string;
      readonly required: boolean;
      /** The action asks to confirm after the note. */
      readonly confirm: boolean;
      readonly args?: Readonly<Record<string, unknown>> | undefined;
    }
  | {
      /** One argument of an action is being asked: a list, a number or a text. */
      readonly kind: "args";
      readonly action: string;
      readonly id: string;
      readonly fields: readonly ArgField[];
      /** The field being asked. */
      readonly at: number;
      /** The answers so far, by argument name. */
      readonly values: Readonly<Record<string, unknown>>;
      /** The cursor in a list. */
      readonly cursor: number;
      /** What is typed into a number or a text. */
      readonly text: string;
      /** Why the last answer was refused. */
      readonly error?: string | undefined;
      /** The note comes after the arguments: whether it is required. */
      readonly note?: { readonly required: boolean } | undefined;
      readonly confirm: boolean;
    }
  | {
      /** A setting is open: its details, and a value prompt when it can change. */
      readonly kind: "setting";
      readonly setting: TuiSetting;
      /** The prompt; absent for a setting that cannot change. */
      readonly field?: ArgField | undefined;
      readonly cursor: number;
      readonly text: string;
    }
  | {
      readonly kind: "setting-confirm";
      readonly setting: TuiSetting;
      readonly value: unknown;
    }
  | {
      readonly kind: "confirm";
      readonly action: string;
      readonly id: string;
      readonly note?: string | undefined;
      readonly args?: Readonly<Record<string, unknown>> | undefined;
    };

/** An action the reducer wants the caller to send with `POST /v1/act`. */
export interface TuiActionRequest {
  readonly action: string;
  readonly id: string;
  readonly note?: string | undefined;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  readonly confirmed?: boolean | undefined;
}

/** A setting change the reducer wants the caller to send with `POST /v1/settings`. */
export interface TuiSettingRequest {
  readonly name: string;
  readonly scope: string;
  readonly value: unknown;
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

/** One tab: Pending, Running or one plugin. */
export interface TuiTab {
  readonly id: string;
  readonly kind: TuiTabKind;
  /** The plugin a plugin tab is for. */
  readonly plugin?: string | undefined;
  /** The plugin's object types, in the server's order; set only for a plugin tab. */
  readonly types?: readonly TuiTypeInfo[] | undefined;
  /** What a plugin tab lists: its top-level objects, or their next level in groups. */
  readonly level?: "roots" | "children" | undefined;
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
  /** How the next level of the open object is drawn. */
  readonly childLayout: TuiChildLayout;
  /** The `?` key list is open. */
  readonly keys: boolean;
  /** The first key list row drawn; the list scrolls when the terminal is short. */
  readonly helpScroll: number;
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
  /** The palette entries used last, the latest first; the shell keeps them between runs. */
  readonly recent: readonly string[];
  /** The installed theme names the theme list shows. */
  readonly themeNames: readonly string[];
  /** The theme in force. */
  readonly themeCurrent: string;
  /** The theme the list cursor is on; the shell shows it until the list closes. */
  readonly themePreview?: string | undefined;
  /** Set when the chosen theme must be kept; the caller clears it as it saves. */
  readonly themeRequest?: string | undefined;
  /** Set when the chosen child layout must be saved; the caller clears it. */
  readonly layoutRequest?: TuiChildLayout | undefined;
  /** The palette, note or confirmation the keys are typing into. */
  readonly input?: TuiInput | undefined;
  /** One footer line (a refusal, or "not available") until the next key. */
  readonly notice?: string | undefined;
  /** Set when an action must be sent; the caller clears it as it sends. */
  readonly actionRequest?: TuiActionRequest | undefined;
  /** The settings the palette lists, global and the open object's repository. */
  readonly settings: readonly TuiSetting[];
  /** Set when the palette opened and the settings must be fetched again. */
  readonly settingsRequest: boolean;
  /** Set when a setting change must be sent; the caller clears it as it sends. */
  readonly settingRequest?: TuiSettingRequest | undefined;
  /** An action is on its way; a second one waits for the answer. */
  readonly acting: boolean;
  /** The server this screen talks to, named in the unreachable line. */
  readonly url?: string | undefined;
  /** Whether the server answers; the lists stay as they were when it does not. */
  readonly connection: TuiConnection;
}

/** What the last request said about the server. */
export type TuiConnection = "ok" | "unreachable" | "unauthorized";

/** The number of rows from the end that make the reducer ask for a page. */
export const PAGE_AHEAD = 2;

/** Initial dimensions, matching a conventional 80 by 24 terminal. */
export const DEFAULT_WIDTH = 80;
export const DEFAULT_HEIGHT = 24;

export interface TuiStateOptions {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly theme?: TuiTheme | undefined;
  readonly childLayout?: TuiChildLayout | undefined;
  readonly url?: string | undefined;
  readonly recent?: readonly string[] | undefined;
  readonly themeNames?: readonly string[] | undefined;
  readonly themeCurrent?: string | undefined;
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
  types?: readonly TuiTypeInfo[],
): TuiTab {
  const filters = filtersOf(types);
  const defaulted = types?.find((info) => info.defaultFilter !== undefined)?.defaultFilter;
  const filter =
    filters === undefined
      ? undefined
      : (filters.find((f) => f.name === defaulted) ?? filters[0])?.name;
  return {
    id,
    kind,
    ...(types === undefined ? {} : { types }),
    title,
    list: makeList(),
    ...(filters === undefined ? {} : { filters, filter }),
  };
}

/** The filters of a plugin's types: each name once, in the order they first appear. */
function filtersOf(types: readonly TuiTypeInfo[] | undefined): readonly TuiFilterInfo[] | undefined {
  const out: TuiFilterInfo[] = [];
  for (const info of types ?? []) {
    for (const filter of info.filters ?? []) {
      if (!out.some((seen) => seen.name === filter.name)) out.push(filter);
    }
  }
  return out.length === 0 ? undefined : out;
}

/** The filter to ask a type for: the tab's, when the type declares it. */
export function filterFor(tab: TuiTab, info: TuiTypeInfo): string | undefined {
  const name = tab.filter;
  if (name === undefined) return undefined;
  return info.filters?.some((f) => f.name === name) === true ? name : undefined;
}

/** The plugin tab that holds `type`, if any. */
export function pluginTabOf(state: TuiState, type: string): TuiTab | undefined {
  return state.tabs.find((tab) => tab.types?.some((info) => info.type === type) === true);
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
    childLayout: options.childLayout ?? "tree",
    keys: false,
    helpScroll: 0,
    quit: false,
    refreshRequested: false,
    objectVersion: 0,
    moveSeq: 0,
    followPending: false,
    generation: 0,
    bindings: [],
    recent: options.recent ?? [],
    settings: [],
    settingsRequest: false,
    themeNames: options.themeNames ?? [],
    themeCurrent: options.themeCurrent ?? "auto",
    acting: false,
    connection: "ok",
    ...(options.url === undefined ? {} : { url: options.url }),
  };
}

/** A short alias for callers that build the first state. */
export const createInitialState = initialState;

/** One row of a plugin tab's list, with its type and, first in a group, the group's heading. */
export interface TuiTreeEntry {
  readonly row: ViewRow;
  readonly type: string;
  /** The top-level object this row is under, when the list is grouped. */
  readonly parent?: string | undefined;
  /** Set on the first row of a group: the top-level object's own row and type. */
  readonly heading?:
    | {
        readonly row: ViewRow;
        readonly type: string;
        /** The heading's text when it names a parent outside the tab's own objects. */
        readonly label?: string | undefined;
      }
    | undefined;
  /** A top-level object with nothing under it: its row is its own group row. */
  readonly bare?: boolean | undefined;
}

/** What the reducer accepts. */
export type TuiStateEvent =
  | {
      readonly type: "types";
      readonly types: readonly TuiTypeInfo[];
      readonly generation?: number | undefined;
    }
  | { readonly type: "filter-launched" }
  /** A plugin tab's whole list: its top-level objects, or their next level in groups. */
  | {
      readonly type: "tree";
      readonly tabId: string;
      readonly level: "roots" | "children";
      readonly entries: readonly TuiTreeEntry[];
      /** How many rows the filter left out. */
      readonly hidden?: number | undefined;
      readonly generation?: number | undefined;
      readonly filter?: string | undefined;
      readonly filterSeq?: number | undefined;
    }
  /** The next level of the open object arrived. */
  | {
      readonly type: "children";
      readonly objectId: string;
      readonly version?: number | undefined;
      readonly entries: readonly TuiTreeEntry[];
      /** How many children the list's filter left out. */
      readonly hidden?: number | undefined;
      /** How many hidden children are done. */
      readonly hiddenDone?: number | undefined;
      /** How many hidden children are cancelled. */
      readonly hiddenCancelled?: number | undefined;
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
      /** For a replace: where the pages after the first begin in the text. */
      readonly marks?: readonly number[] | undefined;
      /** For a replace: the table-of-contents index of the first page, kept from before. */
      readonly start?: number | undefined;
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
  | { readonly type: "setting-launched" }
  | { readonly type: "settings"; readonly settings: readonly TuiSetting[] }
  /** The installed themes or the theme in force changed. */
  | { readonly type: "theme-names"; readonly names: readonly string[]; readonly current: string }
  /** The caller saved the chosen theme; it is saved once. */
  | { readonly type: "theme-launched" }
  /** The caller saved the chosen child layout; it is saved once. */
  | { readonly type: "layout-launched" }
  /** The action ran, or its result was already true and `notice` says so. */
  | { readonly type: "action-done"; readonly notice?: string | undefined }
  /** The server refused the action; the message shows as the line, the status does not. */
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
export function rowFromView(row: ViewRow, type?: string): TuiRow {
  return {
    id: sanitize(rowId(row)),
    ...(type === undefined ? {} : { type }),
    title: sanitize(row.title),
    state: sanitize(row.state),
    ...(row.note === undefined ? {} : { note: sanitize(row.note) }),
    waiting: row.waiting,
    running: row.running,
    ...(row.mark === undefined ? {} : { mark: row.mark }),
    ...(row.badge === undefined ? {} : { badge: sanitize(row.badge) }),
    ...(row.after === undefined ? {} : { after: row.after.map(sanitize) }),
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
      detail: detailOf([item.prompt, repositoryOf(item.object)]),
      waiting: true,
      running: false,
      ...(item.row.mark === undefined ? {} : { mark: item.row.mark }),
      ...(item.row.badge === undefined ? {} : { badge: sanitize(item.row.badge) }),
      ...(item.row.error === undefined ? {} : { error: sanitize(item.row.error) }),
      ...(item.object === undefined ? { openable: false, unnamed: true } : {}),
    };
  }
  return {
    id: sanitize(item.object ?? item.runId),
    title: sanitize(item.prompt),
    state: sanitize(item.flow),
    ...(item.step === null ? {} : { note: sanitize(item.step) }),
    detail: detailOf([item.flow, item.step ?? "", repositoryOf(item.object)]),
    waiting: true,
    running: false,
    ...(item.object === undefined ? { openable: false, unnamed: true } : {}),
  };
}

function rowFromRunning(item: RunningItem): TuiRow {
  const named = item.object !== null && item.object !== undefined;
  const stepMs = item.stepElapsedMs ?? item.elapsedMs;
  return {
    id: sanitize(item.object ?? item.runId),
    title: sanitize(named ? (item.title ?? "") : (item.title ?? item.flow)),
    state: sanitize(item.stepLabel ?? "-"),
    note: formatElapsed(stepMs),
    detail: detailOf([
      item.stepLabel ?? "",
      item.stepElapsedMs === null || item.stepElapsedMs === undefined
        ? ""
        : formatElapsed(item.stepElapsedMs),
      item.queuedMs === undefined || item.queuedMs <= 0
        ? ""
        : `queued ${formatElapsed(item.queuedMs)}`,
      formatElapsed(item.elapsedMs),
      repositoryOf(item.object),
    ]),
    waiting: false,
    running: true,
    ...(item.mark === undefined ? {} : { mark: item.mark }),
    ...(named ? {} : { openable: false, unnamed: true }),
  };
}

/** The dim line's parts, cleaned, without the empty ones. */
function detailOf(parts: readonly string[]): readonly string[] {
  return parts.map((part) => sanitize(part).trim()).filter((part) => part !== "");
}

/** The repository an object name carries: `operad` in `ops/T-1-x`. */
function repositoryOf(object: string | null | undefined): string {
  if (object === null || object === undefined) return "";
  const bare = object.slice(object.indexOf(":") + 1);
  const slash = bare.lastIndexOf("/");
  return slash < 0 ? "" : bare.slice(0, slash);
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

/** A child the plugin marked cancelled, or whose state says so. */
export function cancelledRow(row: TuiRow): boolean {
  return rowMark(row) === "cancelled" || /(^|\.)cancelled$/i.test(row.state);
}

/** A child that is done: its mark says so, or a row without a mark says merged. */
function doneRow(row: TuiRow): boolean {
  const mark = rowMark(row);
  return mark === "done" || (mark === "none" && /^(done|merged)$/i.test(row.state));
}

interface ChildParent {
  readonly index: number;
  /** The id as the row's `after` wrote it; an unknown id is left out. */
  readonly id: string;
}

/** The rows in a child's `after` that are in the list, without itself and duplicates. */
function childParents(
  rows: readonly TuiRow[],
  row: TuiRow,
  at: number,
): readonly ChildParent[] {
  const seen = new Set<number>();
  const out: ChildParent[] = [];
  for (const id of row.after ?? []) {
    const index = rows.findIndex((candidate, place) =>
      place !== at && sameObject(candidate.id, id));
    if (index < 0 || seen.has(index)) continue;
    seen.add(index);
    out.push({ index, id });
  }
  return out;
}

/** One row of the next level as the page draws it. */
export interface TuiChildEntry {
  readonly row: TuiRow;
  /** 0 in the flat list and for a root in the tree. */
  readonly depth: number;
  /** `├─`/`└─` and their prefix in the tree; empty in the flat list. */
  readonly connector: string;
  /** The other parents in `after`, printed as `also after <id>`. */
  readonly alsoAfter: readonly string[];
}

/** Cancelled rows last, keeping every other row in its place. */
function cancelledLast(
  indexes: readonly number[],
  rows: readonly TuiRow[],
): number[] {
  return [
    ...indexes.filter((index) => !cancelledRow(rows[index] as TuiRow)),
    ...indexes.filter((index) => cancelledRow(rows[index] as TuiRow)),
  ];
}

function flatChildEntries(rows: readonly TuiRow[]): TuiChildEntry[] {
  const ordered = cancelledLast(rows.map((_, index) => index), rows);
  return ordered.map((index) => {
    const row = rows[index] as TuiRow;
    return {
      row,
      depth: 0,
      connector: "",
      alsoAfter: childParents(rows, row, index).map((parent) => parent.id),
    };
  });
}

/** The parent the tree can use: a cancelled row hangs only under cancelled rows. */
function treeParent(
  rows: readonly TuiRow[],
  row: TuiRow,
  at: number,
): ChildParent | undefined {
  const cancelled = cancelledRow(row);
  return childParents(rows, row, at).find(
    (parent) => cancelledRow(rows[parent.index] as TuiRow) === cancelled,
  );
}

/** A chain of tree parents that comes back to itself: the tree cannot place it. */
function hasChildCycle(rows: readonly TuiRow[]): boolean {
  const parents = rows.map((row, index) => treeParent(rows, row, index)?.index);
  for (let start = 0; start < rows.length; start += 1) {
    const seen = new Set<number>();
    let at: number | undefined = start;
    while (at !== undefined) {
      if (seen.has(at)) return true;
      seen.add(at);
      at = parents[at];
    }
  }
  return false;
}

function treeChildEntries(rows: readonly TuiRow[]): TuiChildEntry[] {
  // A cycle has no root: the list order is the only order that shows every row.
  if (hasChildCycle(rows)) return flatChildEntries(rows);
  const parents = rows.map((row, index) => treeParent(rows, row, index));
  const children = new Map<number, number[]>();
  for (let index = 0; index < rows.length; index += 1) {
    const parent = parents[index]?.index ?? -1;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [index]);
    else list.push(index);
  }

  const out: TuiChildEntry[] = [];
  const visited = new Set<number>();
  const walk = (index: number, prefix: string, root: boolean, last: boolean): void => {
    if (visited.has(index)) return;
    visited.add(index);
    const row = rows[index] as TuiRow;
    const all = childParents(rows, row, index);
    const parent = parents[index];
    out.push({
      row,
      depth: root ? 0 : Math.trunc(prefix.length / 3) + 1,
      connector: root ? "" : `${prefix}${last ? "└─" : "├─"}`,
      alsoAfter:
        parent === undefined
          ? []
          : all.filter((one) => one.index !== parent.index).map((one) => one.id),
    });
    const childPrefix = root ? "" : `${prefix}${last ? "   " : "│  "}`;
    const below = children.get(index) ?? [];
    below.forEach((child, at) => walk(child, childPrefix, false, at + 1 === below.length));
  };

  const roots = children.get(-1) ?? [];
  // Cancelled rows are the last group, so an active child never hangs from one.
  const active = roots.filter((index) => !cancelledRow(rows[index] as TuiRow));
  const cancelled = roots.filter((index) => cancelledRow(rows[index] as TuiRow));
  active.forEach((index, at) => walk(index, "", true, at + 1 === active.length));
  cancelled.forEach((index, at) => walk(index, "", true, at + 1 === cancelled.length));
  return out;
}

/** The next level in the order the page draws it, for the chosen layout. */
export function displayChildren(
  rows: readonly TuiRow[],
  layout: TuiChildLayout,
): readonly TuiChildEntry[] {
  if (rows.length === 0) return [];
  return layout === "list" ? flatChildEntries(rows) : treeChildEntries(rows);
}

/** The next level's bar cells and counts: cancelled children last and not counted. */
export interface TuiChildProgress {
  readonly entries: readonly TuiChildEntry[];
  readonly done: number;
  readonly total: number;
  /** Children the list's filter left out. */
  readonly hidden: number;
  /** Hidden children that are cancelled; they keep their bar cells. */
  readonly hiddenCancelled: number;
}

export function childProgress(
  rows: readonly TuiRow[],
  layout: TuiChildLayout,
  hidden = 0,
  hiddenDone = hidden,
  hiddenCancelled = 0,
): TuiChildProgress {
  const shown = displayChildren(rows, layout);
  const active = shown.filter((entry) => !cancelledRow(entry.row));
  const cancelled = shown.filter((entry) => cancelledRow(entry.row));
  return {
    entries: [...active, ...cancelled],
    done: active.filter((entry) => doneRow(entry.row)).length + hiddenDone,
    total: shown.length + hidden - cancelled.length - hiddenCancelled,
    hidden,
    hiddenCancelled,
  };
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
/** The Pending and Running tabs' list takes about 40% of the terminal, between these two widths. */
export const LIST_MIN_WIDTH = 40;
export const LIST_MAX_WIDTH = 60;
/** The object pane needs at least this many columns for the two panes to show. */
export const MIN_OBJECT_WIDTH = 55;
/** The lines above the first row of a list: a blank line and the dim title. */
export const LIST_HEAD = 2;

/** The columns of the list's text for a terminal `width` wide. */
export function listWidthFor(width: number): number {
  return Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.round(width * 0.4)));
}

/** The narrowest a plugin tab's list gets, however short its rows are. */
export const PLUGIN_LIST_MIN = 24;
/** A plugin tab's list takes about 26% of the terminal, and no more than 38 columns. */
export const PLUGIN_LIST_SHARE = 0.26;
export const PLUGIN_LIST_MAX_WIDTH = 38;

/** The most a plugin tab's list may take for a terminal `width` wide. */
function pluginListWidthFor(width: number): number {
  return Math.min(
    PLUGIN_LIST_MAX_WIDTH,
    Math.max(PLUGIN_LIST_MIN, Math.floor(width * PLUGIN_LIST_SHARE)),
  );
}

/** The columns before a row's text: marker, glyph and their spaces. */
export const ROW_INDENT = 4;

/** The columns a text takes. */
function cells(text: string): number {
  let total = 0;
  for (const char of graphemes(sanitize(text).replace(/\n/g, " "))) total += displayWidth(char);
  return total;
}

/** The row id without its type: `item:T-1-x` is `T-1-x`. */
export function bareId(id: string): string {
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
}

/** The short id and the slug of an id like `T-0031-tui-object`. */
function splitId(id: string): { readonly short: string; readonly slug: string } {
  const match = /^([A-Za-z]+-\d+)-(.+)$/.exec(id);
  if (match === null) return { short: id, slug: "" };
  return { short: match[1] ?? id, slug: match[2] ?? "" };
}

/** The short id and slug of a row, without its type or repository. */
export function rowName(row: TuiRow): string {
  if (row.unnamed === true && row.title !== "") return sanitize(row.title);
  const bare = bareId(row.id);
  const { short, slug } = splitId(bare.slice(bare.lastIndexOf("/") + 1));
  if (row.error !== undefined || slug === "") return short;
  return `${short} ${slug}`;
}

/** The parts of a row's dim line: state and badge, then the note, unless the row says. */
export function rowDetail(row: TuiRow): string {
  const parts =
    row.detail ?? [`${row.state}${row.badge === undefined ? "" : ` ${row.badge}`}`, row.note ?? ""];
  return parts
    .map((part) => sanitize(part).replace(/\n/g, " ").trim())
    .filter((part) => part !== "")
    .join(" · ");
}

/**
 * The columns of the list's text. A plugin tab's rows are a name and a note, so
 * its column is as wide as the longest of them, never past its narrower share.
 */
export function listWidth(state: TuiState): number {
  const tab = activeTabOf(state);
  if (tab?.kind !== "plugin") return listWidthFor(state.width);
  const cap = pluginListWidthFor(state.width);
  if (tab.list.rows.length === 0) return cap;
  let need = PLUGIN_LIST_MIN;
  for (const row of tab.list.rows) {
    const indent = row.bare !== true && tab.list.rows.some((one) => one.group !== undefined) ? 2 : 0;
    need = Math.max(need, ROW_INDENT + indent + cells(rowName(row)), ROW_INDENT + indent + cells(rowDetail(row)));
    if (row.group !== undefined) {
      need = Math.max(need, ROW_INDENT + cells(rowName(row.group)), ROW_INDENT + cells(rowDetail(row.group)));
    }
  }
  return Math.min(cap, need);
}

/** The divider's column: the list, then one column of padding. */
export function dividerX(state: TuiState): number {
  return LIST_X + listWidth(state) + 1;
}

/** The object pane's first column: one column of padding after the divider. */
export function rightX(state: TuiState): number {
  return dividerX(state) + 2;
}

/** The lines the body has: the header, its rule, the footer rule and the footer take four. */
export function bodyHeight(state: TuiState): number {
  return Math.max(1, state.height - 4);
}

/** The lines the page's framed header, next level and tabs take before its section. */
export function objectHeaderLines(state: TuiState): number {
  const object = state.object;
  if (object === undefined) return 0;
  const width = Math.max(1, sectionWidth(state) - 2);
  const title = object.row.title === "" ? 0 : wrapText(object.row.title, width).length;
  const children = childLines(object);
  const status =
    object.error !== undefined ||
    object.row.error !== undefined ||
    object.unavailable !== undefined ||
    pagePosition(activeSection(state)) !== undefined
      ? 1
      : 0;
  // top border, a blank rail, the title, a status line, bar/heading/rows, bottom,
  // a blank line, tabs and rule.
  return 1 + 1 + title + status + children + 1 + 1 + 2;
}

/** How many Markdown lines fit under the object's frame and tabs. */
export function sectionViewport(state: TuiState): number {
  // The hint line stays under the content.
  return Math.max(1, bodyHeight(state) - objectHeaderLines(state) - 1);
}

/** The columns a section's Markdown has in the object pane. */
export function sectionWidth(state: TuiState): number {
  const start = twoPane(state) ? rightX(state) : LIST_X;
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
    pageMarks: [],
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
  // A row of a plugin tab knows its type, so the request names it: a bare id
  // can be ambiguous across types.
  const typeName = row.type;
  const requestId =
    typeName !== undefined && !row.id.startsWith(`${typeName}:`)
      ? `${typeName}:${row.id}`
      : row.id;
  const object: TuiObject = {
    id: requestId,
    source: row.id,
    type:
      previous?.type ??
      typeName ??
      (row.id.includes(":") ? row.id.slice(0, row.id.indexOf(":")) : row.id),
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
    objectRequest: { id: requestId, version },
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
    ...(previous.children === undefined ? {} : { children: previous.children }),
    ...(previous.back === undefined ? {} : { back: previous.back }),
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
        state.objectRequest.version === previous?.version)
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

/** The offset in `joinMarkdown(before, after)` where `after` begins. */
export function markPage(before: string, after: string): number {
  return joinMarkdown(before, after).length - after.length;
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
  marks: readonly number[] | undefined,
  start: number | undefined,
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
      pageStart: jump ?? (appended ? value.pageStart : (start ?? 0)),
      pageMarks: appended
        ? [...value.pageMarks, markPage(section.markdown, content.markdown)]
        : (marks ?? []),
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

/** The layout line each loaded page starts at, for the width in force. */
let startsMemo: { key: string; starts: readonly number[] } | undefined;
function pageStarts(state: TuiState, section: TuiSection): readonly number[] {
  const width = sectionWidth(state);
  const key = `${width}\u0000${section.id}\u0000${section.version}\u0000${section.markdown.length}`;
  if (startsMemo?.key === key) return startsMemo.starts;
  const starts = section.pageMarks.map(
    (offset) => layoutMarkdown(section.markdown.slice(0, offset), width).length,
  );
  startsMemo = { key, starts };
  return starts;
}

/**
 * The page of the table of contents under the top of the pane. Without a state
 * it is the first page the text holds.
 */
export function shownPage(section: TuiSection, state?: TuiState): number {
  if (state === undefined) return section.pageStart;
  const passed = pageStarts(state, section).filter((line) => line <= section.scroll).length;
  return section.pageStart + passed;
}

/** "page 3/27 · docs/manual.md" for a section with a table of contents. */
export function pagePosition(
  section: TuiSection | undefined,
  state?: TuiState,
): string | undefined {
  const toc = section?.toc;
  if (section === undefined || toc === undefined || toc.length === 0 || !section.loaded) {
    return undefined;
  }
  const at = Math.min(shownPage(section, state), toc.length - 1);
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
  const target = shownPage(section, state) + delta;
  if (target < 0) return { ...state, notice: "first page" };
  if (target >= toc.length) return { ...state, notice: "last page" };
  return loadPage(state, target);
}

/** `p`: the page picker, when the open section has pages; otherwise nothing. */
function openPagePicker(state: TuiState): TuiState {
  const toc = activeSection(state)?.toc;
  if (toc === undefined || toc.length === 0 || state.keys) return state;
  const section = activeSection(state);
  const shown = section === undefined ? 0 : Math.min(shownPage(section, state), toc.length - 1);
  // With no query the entries are in order, so the page shown is at its index.
  return { ...state, input: { kind: "pages", query: "", cursor: shown } };
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

/** The theme list: moving shows the theme under the cursor, Enter keeps it, Esc puts the old one back. */
function themesKey(
  state: TuiState,
  input: Extract<TuiInput, { readonly kind: "themes" }>,
  event: { key: string; ctrl?: boolean | undefined },
): TuiState {
  const key = event.key.toLowerCase();
  if (key === "escape" || key === "esc") {
    return { ...state, input: undefined, themePreview: undefined };
  }
  const names = state.themeNames;
  const down = key === "down" || key === "arrowdown" || (event.ctrl === true && (key === "n" || key === "j"));
  const up = key === "up" || key === "arrowup" || (event.ctrl === true && (key === "p" || key === "k"));
  if (down || up) {
    const cursor = Math.min(Math.max(0, input.cursor + (down ? 1 : -1)), Math.max(0, names.length - 1));
    return { ...state, input: { ...input, cursor }, themePreview: names[cursor] };
  }
  if (key === "enter" || key === "return") {
    const chosen = names[input.cursor];
    if (chosen === undefined) return state;
    return {
      ...state,
      input: undefined,
      themePreview: undefined,
      themeRequest: chosen,
      themeCurrent: chosen,
    };
  }
  return state;
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
  return followLoaded(
    closeObject({ ...state, active: index, followPending: false }),
    state.tabs[index]?.id ?? "",
  );
}

/** The row the active list's cursor is on, if it can be opened. */
function selectedRow(state: TuiState): TuiRow | undefined {
  const tab = activeTabOf(state);
  const row = tab?.list.rows[tab.list.cursor];
  return row === undefined || row.openable === false ? undefined : row;
}

/** How many rows of the next level the page shows at most. */
export const CHILD_ROWS = 8;

/** The lines the next level takes in the page: the bar, its heading and its rows. */
export function childLines(object: TuiObject | undefined): number {
  const children = object?.children;
  if (children === undefined || children.rows.length + (children.hidden ?? 0) === 0) return 0;
  return Math.min(children.rows.length, CHILD_ROWS) + 2;
}

function withChildren(state: TuiState, patch: (children: TuiChildren) => TuiChildren): TuiState {
  return withObject(state, (object) =>
    object.children === undefined ? object : { ...object, children: patch(object.children) },
  );
}

/** Opens the page of the child under the page's cursor; the plan's page waits behind it. */
function openChild(state: TuiState): TuiState {
  const parent = state.object;
  const children = parent?.children;
  const shown = children === undefined ? [] : displayChildren(children.rows, state.childLayout);
  const row = shown[children?.cursor ?? 0]?.row;
  if (parent === undefined || row === undefined) return state;
  const type = row.type ?? (row.id.includes(":") ? row.id.slice(0, row.id.indexOf(":")) : "");
  const requestId = type === "" || row.id.startsWith(`${type}:`) ? row.id : `${type}:${row.id}`;
  const version = state.objectVersion + 1;
  const object: TuiObject = {
    id: requestId,
    // The left row still owns the pane: a refresh of the list does not replace it.
    source: parent.source,
    type,
    link: "",
    row,
    sections: [],
    active: 0,
    actions: [],
    loading: true,
    version,
    back: parent,
  };
  return {
    ...state,
    object,
    objectVersion: version,
    objectRequest: { id: requestId, version },
    sectionRequest: undefined,
  };
}

/** Back from a child's page to the page it was opened from; false when it has none. */
function goBack(state: TuiState): TuiState | undefined {
  const back = state.object?.back;
  if (back === undefined) return undefined;
  const version = state.objectVersion + 1;
  return {
    ...state,
    object: { ...back, version },
    objectVersion: version,
    objectRequest: { id: back.id, version },
    sectionRequest: undefined,
  };
}

/** The keys of a focused next-level list; undefined when the key is not one of them. */
function childKey(state: TuiState, key: string): TuiState | undefined {
  const children = state.object?.children;
  if (children === undefined || !children.focused) return undefined;
  if (isKey(key, "up", "arrowup", "k")) {
    return withChildren(state, (c) => ({ ...c, cursor: Math.max(0, c.cursor - 1) }));
  }
  if (isKey(key, "down", "arrowdown", "j")) {
    const count = displayChildren(children.rows, state.childLayout).length;
    return withChildren(state, (c) => ({
      ...c,
      cursor: Math.min(count - 1, c.cursor + 1),
    }));
  }
  if (isKey(key, "g")) return withChildren(state, (c) => ({ ...c, cursor: 0 }));
  if (key === "G") {
    const count = displayChildren(children.rows, state.childLayout).length;
    return withChildren(state, (c) => ({ ...c, cursor: count - 1 }));
  }
  if (isKey(key, "enter", "return")) return openChild({ ...state, followPending: false });
  if (isKey(key, "escape", "esc")) return withChildren(state, (c) => ({ ...c, focused: false }));
  return undefined;
}

/** Enter: opens the selected row; on the row that is already open, its next level. */
function enter(state: TuiState): TuiState {
  const row = selectedRow(state);
  if (row === undefined) return state;
  const open = state.object;
  if (open !== undefined && open.source === row.id && open.error === undefined) {
    // A child's page is open: the list is not where Enter acts.
    if (open.back !== undefined) return { ...state, followPending: false };
    return withChildren({ ...state, followPending: false }, (c) => ({ ...c, focused: true }));
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

/** A palette command does what its key does. */
function runCommand(state: TuiState, command: TuiCommand): TuiState {
  switch (command.kind) {
    case "help":
      return handleKey(state, { key: "?", text: "?" });
    case "refresh":
      return handleKey(state, { key: "r", text: "r" });
    case "back":
      return handleKey(state, { key: "escape" });
    case "quit":
      return handleKey(state, { key: "q", text: "q" });
    case "themes": {
      const at = state.themeNames.indexOf(state.themeCurrent);
      const cursor = Math.max(0, at);
      return {
        ...state,
        input: { kind: "themes", cursor },
        themePreview: state.themeNames[cursor],
      };
    }
    case "go":
      return activate(state, state.tabs.findIndex((tab) => tab.id === command.tabId));
  }
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
  if (typing?.kind === "themes") return themesKey(calm, typing, event);
  if (typing?.kind === "palette" && isKey(event.key, "enter", "return")) {
    const chosen = chosenEntry(calm);
    if (chosen?.command !== undefined) {
      return runCommand(remember({ ...calm, input: undefined }, chosen), chosen.command);
    }
  }
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
    return { ...state, input: { kind: "palette", query: "", cursor: 0 }, settingsRequest: true };
  }
  if (key === "?" || (key === "/" && shift)) {
    return { ...state, keys: !state.keys, helpScroll: 0 };
  }
  if (isKey(key, "q")) return { ...state, quit: true };
  if (state.keys) {
    // The list behind the key list is hidden, so no other key acts on it.
    if (isKey(key, "escape", "esc")) return { ...state, keys: false, helpScroll: 0 };
    const page = helpViewport(state);
    const bottom = Math.max(0, HELP_LINES - page);
    const at = Math.min(Math.max(0, state.helpScroll), bottom);
    const to = (row: number): TuiState => ({
      ...state,
      helpScroll: Math.min(bottom, Math.max(0, row)),
    });
    if (isKey(key, "up", "arrowup", "k")) return to(at - 1);
    if (isKey(key, "down", "arrowdown", "j")) return to(at + 1);
    if (isKey(key, "pageup", "page-up", "prior", "b")) return to(at - page);
    if (isKey(key, "pagedown", "page-down", "next", "space")) return to(at + page);
    if (isKey(key, "home")) return to(0);
    if (isKey(key, "end")) return to(bottom);
    return state;
  }
  if (isKey(key, "t") && (state.object?.children?.rows.length ?? 0) > 0) {
    const childLayout: TuiChildLayout = state.childLayout === "tree" ? "list" : "tree";
    return { ...state, childLayout, layoutRequest: childLayout, followPending: false };
  }
  const inChildren = childKey(state, key);
  if (inChildren !== undefined) return inChildren;
  if (isKey(key, "enter", "return")) return enter(state);
  if (isKey(key, "escape", "esc", "backspace")) {
    const back = goBack(state);
    if (back !== undefined) return back;
    if (isKey(key, "backspace")) return state;
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

/** What the header adds after the current plugin tab: the filter and what it hides. */
export function filterHeader(
  tab: TuiTab | undefined,
): { readonly filter: string; readonly hidden: string } | undefined {
  if (tab?.kind !== "plugin" || tab.filters === undefined || tab.filter === undefined) {
    return undefined;
  }
  const hidden =
    tab.filter !== "all" && (tab.hidden ?? 0) > 0 ? ` · ${tab.hidden} hidden` : "";
  return { filter: ` · ${tab.filter}`, hidden };
}

function typeTitle(type: TuiTypeInfo | undefined): string {
  if (type === undefined) return "";
  return type.title.length === 0 ? type.type : type.title;
}

/** The plugin a type belongs to; a server that does not say gives each type its own tab. */
function pluginOf(type: TuiTypeInfo): string {
  return type.plugin === undefined || type.plugin === "" ? type.type : type.plugin;
}

function applyTypes(state: TuiState, types: readonly TuiTypeInfo[]): TuiState {
  const fixed = state.tabs.filter((tab) => tab.kind !== "plugin");
  const existing = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const byPlugin = new Map<string, TuiTypeInfo[]>();
  for (const info of types) {
    const name = pluginOf(info);
    const group = byPlugin.get(name) ?? [];
    if (!group.some((seen) => seen.type === info.type)) group.push(info);
    byPlugin.set(name, group);
  }
  const pluginTabs: TuiTab[] = [];
  for (const [name, group] of byPlugin) {
    const id = `plugin:${name}`;
    // A server that names no plugin gives each type its own tab, titled as the type.
    const first = group[0];
    const title = first?.plugin === undefined || first.plugin === "" ? typeTitle(first) : name;
    const fresh = { ...makeTab(id, "plugin", title, group), plugin: name };
    const old = existing.get(id);
    if (old === undefined) {
      pluginTabs.push(fresh);
      continue;
    }
    // A known tab keeps its chosen filter while the plugin still declares it.
    const kept = fresh.filters?.some((f) => f.name === old.filter) === true;
    pluginTabs.push({
      ...old,
      types: group,
      filters: fresh.filters,
      filter: kept ? old.filter : fresh.filter,
    });
  }
  const tabs = [...fixed, ...pluginTabs];
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

/** The rows without the one at `at`; its group's heading moves to the next row of the group. */
function dropRow(rows: readonly TuiRow[], at: number): TuiRow[] {
  const gone = rows[at];
  const out = rows.filter((_, i) => i !== at);
  const after = out[at];
  if (
    gone?.group !== undefined &&
    after !== undefined &&
    after.group === undefined &&
    after.parent === gone.parent
  ) {
    out[at] = { ...after, group: gone.group };
  }
  return out;
}

/** Puts a fresh row in place of the rows of the same object; the cursor stays. */
function replaceRow(state: TuiState, row: TuiRow): TuiState {
  return replacePageRow(replaceListRow(state, row), row);
}

/** Puts a fresh row in place of the same object's row on the open page's next level. */
function replacePageRow(state: TuiState, row: TuiRow): TuiState {
  const children = state.object?.children;
  if (children === undefined || !children.rows.some((old) => sameObject(old.id, row.id))) {
    return state;
  }
  // The page's next level is fetched under `all`, so it never follows the tab's
  // filter: a child that becomes merged or cancelled stays where it is (T-0305).
  return withChildren(state, (c) => ({
    ...c,
    rows: c.rows.map((candidate) =>
      sameObject(candidate.id, row.id)
        ? { ...row, ...(candidate.type === undefined ? {} : { type: candidate.type }) }
        : candidate,
    ),
  }));
}

function replaceListRow(state: TuiState, row: TuiRow): TuiState {
  let changed = false;
  let selectedLeft = false;
  const tabs = state.tabs.map((tab, index) => {
    if (tab.kind !== "plugin") return tab;
    const at = tab.list.rows.findIndex((old) => sameObject(old.id, row.id));
    const shown = at < 0 ? undefined : tab.list.rows[at];
    const info = tab.types?.find((candidate) => candidate.type === shown?.type);
    const states = info?.filters?.find((f) => f.name === tab.filter)?.states;
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
      const rows = dropRow(tab.list.rows, at);
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
      return {
        ...row,
        ...(old.type === undefined ? {} : { type: old.type }),
        ...(old.parent === undefined ? {} : { parent: old.parent }),
        ...(old.group === undefined ? {} : { group: old.group }),
        ...(old.bare === true ? { bare: true } : {}),
      };
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
    if (tab.kind !== "plugin") return tab;
    const at = tab.list.rows.findIndex((row) => sameObject(row.id, id));
    if (at < 0) return tab;
    changed = true;
    const rows = dropRow(tab.list.rows, at);
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

/**
 * After a list loads or another tab is shown, the pane beside it shows the row
 * the cursor rests on, unless it already does.
 */
function followLoaded(state: TuiState, tabId: string): TuiState {
  const tab = activeTabOf(state);
  if (tab === undefined || tab.id !== tabId) return state;
  const row = tab.list.rows[tab.list.cursor];
  // An empty list leaves no row for the pane beside it to follow; a lone object page is kept.
  if (row === undefined) return twoPane(state) ? closeObject({ ...state, followPending: false }) : state;
  if (row.openable === false || state.object?.source === row.id) return state;
  // A follow already waiting keeps its debounce: restarting it on every refresh could starve it.
  if (state.followPending) return state;
  return { ...state, moveSeq: state.moveSeq + 1, followPending: true };
}

function applyPending(state: TuiState, items: readonly PendingItem[]): TuiState {
  const rows = items.map(rowFromPending);
  return followLoaded(
    withTab(state, "pending", (tab) => replaceRows(tab, rows, undefined)),
    "pending",
  );
}

function applyRunning(state: TuiState, items: readonly RunningItem[]): TuiState {
  const rows = items.map(rowFromRunning);
  return followLoaded(
    withTab(state, "running", (tab) => replaceRows(tab, rows, undefined)),
    "running",
  );
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
  // `f` changes the left list only: the open object stays, even when the new
  // filter hides its row or leaves no row at all (T-0305).
  if (wasSwitching || !replace) return cleared;
  return followLoaded(cleared, tabId);
}

/** The type a page of a tab's rows is of: the tab's first. */
function firstType(state: TuiState, tabId: string): string | undefined {
  return state.tabs.find((tab) => tab.id === tabId)?.types?.[0]?.type;
}

function rowOfEntry(entry: TuiTreeEntry): TuiRow {
  return {
    ...rowFromView(entry.row, entry.type),
    ...(entry.bare === true ? { bare: true } : {}),
    ...(entry.parent === undefined ? {} : { parent: sanitize(entry.parent) }),
    ...(entry.heading === undefined
      ? {}
      : {
          group: {
            ...rowFromView(entry.heading.row, entry.heading.type),
            ...(entry.heading.label === undefined
              ? {}
              : { unnamed: true, title: sanitize(entry.heading.label) }),
          },
        }),
  };
}

function applyChildren(
  state: TuiState,
  objectId: string,
  version: number | undefined,
  entries: readonly TuiTreeEntry[],
  hidden?: number | undefined,
  hiddenDone?: number | undefined,
  hiddenCancelled?: number | undefined,
): TuiState {
  const object = state.object;
  if (object === undefined || object.id !== objectId) return state;
  if (version !== undefined && version !== object.version) return state;
  const rows = entries.map(rowOfEntry);
  const old = object.children;
  const selected =
    old === undefined
      ? undefined
      : displayChildren(old.rows, state.childLayout)[old.cursor]?.row.id;
  const shown = displayChildren(rows, state.childLayout);
  const found = selected === undefined ? -1 : shown.findIndex((entry) => entry.row.id === selected);
  const cursor = found >= 0 ? found : Math.min(old?.cursor ?? 0, Math.max(0, shown.length - 1));
  const children: TuiChildren = {
    rows,
    cursor,
    focused: rows.length > 0 && old?.focused === true,
    ...(hidden === undefined || hidden === 0 ? {} : { hidden }),
    ...(hiddenDone === undefined ? {} : { hiddenDone }),
    ...(hiddenCancelled === undefined || hiddenCancelled === 0 ? {} : { hiddenCancelled }),
  };
  return withObject(state, (value) => ({
    ...value,
    children: rows.length === 0 && (hidden ?? 0) === 0 ? undefined : children,
  }));
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
        event.page.rows.map((row) => rowFromView(row, firstType(state, event.tabId))),
        event.page.next,
        event.replace === true,
        event.version,
        event.filter,
        event.page.hidden,
        event.filterSeq,
      );
    case "tree": {
      if (stale(state, event.generation)) return state;
      const rows = event.entries.map(rowOfEntry);
      const next = appendPage(
        state,
        event.tabId,
        rows,
        undefined,
        true,
        undefined,
        event.filter,
        event.hidden,
        event.filterSeq,
      );
      if (next === state) return state;
      return withTab(next, event.tabId, (tab) => ({ ...tab, level: event.level }));
    }
    case "children":
      return applyChildren(
        state,
        event.objectId,
        event.version,
        event.entries,
        event.hidden,
        event.hiddenDone,
        event.hiddenCancelled,
      );
    case "filter-launched":
      return state.filterRequest === undefined
        ? state
        : { ...state, filterRequest: undefined };
    case "rows":
      return appendPage(
        state,
        event.tabId,
        event.rows.map((row) => rowFromView(row, firstType(state, event.tabId))),
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
        event.marks,
        event.start,
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
    case "theme-names":
      return {
        ...state,
        themeNames: event.names,
        themeCurrent: event.current,
        // A theme file removed while the list is open must not leave the cursor past the end.
        ...(state.input?.kind === "themes"
          ? { input: { ...state.input, cursor: Math.min(state.input.cursor, Math.max(0, event.names.length - 1)) } }
          : {}),
      };
    case "theme-launched":
      return { ...state, themeRequest: undefined };
    case "layout-launched":
      return state.layoutRequest === undefined
        ? state
        : { ...state, layoutRequest: undefined };
    case "action-launched":
      return state.actionRequest === undefined
        ? state
        : { ...state, actionRequest: undefined };
    case "setting-launched":
      return { ...state, settingRequest: undefined, settingsRequest: false };
    case "settings":
      return { ...state, settings: event.settings };
    case "action-done":
      return {
        ...(event.notice === undefined ? state : withNotice(state, event.notice)),
        acting: false,
        actionRequest: undefined,
      };
    case "action-error":
      return actionFailed(state, event.message);
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
  // The list's own width decides: a plugin tab's narrower column leaves room
  // for the object pane sooner than the Pending and Running tabs' wider one.
  const right = LIST_X + listWidth(state) + 3;
  return state.width - right - 1 >= MIN_OBJECT_WIDTH;
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
    .filter((tab) => tab.kind === "plugin")
    .map((tab) => tab.title);
  return `operad ─ ${[
    `Pending ${pending?.list.rows.length ?? 0}`,
    `Running ${running?.list.rows.length ?? 0}`,
    ...types,
  ].join(" · ")}`;
}

/** One footer hint: its key, when it has one, and what the key does. */
export interface TuiFooterSegment {
  readonly key?: string | undefined;
  readonly hint: string;
}

/** The footer's hints in reading order; the keys are drawn in the text colour and the rest weak. */
export function footerSegments(state: TuiState): readonly TuiFooterSegment[] {
  const segments: TuiFooterSegment[] = [];
  const add = (key: string | undefined, hint: string): void => {
    segments.push(key === undefined ? { hint } : { key, hint });
  };
  const object = state.object;
  const main = mainAction(state);
  if (object !== undefined && main !== undefined) {
    add(mainKey(state), main.name);
    if (object.actions.length > 1) add(":", "more");
  }
  const filtering = filterKeyApplies(state);
  if (object === undefined) {
    add("j/k", "move");
    add("enter", "open");
    add("1-9", "tab");
    add("g/G", "ends");
    if (filtering) add("f", "filter");
    add("r", "refresh");
    add("?", "keys");
    add("q", "quit");
  } else if (twoPane(state)) {
    const section = activeSection(state);
    const capped = section !== undefined && section.capped && !section.full;
    add("j/k", "row");
    add("space/b", "scroll");
    add("[ ]", "section");
    if (pagePosition(section) !== undefined) {
      add("p", "pages");
      add("n/N", "page");
    }
    add("f", filtering && !capped ? "filter" : "full");
    if (object.children !== undefined) add("t", state.childLayout === "tree" ? "list" : "tree");
    add("esc", "close");
    add("?", "keys");
    add("q", "quit");
  } else {
    add("j/k", "scroll");
    add("space/b", "page");
    add("g/G", "ends");
    add("[ ]", "section");
    if (pagePosition(activeSection(state)) !== undefined) {
      add("p", "pages");
      add("n/N", "page");
    }
    add("f", "full");
    if (object.children !== undefined) add("t", state.childLayout === "tree" ? "list" : "tree");
    add("esc", "back");
    add("?", "keys");
    add("q", "quit");
  }
  if (state.keys) add("?", "closes the key list");
  return segments;
}

/** The footer for the current screen. */
export function footerText(state: TuiState): string {
  return footerSegments(state)
    .map((segment) => (segment.key === undefined ? segment.hint : `${segment.key} ${segment.hint}`))
    .join(" · ");
}

/** Groups of keys, shown with a blank line between them. */
export const KEY_GROUPS: readonly (readonly (readonly [string, string])[])[] = [
  [
    ["1–9", "open that tab (closes the open object)"],
    ["tab / shift-tab", "next or previous tab"],
  ],
  [
    ["↑↓ / j k", "move the row; on a narrow screen with an object open, scroll it"],
    ["g / G", "first or last row; on a narrow screen with an object open, its top or bottom"],
    ["enter", "open the selected row (on a narrow screen); on the open row, move into its list; there, open the row"],
  ],
  [
    ["PgUp PgDn / b space", "scroll the open section a page"],
    ["Home / End", "top of the open section, or its end (follows a live one)"],
    ["[ ] / ← →", "the previous or next section"],
  ],
  [
    ["p", "pick a page of the open section (when it has pages)"],
    ["n / N", "the next or previous page of the open section"],
    ["f", "load the whole open section when it is capped; otherwise, on a tab with filters, the next filter"],
    ["t", "switch the child list between tree and list"],
  ],
  [
    ["r", "fetch the lists again"],
    ["escape / backspace", "close the key list, leave a list inside the open object, return from a row opened there, or close the object"],
    ["?", "show or hide this key list"],
    ["q", "quit"],
  ],
];

/** Every key the TUI reads, in the order the key list shows them. */
export const KEY_LIST: readonly (readonly [string, string])[] = KEY_GROUPS.flat();

/** The rows the full key list takes: a heading, its keys, and a blank line between groups. */
export const HELP_LINES = KEY_LIST.length + KEY_GROUPS.length;

/** The key list rows the terminal shows at once; a short terminal scrolls the rest. */
export function helpViewport(state: TuiState): number {
  return Math.max(1, Math.min(HELP_LINES + 4, state.height) - 4);
}

/** The lines one object takes in a list: two, and the blank line after them. */
export const ROW_LINES = 3;

/** The lines one row takes; an error row shows its text elsewhere. */
export function rowLines(row: TuiRow): number {
  return ROW_LINES * (row.group === undefined ? 1 : 2);
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
  // The blank line after the last object is not drawn, so it needs no room.
  const room = Math.max(1, Math.trunc(available) - tail + 1);
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
