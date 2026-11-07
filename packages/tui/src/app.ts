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
} from "@operad-io/engine";
import { TuiClient } from "./client.ts";
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

/** How `operad tui` finds its server and reports a problem. */
export interface TuiRunOptions {
  readonly home?: string | undefined;
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  /** Closes the app from outside, as a signal would. */
  readonly signal?: AbortSignal | undefined;
  /** A non-fatal client or stream error; the screen stays open. */
  readonly onError?: ((message: string) => void) | undefined;
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
 * Runs the terminal app until `q`, Ctrl-C or `signal`. It resolves with the
 * command exit code; a discovery error is thrown before the screen opens.
 */
export async function runTui(options: TuiRunOptions = {}): Promise<number> {
  const location = await discoverServer({
    home: options.home,
    url: options.url,
    token: options.token,
  });
  const client = new TuiClient(location);
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
  });
  const view: TuiView = createTuiView(renderer);
  const abort = new AbortController();
  const onError = options.onError ?? (() => undefined);

  let state: TuiState = initialState({
    width: renderer.width,
    height: renderer.height,
    theme: themeOf(renderer, "dark"),
  });
  let finished = false;
  let refreshGeneration = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let events: TuiEvents | undefined;
  let announce: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    announce = resolve;
  });

  function finish(): void {
    if (finished) return;
    finished = true;
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    events?.stop();
    abort.abort();
    if (!renderer.isDestroyed) {
      view.destroy();
      renderer.destroy();
    }
    announce();
  }

  function report(error: unknown): void {
    if (abort.signal.aborted) return;
    onError(messageOf(error));
  }

  async function loadPage(request: TuiPageRequest): Promise<void> {
    if (finished) return;
    const tab = state.tabs.find((candidate) => candidate.id === request.tabId);
    if (tab?.type === undefined) return;
    try {
      const page: ViewListPage = await client.objects(
        tab.type,
        request.cursor,
        abort.signal,
      );
      if (finished) return;
      dispatch({ type: "page", tabId: request.tabId, page });
    } catch (error) {
      if (finished || abort.signal.aborted) return;
      dispatch({
        type: "page-error",
        tabId: request.tabId,
        message: messageOf(error),
      });
      report(error);
    }
  }

  async function fetchTypes(): Promise<string[] | undefined> {
    const result = await settle(client.types(abort.signal));
    if (!result.ok) {
      report(result.error);
      return undefined;
    }
    dispatch({ type: "types", types: result.value.types });
    return result.value.types.map((type) => type.type);
  }

  async function fetchPending(): Promise<void> {
    const result = await settle(client.pending(abort.signal));
    if (!result.ok) {
      report(result.error);
      return;
    }
    dispatch({ type: "pending", items: result.value as readonly PendingItem[] });
  }

  async function fetchRunning(): Promise<void> {
    const result = await settle(client.running(abort.signal));
    if (!result.ok) {
      report(result.error);
      return;
    }
    dispatch({ type: "running", items: result.value as readonly RunningItem[] });
  }

  async function fetchTypePage(tabId: string, type: string): Promise<void> {
    const result = await settle(client.objects(type, undefined, abort.signal));
    if (!result.ok) {
      dispatch({ type: "page-error", tabId, message: messageOf(result.error) });
      report(result.error);
      return;
    }
    dispatch({ type: "page", tabId, page: result.value, replace: true });
  }

  async function refresh(): Promise<void> {
    if (finished) return;
    refreshGeneration += 1;
    const generation = refreshGeneration;
    const [types, pending, running] = await Promise.all([
      fetchTypes(),
      fetchPending(),
      fetchRunning(),
    ]);
    if (finished || generation !== refreshGeneration) return;
    if (types === undefined) return;
    await Promise.all(
      types.map((type) => {
        if (finished || generation !== refreshGeneration) return undefined;
        return fetchTypePage(`type:${type}`, type);
      }),
    );
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
    }, 100);
  }

  function dispatch(event: TuiStateEvent): void {
    if (finished) return;
    state = reduce(state, event);
    view.render(state);
    if (state.quit) {
      finish();
      return;
    }
    if (state.pageRequest !== undefined) {
      const request = state.pageRequest;
      void loadPage(request);
    }
    if (state.refreshRequested) {
      dispatch({ type: "refreshed" });
      requestRefresh();
    }
  }

  renderer.keyInput.on("keypress", (key) => {
    const name = key.sequence === "?" ? "?" : key.name;
    dispatch({ type: "key", key: name, shift: key.shift });
  });
  renderer.on(CliRenderEvents.RESIZE, () => {
    dispatch({
      type: "resize",
      width: renderer.width,
      height: renderer.height,
    });
  });
  renderer.on(CliRenderEvents.THEME_MODE, () => {
    const theme = renderer.themeMode;
    if (theme !== null) dispatch({ type: "theme", theme });
  });
  renderer.once(CliRenderEvents.DESTROY, () => {
    if (!finished) finish();
  });
  const onAbort = (): void => finish();
  if (options.signal !== undefined) {
    if (options.signal.aborted) finish();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  if (!finished) {
    view.render(state);
    requestRefresh();

    events = new TuiEvents({
      url: location.url,
      token: location.token,
      signal: abort.signal,
    });
    void (async () => {
      try {
        for await (const event of events as AsyncIterable<TuiEvent>) {
          if (finished) break;
          if (event.kind === "change" || event.kind === "reset") {
            scheduleRefresh();
          } else {
            report(event.error);
          }
        }
      } catch (error) {
        report(error);
      }
    })();
  }

  await done;
  if (options.signal !== undefined) {
    options.signal.removeEventListener("abort", onAbort);
  }
  return finished ? 0 : 1;
}
