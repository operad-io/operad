import { describe, expect, test } from "bun:test";
import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewRow,
} from "@operad-io/engine";
import { startHttpServer } from "@operad-io/engine";
import {
  LIVE_DEBOUNCE_MS,
  LiveBatcher,
  TuiClient,
  TuiError,
  TuiEvents,
  TuiUnreachableError,
  TuiUnauthorizedError,
  connectionOf,
  drawState,
  initialState,
  reduce,
  refetchTargets,
  startShell,
  statusText,
  type Refetch,
  type TuiEvent,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { ManualClock, makeHarness } from "./support.ts";

function row(id: string, title = id): ViewRow {
  return { id, title, state: "new", waiting: false, running: false };
}

function objectOf(id: string, title = id): ViewObject {
  return {
    id,
    type: "item",
    link: `operad://objects/${id}`,
    row: row(id, title),
    sections: [
      { id: "info", title: "Info" },
      { id: "log", title: "Log", live: true },
    ],
    actions: [],
  };
}

/** A client that counts every call and can be told to fail. */
class CountingClient implements TuiShellClient {
  failure: Error | undefined;
  titles = new Map<string, string>([["a", "A"]]);
  pendingCalls = 0;
  objectsCalls = 0;
  objectCalls: string[] = [];
  sectionCalls: string[] = [];
  log = "one";
  sectionFailure: Error | undefined;

  private check(): void {
    if (this.failure !== undefined) throw this.failure;
  }
  async types(): Promise<{ readonly types: readonly { type: string; title: string }[] }> {
    this.check();
    return { types: [{ type: "item", title: "Item" }] };
  }
  async pending(): Promise<readonly PendingItem[]> {
    this.pendingCalls += 1;
    this.check();
    return [];
  }
  async running(): Promise<readonly RunningItem[]> {
    this.check();
    return [];
  }
  async objects(): Promise<ViewListPage> {
    this.objectsCalls += 1;
    this.check();
    return { rows: [...this.titles].map(([id, title]) => row(id, title)) };
  }
  async object(id: string): Promise<ViewObject> {
    this.objectCalls.push(id);
    this.check();
    if (!this.titles.has(id)) throw new TuiError("gone", { status: 404 });
    return objectOf(id, this.titles.get(id) ?? id);
  }
  async section(id: string, section: string): Promise<{ readonly markdown: string }> {
    this.sectionCalls.push(`${id}/${section}`);
    if (this.sectionFailure !== undefined) throw this.sectionFailure;
    this.check();
    return { markdown: section === "log" ? this.log : "info" };
  }
}

class PushEvents implements TuiEventSource {
  private readonly queue: TuiEvent[] = [];
  private waiter: ((r: IteratorResult<TuiEvent>) => void) | undefined;
  stopped = false;
  push(event: TuiEvent): void {
    const waiter = this.waiter;
    if (waiter === undefined) this.queue.push(event);
    else {
      this.waiter = undefined;
      waiter({ done: false, value: event });
    }
  }
  stop(): void {
    this.stopped = true;
    this.waiter?.({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<TuiEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.stopped) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

class Screen implements TuiView {
  last: TuiState | undefined;
  private readonly waiters: { test: (s: TuiState) => boolean; resolve: () => void }[] = [];
  render(state: TuiState): void {
    this.last = state;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.test(state)) waiter.resolve();
      else this.waiters.push(waiter);
    }
  }
  destroy(): void {}
  until(test: (state: TuiState) => boolean): Promise<void> {
    if (this.last !== undefined && test(this.last)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }
}

/** Lets every promise already resolved run its continuation. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const titles = (state: TuiState): string[] =>
  state.tabs.find((tab) => tab.id === "type:item")?.list.rows.map((r) => r.title) ?? [];

function start(configure: (client: CountingClient) => void = () => undefined) {
  const client = new CountingClient();
  configure(client);
  const events = new PushEvents();
  const view = new Screen();
  const clock = new ManualClock();
  const shell = startShell({
    client,
    events: () => events,
    view,
    width: 120,
    height: 30,
    theme: "dark",
    clock,
    url: "http://127.0.0.1:7480",
  });
  return { client, events, view, clock, shell };
}

const text = (styled: { readonly chunks: readonly { readonly text: string }[] }): string =>
  styled.chunks.map((part) => part.text).join("");

describe("which events ask for which fetches", () => {
  test("a change refetches its row and the lists; the open object also its pane", () => {
    expect(refetchTargets({ kind: "change", id: "a" }, undefined)).toEqual({
      all: false,
      lists: true,
      rows: ["a"],
      object: false,
    });
    expect(refetchTargets({ kind: "change", id: "item:a" }, "a").object).toBe(true);
    expect(refetchTargets({ kind: "change", id: "b" }, "a").object).toBe(false);
  });

  test("a reset refetches everything", () => {
    expect(refetchTargets({ kind: "reset" }, "a")).toEqual({
      all: true,
      lists: true,
      rows: [],
      object: true,
    });
    expect(refetchTargets({ kind: "reset" }, undefined).object).toBe(false);
  });

  test("events inside one window make one batch, then the next window starts", () => {
    const clock = new ManualClock();
    const batches: Refetch[] = [];
    const batcher = new LiveBatcher(clock, (batch) => batches.push(batch));
    batcher.push(refetchTargets({ kind: "change", id: "a" }, undefined));
    clock.advance(LIVE_DEBOUNCE_MS - 1);
    batcher.push(refetchTargets({ kind: "change", id: "b" }, undefined));
    batcher.push(refetchTargets({ kind: "change", id: "a" }, undefined));
    expect(batches).toHaveLength(0);
    clock.advance(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.rows).toEqual(["a", "b"]);
    batcher.push(refetchTargets({ kind: "reset" }, undefined));
    clock.advance(LIVE_DEBOUNCE_MS);
    expect(batches).toHaveLength(2);
    expect(batches[1]?.all).toBe(true);
  });

  test("a stopped batcher fires nothing", () => {
    const clock = new ManualClock();
    const batches: Refetch[] = [];
    const batcher = new LiveBatcher(clock, (batch) => batches.push(batch));
    batcher.push(refetchTargets({ kind: "reset" }, undefined));
    batcher.stop();
    clock.advance(1000);
    expect(batches).toHaveLength(0);
  });

  test("only an unreachable server or a 401 says something about the connection", () => {
    expect(connectionOf(new TuiUnreachableError("x"))).toBe("unreachable");
    expect(connectionOf(new TuiUnauthorizedError(undefined, "x"))).toBe("unauthorized");
    expect(connectionOf(new Error("x"))).toBeUndefined();
  });
});

describe("live updates in the shell", () => {
  test("an event refetches Pending once per window and only its own row", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    const pendingBefore = s.client.pendingCalls;
    const listsBefore = s.client.objectsCalls;
    s.client.titles.set("a", "A2");
    s.events.push({ kind: "change", id: "a" });
    s.events.push({ kind: "change", id: "a" });
    s.events.push({ kind: "change", id: "a" });
    await settled();
    s.clock.advance(LIVE_DEBOUNCE_MS - 1);
    await settled();
    expect(s.client.pendingCalls).toBe(pendingBefore);
    s.clock.advance(1);
    await s.view.until((state) => titles(state)[0] === "A2");
    expect(s.client.pendingCalls).toBe(pendingBefore + 1);
    expect(s.client.objectsCalls).toBe(listsBefore);
    expect(s.client.objectCalls).toEqual(["a"]);
    s.shell.stop();
  });

  test("an event for an object no list holds refetches the list of its type", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.client.titles.set("new", "New");
    s.events.push({ kind: "change", id: "new" });
    await settled();
    s.clock.advance(LIVE_DEBOUNCE_MS);
    await s.view.until((state) => titles(state).length === 2);
    s.shell.stop();
  });

  test("an event for the open object refetches its row and its live section", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.shell.key({ name: "3" });
    s.shell.key({ name: "return" });
    await s.view.until((state) => state.object?.sections[0]?.loaded === true);
    s.shell.key({ name: "]", sequence: "]" });
    await s.view.until((state) => state.object?.sections[1]?.markdown === "one");
    s.client.log = "two";
    s.client.titles.set("a", "A3");
    s.events.push({ kind: "change", id: "a" });
    await settled();
    s.clock.advance(LIVE_DEBOUNCE_MS);
    await s.view.until(
      (state) =>
        state.object?.sections[1]?.markdown === "two" &&
        state.object.row.title === "A3" &&
        titles(state)[0] === "A3",
    );
    s.shell.stop();
  });

  test("a reset refetches every list", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    const listsBefore = s.client.objectsCalls;
    s.client.titles.set("b", "B");
    s.events.push({ kind: "reset" });
    await settled();
    s.clock.advance(LIVE_DEBOUNCE_MS);
    await s.view.until((state) => titles(state).length === 2);
    expect(s.client.objectsCalls).toBeGreaterThan(listsBefore);
    s.shell.stop();
  });

  test("a server that does not answer keeps the lists, names itself and retries with growing waits", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.client.failure = new TuiUnreachableError("no server answered");
    s.shell.key({ name: "r" });
    await s.view.until((state) => state.connection === "unreachable");
    expect(titles(s.shell.state)).toEqual(["A"]);
    const line = statusText(s.shell.state) ?? "";
    expect(line).toContain("http://127.0.0.1:7480");
    expect(line).toContain("is `operad serve` running?");

    const calls = (): number => s.client.pendingCalls;
    let seen = calls();
    for (const wait of [250, 500, 1000]) {
      await settled();
      s.clock.advance(wait - 1);
      await settled();
      expect(calls()).toBe(seen);
      s.clock.advance(1);
      await settled();
      expect(calls()).toBe(seen + 1);
      seen = calls();
    }

    s.client.failure = undefined;
    s.client.titles.set("a", "Back");
    s.clock.advance(2000);
    await s.view.until((state) => state.connection === "ok" && titles(state)[0] === "Back");
    expect(statusText(s.shell.state)).toBeUndefined();
    seen = calls();
    s.clock.advance(60_000);
    await settled();
    expect(calls()).toBe(seen);
    s.shell.stop();
  });

  test("an event while the server was lost refetches everything, not one row", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.client.failure = new TuiUnreachableError("no server answered");
    s.shell.key({ name: "r" });
    await s.view.until((state) => state.connection === "unreachable");
    await settled();
    s.clock.advance(250); // the first retry fails and schedules the next at 500
    await settled();
    s.client.failure = undefined;
    s.client.titles.set("a", "Back");
    s.events.push({ kind: "change", id: "a" });
    await settled();
    s.clock.advance(LIVE_DEBOUNCE_MS);
    await s.view.until((state) => state.connection === "ok" && titles(state)[0] === "Back");
    s.shell.stop();
  });

  test("a 401 says the token was rotated and does not retry", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.client.failure = new TuiUnauthorizedError(undefined, "bad token");
    s.shell.key({ name: "r" });
    await s.view.until((state) => state.connection === "unauthorized");
    expect(statusText(s.shell.state)).toContain(
      "the token was rotated: run the TUI again or pass --token",
    );
    await settled();
    const seen = s.client.pendingCalls;
    s.clock.advance(60_000);
    await settled();
    expect(s.client.pendingCalls).toBe(seen);
    s.shell.stop();
  });

  test("a 401 after the server was lost cancels the scheduled retry", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.client.failure = new TuiUnreachableError("no server answered");
    s.shell.key({ name: "r" });
    await s.view.until((state) => state.connection === "unreachable");
    await settled();
    s.events.push({ kind: "error", error: new TuiUnauthorizedError(undefined, "no") });
    await s.view.until((state) => state.connection === "unauthorized");
    await settled();
    const seen = s.client.pendingCalls;
    s.clock.advance(60_000);
    await settled();
    expect(s.client.pendingCalls).toBe(seen);
    s.shell.stop();
  });

  test("a deletion event for the open object removes its row from the lists", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.shell.key({ name: "3" });
    s.shell.key({ name: "return" });
    await s.view.until((state) => state.object?.sections[0]?.loaded === true);
    s.client.titles.delete("a");
    s.events.push({ kind: "change", id: "a" });
    await settled();
    s.clock.advance(LIVE_DEBOUNCE_MS);
    await s.view.until((state) => titles(state).length === 0);
    s.shell.stop();
  });

  test("a transport failure after the 401 does not replace it or restart retries", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.events.push({ kind: "error", error: new TuiUnauthorizedError(undefined, "no") });
    await s.view.until((state) => state.connection === "unauthorized");
    s.client.failure = new TuiUnreachableError("no server answered");
    s.shell.key({ name: "3" });
    s.shell.key({ name: "return" });
    await settled();
    expect(s.shell.state.connection).toBe("unauthorized");
    const seen = s.client.pendingCalls;
    s.clock.advance(60_000);
    await settled();
    expect(s.client.pendingCalls).toBe(seen);
    s.shell.stop();
  });

  test("a live section that fails to refresh shows its error", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.shell.key({ name: "3" });
    s.shell.key({ name: "return" });
    await s.view.until((state) => state.object?.sections[0]?.loaded === true);
    s.shell.key({ name: "]", sequence: "]" });
    await s.view.until((state) => state.object?.sections[1]?.markdown === "one");
    s.client.sectionFailure = new TuiError("log broke", { status: 500 });
    s.events.push({ kind: "change", id: "a" });
    await settled();
    s.clock.advance(LIVE_DEBOUNCE_MS);
    await s.view.until((state) => state.object?.sections[1]?.error !== undefined);
    s.shell.stop();
  });

  test("a batch queued before a 401 makes no fetch", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.events.push({ kind: "change", id: "a" });
    await settled();
    s.events.push({ kind: "error", error: new TuiUnauthorizedError(undefined, "no") });
    await s.view.until((state) => state.connection === "unauthorized");
    await settled();
    const seen = s.client.pendingCalls;
    const rows = s.client.objectsCalls;
    s.clock.advance(60_000);
    await settled();
    expect(s.client.pendingCalls).toBe(seen);
    expect(s.client.objectsCalls).toBe(rows);
    s.shell.stop();
  });

  test("an event stream refused with 401 gives the same state", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.events.push({ kind: "error", error: new TuiUnauthorizedError(undefined, "no") });
    await s.view.until((state) => state.connection === "unauthorized");
    s.shell.stop();
  });

  test("quitting closes the event stream and leaves no timer", async () => {
    const s = start();
    await s.view.until((state) => titles(state).length === 1);
    s.events.push({ kind: "change", id: "a" });
    await settled();
    s.shell.key({ name: "q", sequence: "q" });
    expect(await s.shell.done).toBe(0);
    expect(s.events.stopped).toBe(true);
    expect(s.clock.pending).toBe(0);
  });
});

describe("the states a session meets", () => {
  test("empty Pending, an empty type list and a lost server are drawn", () => {
    let state = initialState({ width: 100, height: 20, url: "http://x:1" });
    state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
    state = reduce(state, { type: "pending", items: [] });
    expect(text(drawState(state).list)).toBe("nothing waits for you");
    state = reduce(state, { type: "page", tabId: "type:item", page: { rows: [] } });
    state = reduce(state, { type: "key", key: "3", text: "3" });
    expect(text(drawState(state).list)).toBe("no item yet");
    state = reduce(state, { type: "connection", connection: "unreachable" });
    expect(text(drawState(state).footer)).toContain("http://x:1");
  });

  test("the last lists stay visible but dimmed while the server does not answer", () => {
    let state = initialState({ width: 100, height: 20 });
    state = reduce(state, { type: "pending", items: [] });
    state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
    state = reduce(state, { type: "page", tabId: "type:item", page: { rows: [row("a")] } });
    state = reduce(state, { type: "key", key: "3", text: "3" });
    const colours = (s: TuiState): string[] =>
      drawState(s).list.chunks.map((part) => JSON.stringify(part.fg ?? null));
    const normal = new Set(colours(state));
    const lost = reduce(state, { type: "connection", connection: "unreachable" });
    expect(text(drawState(lost).list)).toBe(text(drawState(state).list));
    expect(new Set(colours(lost)).size).toBe(1);
    expect(normal.size).toBeGreaterThan(1);
  });

  test("a section that failed shows its message and r asks for it again", () => {
    let state = initialState({ width: 120, height: 20 });
    state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
    state = reduce(state, { type: "page", tabId: "type:item", page: { rows: [row("a")] } });
    state = reduce(state, { type: "key", key: "3", text: "3" });
    state = reduce(state, { type: "key", key: "return" });
    state = reduce(state, {
      type: "object",
      object: objectOf("a"),
      version: state.objectRequest?.version,
    });
    state = reduce(state, {
      type: "section-error",
      objectId: "a",
      sectionId: "info",
      message: "the section timed out",
    });
    const drawn = text(drawState(state).right);
    expect(drawn).toContain("the section timed out");
    expect(drawn).toContain("r retries");
    state = reduce(state, { type: "key", key: "r", text: "r" });
    expect(state.sectionRequest?.sectionId).toBe("info");
    expect(state.refreshRequested).toBe(true);
  });
});

describe("against the in-process server", () => {
  test("a stopped server is unreachable, a restarted one brings the lists back", async () => {
    const h = await makeHarness();
    h.store.put("item", "one", { title: "One", state: "new" }, "seed");
    const events = new PushEvents();
    const view = new Screen();
    const clock = new ManualClock();
    const shell = startShell({
      client: new TuiClient({ url: h.base, token: h.token }),
      events: () => events,
      view,
      width: 120,
      height: 30,
      theme: "dark",
      clock,
      url: h.base,
    });
    try {
      await view.until((state) => titles(state).length === 1);
      const port = Number(new URL(h.base).port);
      await h.server.stop();
      shell.key({ name: "r" });
      await view.until((state) => state.connection === "unreachable");
      expect(titles(shell.state)).toEqual(["One"]);
      expect(statusText(shell.state)).toContain(h.base);

      const again = await startHttpServer({
        home: h.home,
        config: { enabled: true, port, listen: ["127.0.0.1"] },
        views: h.views,
        log: h.log,
        registry: h.registry,
        onLog: () => undefined,
      });
      try {
        h.store.put("item", "two", { title: "Two", state: "new" }, "seed");
        clock.advance(10_000);
        await view.until((state) => state.connection === "ok" && titles(state).length === 2);
      } finally {
        await again.stop();
      }
    } finally {
      shell.stop();
      await h.close();
    }
  });

  test("a token that no longer matches gives the 401 state", async () => {
    const h = await makeHarness();
    const view = new Screen();
    const shell = startShell({
      client: new TuiClient({ url: h.base, token: `${h.token}-rotated` }),
      events: (signal) => new TuiEvents({ url: h.base, token: `${h.token}-rotated`, signal }),
      view,
      width: 120,
      height: 30,
      theme: "dark",
      clock: new ManualClock(),
      url: h.base,
    });
    try {
      await view.until((state) => state.connection === "unauthorized");
      expect(statusText(shell.state)).toContain("the token was rotated");
    } finally {
      shell.stop();
      await h.close();
    }
  });
});
