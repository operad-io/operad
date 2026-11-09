import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { PendingItem, RunningItem, ViewListPage, ViewRow } from "@operad-io/engine";
import {
  TuiError,
  TuiUnauthorizedError,
  runTui,
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiShell,
  type TuiShellClient,
  type TuiState,
  createTuiView,
  type TuiView,
} from "../src/index.ts";

import { immediateClock } from "./support.ts";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void = () => undefined;
  reject: (error: unknown) => void = () => undefined;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function row(id: string): ViewRow {
  return { id, title: `Title ${id}`, state: "new", waiting: false, running: false };
}

function page(ids: readonly string[], next?: string): ViewListPage {
  return next === undefined
    ? { rows: ids.map(row) }
    : { rows: ids.map(row), next };
}

interface ObjectsCall {
  readonly type: string;
  readonly cursor: string | undefined;
  readonly signal: AbortSignal | undefined;
}

/** A client whose answers the test hands out one by one. */
class FakeClient implements TuiShellClient {
  readonly objectsCalls: ObjectsCall[] = [];
  readonly pendingCalls: (AbortSignal | undefined)[] = [];
  types: () => Promise<{ readonly types: readonly { type: string; title: string }[] }> = () =>
    Promise.resolve({ types: [{ type: "item", title: "Item" }] });
  pendingAnswer: () => Promise<readonly PendingItem[]> = () => Promise.resolve([]);
  runningAnswer: () => Promise<readonly RunningItem[]> = () => Promise.resolve([]);
  objectsAnswer: (call: ObjectsCall) => Promise<ViewListPage> = () =>
    Promise.resolve(page([]));

  pending(signal?: AbortSignal): Promise<readonly PendingItem[]> {
    this.pendingCalls.push(signal);
    return this.pendingAnswer();
  }
  running(): Promise<readonly RunningItem[]> {
    return this.runningAnswer();
  }
  objects(type: string, cursor?: string, signal?: AbortSignal, _f?: string, level?: { readonly parent?: string | undefined }): Promise<ViewListPage> {
    if (level?.parent !== undefined) return Promise.resolve({ rows: [] });
    const call = { type, cursor, signal };
    this.objectsCalls.push(call);
    return this.objectsAnswer(call);
  }
  callsWith(cursor: string | undefined): ObjectsCall[] {
    return this.objectsCalls.filter((call) => call.cursor === cursor);
  }
}

class FakeEvents implements TuiEventSource {
  private readonly queue: TuiEvent[] = [];
  private waiter: ((result: IteratorResult<TuiEvent>) => void) | undefined;
  private closed = false;
  stopped = false;
  push(event: TuiEvent): void {
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: event });
    } else this.queue.push(event);
  }
  stop(): void {
    this.stopped = true;
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<TuiEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

/** A view that keeps every state it was asked to draw. */
class FakeView implements TuiView {
  last: TuiState | undefined;
  renders = 0;
  private readonly waiters: { test: (s: TuiState) => boolean; resolve: () => void }[] = [];
  render(state: TuiState): void {
    this.last = state;
    this.renders += 1;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.test(state)) waiter.resolve();
      else this.waiters.push(waiter);
    }
  }
  destroy(): void {}
  /** Resolves after the next draw, whatever it shows. */
  nextRender(): Promise<void> {
    const seen = this.renders;
    return this.until(() => this.renders > seen);
  }
  /** Resolves when a drawn state satisfies `test`; no clock is involved. */
  until(test: (state: TuiState) => boolean): Promise<void> {
    if (this.last !== undefined && test(this.last)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }
}

interface Setup {
  readonly client: FakeClient;
  readonly events: FakeEvents;
  readonly view: FakeView;
  readonly messages: string[];
  readonly shell: TuiShell;
}

function setup(configure: (client: FakeClient) => void = () => undefined): Setup {
  const client = new FakeClient();
  configure(client);
  const events = new FakeEvents();
  const view = new FakeView();
  const messages: string[] = [];
  const shell = startShell({
    client,
    events: () => events,
    view,
    width: 80,
    height: 20,
    theme: "dark",
    clock: immediateClock,
    onMessage: (message) => messages.push(message),
  });
  return { client, events, view, messages, shell };
}

const ids = (state: TuiState, tab = "plugin:item"): string[] =>
  state.tabs.find((candidate) => candidate.id === tab)?.list.rows.map((r) => r.id) ?? [];
const typeList = (state: TuiState) =>
  state.tabs.find((candidate) => candidate.id === "plugin:item")?.list;

/** Opens the item tab with its first page loaded. */
async function openItems(s: Setup): Promise<void> {
  await s.view.until((state) => typeList(state)?.loaded === true);
  s.shell.key({ name: "3" });
}

describe("the TUI app", () => {
  test("a plugin tab's list is every page of its top level, fetched once", async () => {
    const s = setup((client) => {
      client.objectsAnswer = (call) =>
        call.cursor === "p2" ? Promise.resolve(page(["c", "d"])) : Promise.resolve(page(["a", "b"], "p2"));
    });
    await openItems(s);
    await s.view.until((state) => ids(state).length === 4);
    expect(ids(s.shell.state)).toEqual(["a", "b", "c", "d"]);
    expect(s.client.callsWith("p2")).toHaveLength(1);
    // Moving, resizing and the key list fetch nothing more.
    s.shell.key({ name: "down" });
    s.shell.resize(90, 24);
    s.shell.key({ name: "?", sequence: "?" });
    s.shell.key({ name: "?", sequence: "?" });
    expect(s.client.callsWith("p2")).toHaveLength(1);
    expect(typeList(s.shell.state)?.loading).toBe(false);
    s.shell.stop();
  });

  test("the previous refresh is aborted and its late answer is dropped", async () => {
    const answers: Deferred<readonly PendingItem[]>[] = [];
    const s = setup((client) => {
      client.pendingAnswer = () => {
        const next = new Deferred<readonly PendingItem[]>();
        answers.push(next);
        return next.promise;
      };
    });
    s.shell.key({ name: "r" });
    await s.view.until((state) => state.generation === 2);
    expect(s.client.pendingCalls).toHaveLength(2);
    expect(s.client.pendingCalls[0]?.aborted).toBe(true);
    expect(s.client.pendingCalls[1]?.aborted).toBe(false);

    const item = (prompt: string): PendingItem => ({
      runId: prompt,
      flow: "f",
      step: "s",
      prompt,
      choices: [],
      actions: [],
      object: `item:${prompt}`,
    });
    answers[1]?.resolve([item("new")]);
    await s.view.until((state) => ids(state, "pending").length === 1);
    const drawn = s.view.nextRender();
    answers[0]?.resolve([item("old"), item("older")]);
    await drawn;
    expect(ids(s.shell.state, "pending")).toEqual(["item:new"]);
    s.shell.stop();
  });

  test("a refresh keeps the selected object, fetching as deep as the list was", async () => {
    let refreshing = false;
    const s = setup((client) => {
      client.objectsAnswer = (call) => {
        if (!refreshing) {
          return Promise.resolve(call.cursor === "p2" ? page(["c", "d"]) : page(["a", "b"], "p2"));
        }
        return Promise.resolve(
          call.cursor === "p2" ? page(["c", "d"]) : page(["z", "a", "b"], "p2"),
        );
      };
    });
    await openItems(s);
    s.shell.key({ name: "down" });
    await s.view.until((state) => ids(state).length === 4);
    s.shell.key({ name: "down" });
    s.shell.key({ name: "down" });
    expect(typeList(s.shell.state)?.cursor).toBe(3);
    s.shell.key({ name: "up" });
    s.shell.key({ name: "up" });
    expect(typeList(s.shell.state)?.cursor).toBe(1); // "b"

    refreshing = true;
    s.shell.key({ name: "r" });
    await s.view.until((state) => ids(state)[0] === "z");
    expect(ids(s.shell.state)).toEqual(["z", "a", "b", "c", "d"]);
    expect(typeList(s.shell.state)?.cursor).toBe(2); // still "b"
    s.shell.stop();
  });

  test("a failed request shows its reason and is reported after, not during", async () => {
    const s = setup((client) => {
      client.types = () => Promise.reject(new TuiUnauthorizedError("unauthorized", "the token is wrong"));
    });
    await s.view.until((state) => state.status !== undefined);
    expect(s.shell.state.status).toBe("the token is wrong");
    expect(s.messages).toEqual(["the token is wrong"]);
    s.shell.stop();
  });

  test("an error event from the stream shows its reason", async () => {
    const s = setup();
    await s.view.until((state) => typeList(state)?.loaded === true);
    s.events.push({
      kind: "error",
      error: new TuiError("the server is unwell", { status: 500 }),
    });
    await s.view.until((state) => state.status === "the server is unwell");
    s.shell.stop();
    expect(s.events.stopped).toBe(true);
  });

  test("a good refresh clears the failure", async () => {
    let fail = true;
    const s = setup((client) => {
      client.pendingAnswer = () =>
        fail ? Promise.reject(new Error("down")) : Promise.resolve([]);
    });
    await s.view.until((state) => state.status === "down");
    fail = false;
    s.shell.key({ name: "r" });
    await s.view.until((state) => state.status === undefined);
    s.shell.stop();
  });

  test("ctrl and meta chords do nothing, and the help hides the list's keys", async () => {
    const s = setup((client) => {
      client.objectsAnswer = () => Promise.resolve(page(["a", "b", "c"]));
    });
    await openItems(s);
    s.shell.key({ name: "q", ctrl: true });
    s.shell.key({ name: "j", meta: true });
    expect(s.shell.state.quit).toBe(false);
    expect(typeList(s.shell.state)?.cursor).toBe(0);

    s.shell.key({ name: "?", sequence: "?" });
    s.shell.key({ name: "j" });
    s.shell.key({ name: "g" });
    s.shell.key({ name: "3" });
    s.shell.key({ name: "tab" });
    expect(typeList(s.shell.state)?.cursor).toBe(0);
    expect(s.shell.state.active).toBe(2);
    s.shell.key({ name: "escape" });
    s.shell.key({ name: "j" });
    expect(typeList(s.shell.state)?.cursor).toBe(1);

    s.shell.key({ name: "q" });
    expect(await s.shell.done).toBe(0);
  });
});

describe("runTui", () => {
  test("restores the terminal and reports the failure when the view cannot be made", async () => {
    const test = await createTestRenderer({ width: 60, height: 10 });
    const reported: string[] = [];
    try {
      const code = await runTui({
        url: "http://127.0.0.1:1",
        token: "t",
        onError: (message) => reported.push(message),
        hooks: {
          renderer: async () => test.renderer,
          view: () => {
            throw new Error("no view today");
          },
        },
      });
      expect(code).toBe(1);
      expect(test.renderer.isDestroyed).toBe(true);
      expect(reported).toEqual(["no view today"]);
    } finally {
      await test.dispose();
    }
  });

  for (const name of ["SIGINT", "SIGTERM"] as const) {
    test(`${name} restores the terminal, stops the event stream and exits 0`, async () => {
      const before = process.listenerCount(name);
      const test = await createTestRenderer({ width: 60, height: 10 });
      let sent = false;
      try {
        const code = await runTui({
          url: "http://127.0.0.1:1",
          token: "t",
          hooks: {
            renderer: async () => test.renderer,
            view: (renderer) => {
              const real = createTuiView(renderer);
              return {
                render(state) {
                  real.render(state);
                  if (!sent) {
                    sent = true;
                    queueMicrotask(() => process.emit(name, name));
                  }
                },
                destroy: () => real.destroy(),
              };
            },
          },
        });
        expect(code).toBe(0);
        expect(test.renderer.isDestroyed).toBe(true);
      } finally {
        await test.dispose();
      }
      expect(process.listenerCount(name)).toBe(before);
    });
  }
});
