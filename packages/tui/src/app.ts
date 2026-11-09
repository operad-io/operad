/**
 * `operad tui`: discover the server, open the full-screen view, keep the state
 * fed from `/v1` and the event stream, and send keys through the reducer. It
 * never opens the store and never loads a plugin.
 */

import {
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
} from "@opentui/core";
import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewRow,
  ViewSectionContent,
} from "@operad-io/engine";
import { ensureServer, spawnServe, type EnsureServerOptions } from "./autostart.ts";
import {
  TuiClient,
  TuiError,
  type FetchLike,
  type TuiActInput,
  type TuiKeyBinding,
} from "./client.ts";
import { defaultOperadHome } from "@operad-io/engine";
import { loadRecent, saveRecent } from "./recent.ts";
import { discoverServer } from "./discover.ts";
import { TuiEvents, retryDelay, type TuiEvent } from "./events.ts";
import {
  LiveBatcher,
  connectionOf,
  refetchTargets,
  systemClock,
  type Refetch,
  type TuiClock,
} from "./live.ts";
import {
  initialState,
  sameObject,
  type TuiObject,
  joinMarkdown,
  reduce,
  type TuiActionRequest,
  type TuiSettingRequest,
  type TuiObjectRequest,
  type TuiFilterRequest,
  type TuiPageRequest,
  type TuiSectionRequest,
  type TuiState,
  type TuiStateEvent,
  type TuiTheme,
} from "./state.ts";
import { chooseSelection, watchThemes, type ThemeHolder } from "./theme.ts";
import { createTuiView, type TuiView } from "./view/index.ts";
import type { TuiSetInput, TuiSetting, TuiTypeInfo } from "./client.ts";
import { settingScopes } from "./actions.ts";

/** How `operad tui` finds its server and reports a problem. */
export interface TuiRunOptions {
  readonly home?: string | undefined;
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  /** Closes the app from outside, as a signal would. */
  readonly signal?: AbortSignal | undefined;
  /**
   * A non-fatal client or stream error. The messages are kept while the screen
   * is open and passed here one by one after the terminal is restored.
   */
  readonly onError?: ((message: string) => void) | undefined;
  /** Never start `operad serve`, even when none answers. */
  readonly noStart?: boolean | undefined;
  /** The `operad` entry file a started serve runs; without it none is started. */
  readonly serveEntry?: string | undefined;
  /** Prints a line before the full screen opens. */
  readonly write?: ((line: string) => void) | undefined;
  /** `--theme`: the theme name for this session; it beats `tui.json`. */
  readonly theme?: string | undefined;
  /** Replaces the terminal pieces in a test. */
  readonly hooks?: TuiRunHooks | undefined;
}

/** The terminal pieces `runTui` builds, so a test can hand it others. */
export interface TuiRunHooks {
  readonly renderer?: (() => Promise<CliRenderer>) | undefined;
  readonly view?: ((renderer: CliRenderer) => TuiView) | undefined;
  /** Replaces the check that a serve answers, and its start. */
  readonly ensure?:
    | ((options: EnsureServerOptions) => Promise<string>)
    | undefined;
  readonly fetch?: FetchLike | undefined;
}

/** One key press, as far as the reducer cares. */
export interface TuiKeyInput {
  readonly name: string;
  readonly sequence?: string | undefined;
  readonly shift?: boolean | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
}

/** The calls the shell makes; `TuiClient` has them, and a test fakes them. */
export interface TuiShellClient {
  types(signal?: AbortSignal): Promise<{ readonly types: readonly TuiTypeInfo[] }>;
  pending(signal?: AbortSignal): Promise<readonly PendingItem[]>;
  running(signal?: AbortSignal): Promise<readonly RunningItem[]>;
  objects(
    type: string,
    cursor?: string,
    signal?: AbortSignal,
    filter?: string,
  ): Promise<ViewListPage>;
  /** Optional: a server without `/v1/keys` leaves the bindings empty. */
  keys?(signal?: AbortSignal): Promise<readonly TuiKeyBinding[]>;
  /** Optional: a server without `/v1/settings` lists none. */
  settings?(scope?: string, signal?: AbortSignal): Promise<readonly TuiSetting[]>;
  /** Optional: changes one setting. */
  setSetting?(input: TuiSetInput): Promise<unknown>;
  /** Optional so an older test client still fits; the actions need it. */
  act?(input: TuiActInput): Promise<unknown>;
  /** Optional so an older test client still fits; the object pane needs it. */
  object?(id: string, signal?: AbortSignal): Promise<ViewObject>;
  /** Optional so an older test client still fits; the object pane needs it. */
  section?(
    id: string,
    section: string,
    options?: {
      readonly cursor?: string | undefined;
      readonly full?: boolean | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<ViewSectionContent>;
}

/** The change stream the shell reads; `TuiEvents` has this shape. */
export interface TuiEventSource extends AsyncIterable<TuiEvent> {
  stop(): void;
}

/** Everything the shell needs from outside; no terminal handle is in here. */
export interface TuiShellDeps {
  readonly client: TuiShellClient;
  /** Opens the change stream; `signal` aborts it when the shell stops. */
  readonly events: (signal: AbortSignal) => TuiEventSource;
  readonly view: TuiView;
  readonly width: number;
  readonly height: number;
  readonly theme: TuiTheme;
  /** Where a refusal's status goes: a log, never the screen. */
  readonly onLog?: ((message: string) => void) | undefined;
  /** A failed request; the page shows it too, and the app goes on. */
  readonly onMessage?: ((message: string) => void) | undefined;
  /**
   * An error the app cannot go on from: the shell stops (`done` resolves 1)
   * after this is called, and the caller reports it once the screen is gone.
   */
  readonly onFatal?: ((message: string) => void) | undefined;
  /** Called once when the shell finishes, before `done` resolves. */
  readonly onFinish?: (() => void) | undefined;
  /** Spaces the live refetches and the retries; the real clock by default. */
  readonly clock?: TuiClock | undefined;
  /** The server's URL, named when it does not answer. */
  readonly url?: string | undefined;
  /**
   * The wait after the list cursor stops before the object pane follows it, so
   * scrolling fast does not fetch every row; 150 by default.
   */
  readonly followDelayMs?: number | undefined;
  /** The palette entries used in earlier runs, the latest first. */
  readonly recent?: readonly string[] | undefined;
  /** Called with the list of recent entries each time it changes. */
  readonly onRecent?: ((recent: readonly string[]) => void) | undefined;
}

/** A running shell: feed it keys and sizes, and wait for `done`. */
export interface TuiShell {
  readonly state: TuiState;
  key(input: TuiKeyInput): void;
  resize(width: number, height: number): void;
  setTheme(theme: TuiTheme): void;
  /** Repaints after the theme files changed; `problem` is shown in the footer, none clears it. */
  repaintTheme(problem?: string): void;
  stop(): void;
  /** Resolves with the exit code once the shell has finished. */
  readonly done: Promise<number>;
}

/** Starts the footer line that says a changed theme file was not applied. */
const THEME_PROBLEM = "theme not changed:";

/** The signals that close the app cleanly. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** A settle result without throwing away the error's text. */
type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function themeOf(renderer: CliRenderer, fallback: TuiTheme): TuiTheme {
  return renderer.themeMode ?? fallback;
}

/**
 * The app without a terminal: it keeps the state fed from the client and the
 * change stream, and sends keys through the reducer. `runTui` wires it to a
 * renderer; a test wires it to fakes.
 */
export function startShell(deps: TuiShellDeps): TuiShell {
  const { client, view } = deps;
  const abort = new AbortController();
  const report = (error: unknown): void => deps.onMessage?.(messageOf(error));

  let state: TuiState = initialState({
    width: deps.width,
    height: deps.height,
    theme: deps.theme,
    url: deps.url,
    recent: deps.recent,
  });
  let finished = false;
  let refreshAbort: AbortController | undefined;
  // The requests of the open object: its read and its section pages. They end
  // when the object closes or another one opens, and at no other time, so
  // switching sections never cancels a page another section is waiting for.
  const objectRequests = new Set<AbortController>();
  let seenObject: number | undefined;
  let seenMove = 0;
  const clock = deps.clock ?? systemClock;
  let retryCancel: (() => void) | undefined;
  let retryAttempt = 0;
  const batcher = new LiveBatcher(clock, (targets) => guard(refetch(targets)));
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  let events: TuiEventSource | undefined;
  let announce: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    announce = resolve;
  });

  /** An unexpected rejection ends the app, through the same exit as `q`. */
  function guard(work: Promise<void>): void {
    work.catch(fatal);
  }

  function fatal(error: unknown): void {
    if (finished) return;
    try {
      deps.onFatal?.(messageOf(error));
    } finally {
      finish(1);
    }
  }

  function finish(code = 0): void {
    if (finished) return;
    finished = true;
    batcher.stop();
    retryCancel?.();
    retryCancel = undefined;
    if (followTimer !== undefined) {
      clearTimeout(followTimer);
      followTimer = undefined;
    }
    refreshAbort?.abort();
    for (const request of objectRequests) request.abort();
    objectRequests.clear();
    events?.stop();
    abort.abort();
    try {
      deps.onFinish?.();
    } finally {
      announce(code);
    }
  }

  /** A request that failed to reach the server, or was refused its token. */
  function noteConnection(error: unknown): boolean {
    const lost = connectionOf(error);
    if (lost === undefined) return false;
    // A 401 is terminal: a later transport failure does not replace it.
    if (state.connection === "unauthorized" && lost !== "unauthorized") return true;
    dispatch({ type: "connection", connection: lost });
    if (lost === "unauthorized" && retryCancel !== undefined) {
      retryCancel();
      retryCancel = undefined;
    }
    if (lost === "unauthorized") batcher.stop();
    // Whoever lost the server, the lists are asked for again with backoff.
    if (lost === "unreachable") scheduleRetry();
    return true;
  }

  async function loadPage(request: TuiPageRequest): Promise<void> {
    const tab = state.tabs.find((candidate) => candidate.id === request.tabId);
    if (tab?.type === undefined) return;
    try {
      const page = await client.objects(tab.type, request.cursor, abort.signal, tab.filter);
      dispatch({
        type: "page",
        tabId: request.tabId,
        page,
        version: request.version,
        filter: tab.filter,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      noteConnection(error);
      dispatch({
        type: "page-error",
        tabId: request.tabId,
        message: messageOf(error),
        version: request.version,
      });
      report(error);
    }
  }

  async function loadObject(request: TuiObjectRequest): Promise<void> {
    const open = client.object;
    if (open === undefined) return;
    const mine = new AbortController();
    objectRequests.add(mine);
    try {
      const object = await open.call(client, request.id, mine.signal);
      dispatch({ type: "object", object, version: request.version });
    } catch (error) {
      if (mine.signal.aborted) return;
      noteConnection(error);
      dispatch({
        type: "object-error",
        id: request.id,
        message: messageOf(error),
        version: request.version,
      });
      report(error);
    } finally {
      objectRequests.delete(mine);
    }
  }

  /**
   * The id a request sends: the open object's answer carries a bare id, and a
   * bare id can be ambiguous across types, so the type goes in front of it.
   */
  function wire(id: string): string {
    const open = state.object;
    if (open === undefined || open.id !== id || id.startsWith(`${open.type}:`)) return id;
    return `${open.type}:${id}`;
  }

  async function loadSection(request: TuiSectionRequest): Promise<void> {
    const load = client.section;
    if (load === undefined) return;
    const mine = new AbortController();
    objectRequests.add(mine);
    try {
      const content = await load.call(client, wire(request.objectId), request.sectionId, {
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.full ? { full: true } : {}),
        signal: mine.signal,
      });
      dispatch({
        type: "section",
        objectId: request.objectId,
        sectionId: request.sectionId,
        content,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.jump === undefined ? {} : { jump: request.jump }),
        full: request.full,
        version: request.version,
        objectVersion: request.objectVersion,
      });
    } catch (error) {
      if (mine.signal.aborted) return;
      noteConnection(error);
      dispatch({
        type: "section-error",
        objectId: request.objectId,
        sectionId: request.sectionId,
        message: messageOf(error),
        version: request.version,
        objectVersion: request.objectVersion,
      });
      report(error);
    } finally {
      objectRequests.delete(mine);
    }
  }

  /**
   * Reads a section from its first page to as many pages as it holds now, so a
   * refresh keeps what the person paged to instead of cutting it back to one.
   */
  async function fetchSectionDepth(
    id: string,
    sectionId: string,
    pages: number,
    full: boolean,
    signal: AbortSignal,
  ): Promise<{ readonly content: ViewSectionContent; readonly pages: number } | undefined> {
    const load = client.section;
    if (load === undefined) return undefined;
    let markdown = "";
    let next: string | undefined;
    let cursor: string | undefined;
    let read = 0;
    do {
      const content = await load.call(client, wire(id), sectionId, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(full ? { full: true } : {}),
        signal,
      });
      markdown = read === 0 ? content.markdown : joinMarkdown(markdown, content.markdown);
      next = content.next;
      cursor = next;
      read += 1;
    } while (next !== undefined && read < Math.max(1, pages));
    return {
      content: next === undefined ? { markdown } : { markdown, next },
      pages: read,
    };
  }

  /** Reads a type's first page, and more until it is as deep as it was. */
  async function fetchTypeRows(
    type: string,
    depth: number,
    signal: AbortSignal,
    filter?: string,
  ): Promise<ViewListPage> {
    const rows: ViewRow[] = [];
    let cursor: string | undefined;
    let next: string | undefined;
    let hidden: number | undefined;
    do {
      const page = await client.objects(type, cursor, signal, filter);
      rows.push(...page.rows);
      hidden ??= page.hidden;
      next = page.next;
      cursor = next;
    } while (next !== undefined && rows.length < depth);
    return {
      rows,
      ...(next === undefined ? {} : { next }),
      ...(hidden === undefined ? {} : { hidden }),
    };
  }

  /** The first page of a tab under the filter `f` chose. */
  async function loadFilter(request: TuiFilterRequest): Promise<void> {
    const tab = state.tabs.find((candidate) => candidate.id === request.tabId);
    if (tab?.type === undefined) return;
    try {
      const page = await client.objects(tab.type, undefined, abort.signal, request.filter);
      dispatch({
        type: "page",
        tabId: request.tabId,
        page,
        replace: true,
        filter: request.filter,
        filterSeq: request.seq,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      noteConnection(error);
      dispatch({ type: "page-error", tabId: request.tabId, message: messageOf(error) });
      report(error);
    }
  }

  async function refresh(): Promise<void> {
    if (finished) return;
    refreshAbort?.abort();
    const mine = new AbortController();
    refreshAbort = mine;
    const signal = mine.signal;
    dispatch({ type: "refresh-start" });
    const generation = state.generation;
    const objectAtStart = state.object;
    const filtersAtStart = new Map(
      state.tabs.map((tab) => [tab.id, { filter: tab.filter, seq: tab.filterSeq ?? 0 }] as const),
    );
    const depths = new Map(
      state.tabs.map((tab) => [tab.id, tab.list.rows.length] as const),
    );
    let failed = false;
    let lost = false;

    // A request that the next refresh cancelled says nothing.
    const fail = (error: unknown): void => {
      if (signal.aborted || finished) return;
      failed = true;
      if (noteConnection(error)) lost = true;
      dispatch({ type: "status", message: messageOf(error), generation });
      report(error);
    };

    const asked = Promise.all([
      settle(client.types(signal)),
      settle(client.pending(signal)),
      settle(client.running(signal)),
      // An older server has no keys; the bindings then stay as they were.
      settle(client.keys?.(signal) ?? Promise.resolve(undefined)),
    ]);
    const [typesResult, pending, running, keys] = await asked;
    if (keys.ok && keys.value !== undefined) {
      dispatch({ type: "keys", bindings: keys.value, generation });
    }
    if (typesResult.ok) {
      dispatch({ type: "types", types: typesResult.value.types, generation });
    } else {
      fail(typesResult.error);
    }
    if (pending.ok) dispatch({ type: "pending", items: pending.value, generation });
    else fail(pending.error);
    if (running.ok) dispatch({ type: "running", items: running.value, generation });
    else fail(running.error);

    if (typesResult.ok) {
      await Promise.all(
        typesResult.value.types.map(async (info) => {
          const tabId = `type:${info.type}`;
          const current = state.tabs.find((tab) => tab.id === tabId);
          const asked =
            filtersAtStart.get(tabId) ??
            (current === undefined
              ? undefined
              : { filter: current.filter, seq: current.filterSeq ?? 0 });
          const filter = asked?.filter;
          const filterSeq = asked?.seq ?? 0;
          const result = await settle(
            fetchTypeRows(info.type, depths.get(tabId) ?? 0, signal, filter),
          );
          if (signal.aborted || finished) return;
          if (result.ok) {
            dispatch({
              type: "page",
              tabId,
              page: result.value,
              replace: true,
              generation,
              filter,
              filterSeq,
            });
          } else {
            dispatch({
              type: "page-error",
              tabId,
              message: messageOf(result.error),
            });
            fail(result.error);
          }
        }),
      );
    }
    await refreshObjectPane(signal, objectAtStart, fail);
    if (signal.aborted || finished) return;
    if (!lost && state.connection !== "unauthorized") {
      dispatch({ type: "connection", connection: "ok" });
      retryAttempt = 0;
    }
    if (!failed) dispatch({ type: "status", generation });
    if (state.connection === "unreachable") scheduleRetry();
  }

  /** While the server does not answer, ask again with growing waits. */
  function scheduleRetry(): void {
    if (retryCancel !== undefined || finished) return;
    if (state.connection === "unauthorized") return;
    const delay = retryDelay(retryAttempt);
    retryAttempt += 1;
    retryCancel = clock.after(() => {
      retryCancel = undefined;
      requestRefresh();
    }, delay);
  }

  /** Fetches the targets an event asked for; a lost server asks for everything. */
  async function refetch(targets: Refetch): Promise<void> {
    if (finished || state.connection === "unauthorized") return;
    if (targets.all || state.connection !== "ok") {
      await refresh();
      return;
    }
    const signal = abort.signal;
    const fail = (error: unknown): void => {
      if (signal.aborted || finished) return;
      if (noteConnection(error)) {
        if (state.connection === "unreachable") scheduleRetry();
        return;
      }
      dispatch({ type: "status", message: messageOf(error) });
      report(error);
    };
    const work: Promise<void>[] = [];
    if (targets.lists) work.push(refreshPendingRunning(signal, fail));
    for (const id of targets.rows) {
      if (targets.object && state.object !== undefined && sameObject(state.object.id, id)) {
        continue;
      }
      work.push(refreshRow(id, signal, fail));
    }
    if (targets.object) {
      work.push(refreshObjectPane(signal, state.object, fail));
    }
    await Promise.all(work);
  }

  async function refreshPendingRunning(
    signal: AbortSignal,
    fail: (error: unknown) => void,
  ): Promise<void> {
    const [pending, running] = await Promise.all([
      settle(client.pending(signal)),
      settle(client.running(signal)),
    ]);
    if (signal.aborted || finished) return;
    if (pending.ok) dispatch({ type: "pending", items: pending.value });
    else fail(pending.error);
    if (running.ok) dispatch({ type: "running", items: running.value });
    else fail(running.error);
  }

  /**
   * Fetches one row again. An object that no open list holds yet (a new one)
   * refetches the list of its type instead.
   */
  async function refreshRow(
    id: string,
    signal: AbortSignal,
    fail: (error: unknown) => void,
  ): Promise<void> {
    const read = client.object;
    if (read === undefined) return;
    const result = await settle(read.call(client, id, signal));
    if (signal.aborted || finished) return;
    if (!result.ok) {
      // An object that is gone from the server is not a failure of the screen.
      if (result.error instanceof TuiError && result.error.status === 404) {
        dispatch({ type: "row-gone", id });
      } else {
        fail(result.error);
      }
      return;
    }
    const known = state.tabs.some(
      (tab) => tab.kind === "type" && tab.list.rows.some((row) => sameObject(row.id, id)),
    );
    if (known) {
      dispatch({ type: "row", row: result.value.row });
      return;
    }
    const tab = state.tabs.find((candidate) => candidate.type === result.value.type);
    if (tab?.type === undefined) return;
    const filter = tab.filter;
    const filterSeq = tab.filterSeq ?? 0;
    const page = await settle(fetchTypeRows(tab.type, tab.list.rows.length, signal, filter));
    if (signal.aborted || finished) return;
    if (page.ok) {
      dispatch({ type: "page", tabId: tab.id, page: page.value, replace: true, filter, filterSeq });
    }
    else fail(page.error);
  }

  /** Fetches the open object again, and the live sections it shows. */
  async function refreshObjectPane(
    signal: AbortSignal,
    objectAtStart: TuiObject | undefined,
    fail: (error: unknown) => void,
  ): Promise<void> {
  const open = state.object;
  if (
    open !== undefined &&
    objectAtStart !== undefined &&
    open.id === objectAtStart.id &&
    open.version === objectAtStart.version &&
    !open.loading &&
    client.object !== undefined &&
    !signal.aborted &&
    !finished
  ) {
    const id = open.id;
    const version = open.version;
    // The object's own requests end with it (Esc, another open), not only
    // with this refresh.
    const scoped = new AbortController();
    const stop = (): void => scoped.abort();
    signal.addEventListener("abort", stop, { once: true });
    objectRequests.add(scoped);
    try {
      const result = await settle(client.object(wire(id), scoped.signal));
      if (!scoped.signal.aborted && !finished) {
        if (result.ok) {
          dispatch({ type: "object", object: result.value, version });
          dispatch({ type: "row", row: result.value.row });
          const current = state.object;
          const live =
            current?.sections.filter(
              (section) => section.live && section.loaded && !section.loading,
            ) ?? [];
          if (client.section !== undefined) {
            await Promise.all(
              live.map(async (section) => {
                const objectId = current?.id ?? id;
                const objectVersion = current?.version ?? version;
                const fetched = await settle(
                  fetchSectionDepth(
                    objectId,
                    section.id,
                    section.pages,
                    section.full,
                    scoped.signal,
                  ),
                );
                if (scoped.signal.aborted || finished) return;
                if (!fetched.ok) {
                  if (!noteConnection(fetched.error)) {
                    dispatch({
                      type: "section-error",
                      objectId,
                      sectionId: section.id,
                      message: messageOf(fetched.error),
                      version: section.version,
                      objectVersion,
                    });
                  }
                  return;
                }
                if (fetched.value === undefined) return;
                dispatch({
                  type: "section",
                  objectId,
                  sectionId: section.id,
                  content: fetched.value.content,
                  pages: fetched.value.pages,
                  full: section.full,
                  version: section.version,
                  objectVersion,
                });
              }),
            );
          }
        } else {
          if (result.error instanceof TuiError && result.error.status === 404) {
            dispatch({ type: "row-gone", id });
          }
          dispatch({
            type: "object-error",
            id,
            message: messageOf(result.error),
            version,
          });
          fail(result.error);
        }
      }
    } finally {
      signal.removeEventListener("abort", stop);
      objectRequests.delete(scoped);
    }
  }
  }

  /** Sends one action; a success refreshes the object and its list row. */
  async function sendAction(request: TuiActionRequest): Promise<void> {
    const act = client.act;
    if (act === undefined) {
      dispatch({ type: "action-error", message: "this client cannot run actions" });
      return;
    }
    try {
      await act.call(client, {
        action: request.action,
        id: wire(request.id),
        ...(request.note === undefined ? {} : { note: request.note }),
        ...(request.args === undefined ? {} : { args: request.args }),
        ...(request.confirmed === true ? { confirmed: true } : {}),
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      dispatch({ type: "action-done" });
      requestRefresh();
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof TuiError && error.status !== undefined) {
        deps.onLog?.(`action ${request.action} ${request.id}: ${error.status} ${messageOf(error)}`);
      }
      dispatch({
        type: "action-error",
        message: messageOf(error),
        status: error instanceof TuiError ? error.status : undefined,
      });
    }
  }

  /** Reads the settings of the scopes the palette lists; a scope that cannot be read adds none. */
  async function loadSettings(): Promise<void> {
    const list = client.settings;
    if (list === undefined) return;
    const scopes = settingScopes(state);
    const found = await Promise.all(
      scopes.map((scope) => settle(list.call(client, scope, abort.signal))),
    );
    if (abort.signal.aborted || finished) return;
    dispatch({
      type: "settings",
      settings: found.flatMap((result) => (result.ok ? result.value : [])),
    });
  }

  /** Sends one setting change; the server's refusal comes back as the footer notice. */
  async function sendSetting(request: TuiSettingRequest): Promise<void> {
    const set = client.setSetting;
    if (set === undefined) {
      dispatch({ type: "action-error", message: "this client cannot change settings" });
      return;
    }
    try {
      await set.call(client, {
        name: request.name,
        value: request.value,
        scope: request.scope,
        ...(request.confirmed === true ? { confirmed: true } : {}),
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      dispatch({ type: "action-done" });
      await loadSettings();
    } catch (error) {
      if (abort.signal.aborted) return;
      dispatch({
        type: "action-error",
        message: messageOf(error),
        status: error instanceof TuiError ? error.status : undefined,
      });
    }
  }

  function requestRefresh(): void {
    if (finished) return;
    guard(refresh());
  }

  function dispatch(event: TuiStateEvent): void {
    if (finished) return;
    const before = state.recent;
    state = reduce(state, event);
    if (state.recent !== before) deps.onRecent?.(state.recent);
    // A request is asked for once: it leaves the state as it is launched.
    const request = state.pageRequest;
    if (request !== undefined) state = reduce(state, { type: "page-launched" });
    const objectRequest = state.objectRequest;
    if (objectRequest !== undefined) {
      state = reduce(state, { type: "object-launched" });
    }
    const sectionRequest = state.sectionRequest;
    if (sectionRequest !== undefined) {
      state = reduce(state, { type: "section-launched" });
    }
    const filterRequest = state.filterRequest;
    if (filterRequest !== undefined) state = reduce(state, { type: "filter-launched" });
    const actionRequest = state.actionRequest;
    if (actionRequest !== undefined) state = reduce(state, { type: "action-launched" });
    const settingRequest = state.settingRequest;
    const settingsRequested = state.settingsRequest;
    if (settingRequest !== undefined || settingsRequested) {
      state = reduce(state, { type: "setting-launched" });
    }
    const refreshing = state.refreshRequested;
    if (refreshing) state = reduce(state, { type: "refreshed" });
    // Requests belong to the object version that asked: another open, or a
    // close, ends them.
    if (state.object?.version !== seenObject) {
      seenObject = state.object?.version;
      for (const pending of objectRequests) pending.abort();
      objectRequests.clear();
    }
    if (state.moveSeq !== seenMove) {
      seenMove = state.moveSeq;
      if (followTimer !== undefined) clearTimeout(followTimer);
      followTimer = state.followPending
        ? setTimeout(() => {
            followTimer = undefined;
            dispatch({ type: "follow" });
          }, deps.followDelayMs ?? 150)
        : undefined;
    }
    view.render(state);
    if (state.quit) {
      finish();
      return;
    }
    if (request !== undefined) guard(loadPage(request));
    if (filterRequest !== undefined) guard(loadFilter(filterRequest));
    if (objectRequest !== undefined) guard(loadObject(objectRequest));
    if (sectionRequest !== undefined) guard(loadSection(sectionRequest));
    if (actionRequest !== undefined) guard(sendAction(actionRequest));
    if (settingRequest !== undefined) guard(sendSetting(settingRequest));
    if (settingsRequested) guard(loadSettings());
    if (refreshing) requestRefresh();
  }

  view.render(state);
  requestRefresh();
  events = deps.events(abort.signal);
  const source = events;
  void (async () => {
    try {
      for await (const event of source) {
        if (finished) break;
        if (event.kind === "change" || event.kind === "reset") {
          batcher.push(refetchTargets(event, state.object?.id));
        } else if (noteConnection(event.error)) {
          report(event.error);
        } else {
          dispatch({ type: "status", message: event.error.message });
          report(event.error);
        }
      }
    } catch (error) {
      // A stream that throws cannot be read again.
      fatal(error);
    }
  })();

  return {
    get state(): TuiState {
      return state;
    },
    key(input: TuiKeyInput): void {
      const sequence = input.sequence ?? "";
      const plain = input.ctrl !== true && input.meta !== true;
      // A key that types text reaches an input as that text (a space is "space"
      // by name); a symbol is named by itself, so `?` and `:` bind and match.
      const text = plain && sequence.length > 0 && !/[\u0000-\u001f\u007f]/.test(sequence)
        ? sequence
        : undefined;
      const symbol = text !== undefined && /^[^\p{L}\p{N}\s]$/u.test(text);
      const name = symbol ? text : input.name;
      dispatch({
        type: "key",
        key: name,
        text,
        shift: input.shift,
        ctrl: input.ctrl,
        meta: input.meta,
      });
    },
    resize(width: number, height: number): void {
      dispatch({ type: "resize", width, height });
    },
    setTheme(theme: TuiTheme): void {
      dispatch({ type: "theme", theme });
    },
    repaintTheme(problem?: string): void {
      if (problem !== undefined) {
        dispatch({ type: "status", message: `${THEME_PROBLEM} ${problem}` });
      } else if (state.status?.startsWith(THEME_PROBLEM) === true) {
        // Clear the line only when it is still ours.
        dispatch({ type: "status" });
      } else {
        dispatch({ type: "theme", theme: state.theme });
      }
    },
    stop: () => finish(),
    done,
  };
}

/**
 * Runs the terminal app until `q`, Ctrl-C or `signal`. It resolves with the
 * command exit code; a discovery error is thrown before the screen opens. The
 * terminal is restored whatever happens, and the messages the app collected are
 * reported after that.
 */
export async function runTui(options: TuiRunOptions = {}): Promise<number> {
  // A broken config or an unknown theme stops here, before a server is started.
  const themeHome = options.home ?? defaultOperadHome();
  const holder: ThemeHolder = {
    current: chooseSelection({ home: themeHome, flag: options.theme }),
  };
  // With no --url, make sure a serve answers (starting one) before the screen.
  if (options.url === undefined && options.noStart !== true) {
    const home = options.home ?? defaultOperadHome();
    await (options.hooks?.ensure ?? ensureServer)({
      home,
      ...(options.hooks?.fetch === undefined ? {} : { fetch: options.hooks.fetch }),
      ...(options.serveEntry === undefined
        ? {}
        : { spawn: spawnServe(home, options.serveEntry) }),
      ...(options.write === undefined ? {} : { write: options.write }),
    });
  }
  const location = await discoverServer({
    home: options.home,
    url: options.url,
    token: options.token,
  });
  const client = new TuiClient(location);
  const messages: string[] = [];
  let renderer: CliRenderer | undefined;
  let view: TuiView | undefined;
  let shell: TuiShell | undefined;
  let code = 0;
  let stopThemeWatch: (() => void) | undefined;
  const onAbort = (): void => shell?.stop();
  const onSignal = (): void => shell?.stop();

  // A callback that throws must not leave the screen up.
  const guarded = (work: () => void): void => {
    try {
      work();
    } catch (error) {
      messages.push(messageOf(error));
      code = 1;
      shell?.stop();
    }
  };

  // The renderer keeps its own handlers that only print; an error nobody
  // caught ends the app the way every other fault does.
  const onUncaught = (error: unknown): void => {
    messages.push(messageOf(error));
    code = 1;
    shell?.stop();
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  try {
    const created = await (options.hooks?.renderer?.() ??
      createCliRenderer({
        exitOnCtrlC: true,
        screenMode: "alternate-screen",
      }));
    renderer = created;
    const createdView = (options.hooks?.view ?? ((ctx) => createTuiView(ctx, () => holder.current)))(created);
    view = createdView;
    const started = startShell({
      client,
      url: location.url,
      recent: loadRecent(themeHome),
      onRecent: (recent) => saveRecent(themeHome, recent),
      events: (signal) =>
        new TuiEvents({ url: location.url, token: location.token, signal }),
      view: createdView,
      width: created.width,
      height: created.height,
      theme: themeOf(created, "dark"),
      onFatal: (message) => {
        messages.push(message);
        code = 1;
      },
      onFinish: () => {
        // Close the screen first: nothing may be written under it.
        try {
          createdView.destroy();
        } finally {
          view = undefined;
          if (!created.isDestroyed) created.destroy();
        }
      },
    });
    shell = started;
    stopThemeWatch = watchThemes({
      home: themeHome,
      flag: options.theme,
      holder,
      onChange: (problem) => guarded(() => started.repaintTheme(problem)),
    });

    created.keyInput.on("keypress", (key) => {
      guarded(() => started.key(key));
    });
    created.on(CliRenderEvents.RESIZE, () => {
      guarded(() => started.resize(created.width, created.height));
    });
    created.on(CliRenderEvents.THEME_MODE, () => {
      const theme = created.themeMode;
      if (theme !== null) guarded(() => started.setTheme(theme));
    });
    created.once(CliRenderEvents.DESTROY, () => started.stop());
    // SIGINT and SIGTERM end the app the way `q` does: the screen is restored
    // and the event stream closed before the process goes on.
    for (const name of STOP_SIGNALS) process.on(name, onSignal);
    if (options.signal !== undefined) {
      if (options.signal.aborted) started.stop();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    await started.done;
  } catch (error) {
    messages.push(messageOf(error));
    code = 1;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    for (const name of STOP_SIGNALS) process.off(name, onSignal);
    stopThemeWatch?.();
    try {
      shell?.stop();
      view?.destroy();
    } catch (error) {
      messages.push(messageOf(error));
      code = 1;
    }
    if (renderer !== undefined) {
      if (!renderer.isDestroyed) renderer.destroy();
      // destroy() only starts the restore (mouse tracking off, keyboard
      // protocol popped, main screen, cursor); `closed` settles when the
      // terminal has the bytes. Nothing is written before that.
      try {
        await renderer.closed;
      } catch (error) {
        messages.push(messageOf(error));
        code = 1;
      }
    }
    // Keep the handlers until the screen is closed: a fault during the restore
    // must not take the process down half way.
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
  }
  const onError = options.onError ?? (() => undefined);
  for (const message of messages) onError(message);
  return code;
}
