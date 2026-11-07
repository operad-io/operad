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
  ViewRow,
} from "@operad-io/engine";
import { ensureServer, spawnServe, type EnsureServerOptions } from "./autostart.ts";
import { TuiClient, type FetchLike } from "./client.ts";
import { defaultOperadHome } from "@operad-io/engine";
import { discoverServer } from "./discover.ts";
import { TuiEvents, type TuiEvent } from "./events.ts";
import {
  initialState,
  reduce,
  type TuiPageRequest,
  type TuiState,
  type TuiStateEvent,
  type TuiTheme,
} from "./state.ts";
import { createTuiView, type TuiView } from "./view/index.ts";
import type { TuiTypeInfo } from "./client.ts";

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
  ): Promise<ViewListPage>;
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
  /** A failure to report once the screen is gone. */
  readonly onMessage?: ((message: string) => void) | undefined;
  /** Called once when the shell finishes, before `done` resolves. */
  readonly onFinish?: (() => void) | undefined;
  /** The wait before a change refreshes the lists; 100 by default. */
  readonly refreshDelayMs?: number | undefined;
}

/** A running shell: feed it keys and sizes, and wait for `done`. */
export interface TuiShell {
  readonly state: TuiState;
  key(input: TuiKeyInput): void;
  resize(width: number, height: number): void;
  setTheme(theme: TuiTheme): void;
  stop(): void;
  /** Resolves with the exit code once the shell has finished. */
  readonly done: Promise<number>;
}

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
  });
  let finished = false;
  let refreshAbort: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let events: TuiEventSource | undefined;
  let announce: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    announce = resolve;
  });

  function finish(): void {
    if (finished) return;
    finished = true;
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    refreshAbort?.abort();
    events?.stop();
    abort.abort();
    deps.onFinish?.();
    announce(0);
  }

  async function loadPage(request: TuiPageRequest): Promise<void> {
    const tab = state.tabs.find((candidate) => candidate.id === request.tabId);
    if (tab?.type === undefined) return;
    try {
      const page = await client.objects(tab.type, request.cursor, abort.signal);
      dispatch({
        type: "page",
        tabId: request.tabId,
        page,
        version: request.version,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      dispatch({
        type: "page-error",
        tabId: request.tabId,
        message: messageOf(error),
        version: request.version,
      });
      report(error);
    }
  }

  /** Reads a type's first page, and more until it is as deep as it was. */
  async function fetchTypeRows(
    type: string,
    depth: number,
    signal: AbortSignal,
  ): Promise<ViewListPage> {
    const rows: ViewRow[] = [];
    let cursor: string | undefined;
    let next: string | undefined;
    do {
      const page = await client.objects(type, cursor, signal);
      rows.push(...page.rows);
      next = page.next;
      cursor = next;
    } while (next !== undefined && rows.length < depth);
    return next === undefined ? { rows } : { rows, next };
  }

  async function refresh(): Promise<void> {
    if (finished) return;
    refreshAbort?.abort();
    const mine = new AbortController();
    refreshAbort = mine;
    const signal = mine.signal;
    dispatch({ type: "refresh-start" });
    const generation = state.generation;
    const depths = new Map(
      state.tabs.map((tab) => [tab.id, tab.list.rows.length] as const),
    );
    let failed = false;

    // A request that the next refresh cancelled says nothing.
    const fail = (error: unknown): void => {
      if (signal.aborted || finished) return;
      failed = true;
      dispatch({ type: "status", message: messageOf(error), generation });
      report(error);
    };

    const asked = Promise.all([
      settle(client.types(signal)),
      settle(client.pending(signal)),
      settle(client.running(signal)),
    ]);
    const [typesResult, pending, running] = await asked;
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
          const result = await settle(
            fetchTypeRows(info.type, depths.get(tabId) ?? 0, signal),
          );
          if (signal.aborted || finished) return;
          if (result.ok) {
            dispatch({
              type: "page",
              tabId,
              page: result.value,
              replace: true,
              generation,
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
    if (!failed && !signal.aborted && !finished) {
      dispatch({ type: "status", generation });
    }
  }

  function requestRefresh(): void {
    if (finished) return;
    void refresh();
  }

  function scheduleRefresh(): void {
    if (finished) return;
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      requestRefresh();
    }, deps.refreshDelayMs ?? 100);
  }

  function dispatch(event: TuiStateEvent): void {
    if (finished) return;
    state = reduce(state, event);
    // A page is asked for once: the request leaves the state as it is launched.
    const request = state.pageRequest;
    if (request !== undefined) state = reduce(state, { type: "page-launched" });
    const refreshing = state.refreshRequested;
    if (refreshing) state = reduce(state, { type: "refreshed" });
    view.render(state);
    if (state.quit) {
      finish();
      return;
    }
    if (request !== undefined) void loadPage(request);
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
          scheduleRefresh();
        } else {
          dispatch({ type: "status", message: event.error.message });
          report(event.error);
        }
      }
    } catch (error) {
      if (!finished) report(error);
    }
  })();

  return {
    get state(): TuiState {
      return state;
    },
    key(input: TuiKeyInput): void {
      const name = input.sequence === "?" ? "?" : input.name;
      dispatch({
        type: "key",
        key: name,
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
    stop: finish,
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
  const onAbort = (): void => shell?.stop();

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

  try {
    const created = await (options.hooks?.renderer?.() ??
      createCliRenderer({
        exitOnCtrlC: true,
        screenMode: "alternate-screen",
      }));
    renderer = created;
    const createdView = (options.hooks?.view ?? createTuiView)(created);
    view = createdView;
    const started = startShell({
      client,
      events: (signal) =>
        new TuiEvents({ url: location.url, token: location.token, signal }),
      view: createdView,
      width: created.width,
      height: created.height,
      theme: themeOf(created, "dark"),
      onMessage: (message) => messages.push(message),
      onFinish: () => {
        // Close the screen first: nothing may be written under it.
        createdView.destroy();
        view = undefined;
        if (!created.isDestroyed) created.destroy();
      },
    });
    shell = started;

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
    shell?.stop();
    view?.destroy();
    if (renderer !== undefined && !renderer.isDestroyed) renderer.destroy();
  }
  const onError = options.onError ?? (() => undefined);
  for (const message of messages) onError(message);
  return code;
}
