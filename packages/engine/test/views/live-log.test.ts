import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createViews,
  definePlugin,
  MemoryPluginStore,
  openLog,
  PluginRegistry,
  type LogBackend,
  type PluginDefinition,
  type JsonValue,
  type ViewEvent,
  type Views,
} from "../../src/index.ts";
import demo from "../fixtures/plugins/presentation.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

/** Every view a test opens, closed after the test even when it fails. */
const openedViews: Views[] = [];
/** Every log a test opens, closed after its views. */
const openedLogs: LogBackend[] = [];

afterEach(async () => {
  for (const views of openedViews.splice(0)) views.close();
  for (const log of openedLogs.splice(0)) await log.close();
});

function trackedViews(options: Parameters<typeof createViews>[0]): Views {
  const views = createViews(options);
  openedViews.push(views);
  return views;
}

/** Fails an event read instead of letting a broken stream hang the test. */
function within<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for an event")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The next pushed tail, skipping the change event that comes beside it. */
async function nextTail(stream: AsyncIterator<ViewEvent>): Promise<ViewEvent> {
  for (;;) {
    const event = await within(stream.next());
    if (event.done) throw new Error("the stream ended");
    if (event.value.section !== undefined) return event.value;
  }
}

/** The next change event for `id`, refusing any pushed tail before it. */
async function nextChange(stream: AsyncIterator<ViewEvent>, id: string): Promise<ViewEvent> {
  for (;;) {
    const event = await within(stream.next());
    if (event.done) throw new Error("the stream ended");
    if (event.value.section !== undefined) {
      throw new Error(`an unexpected pushed tail arrived before the change of "${id}"`);
    }
    if (event.value.id === id) return event.value;
  }
}

/** The directory watches a test fires by hand, and the ones it saw stop. */
interface FakeWatches {
  readonly watch: (
    directory: string,
    onChange: (filename: string | null) => void,
  ) => () => void;
  /** Resolves when `directory` is watched. */
  opened(directory: string): Promise<(filename: string | null) => void>;
  /** Resolves when `directory`'s watch was stopped. */
  closed(directory: string): Promise<void>;
  fire(directory: string, filename?: string): void;
  watched(directory: string): boolean;
}

function fakeWatches(): FakeWatches {
  const open = new Map<string, (filename: string | null) => void>();
  const stopped = new Set<string>();
  const openedWaiters = new Map<string, () => void>();
  const closedWaiters = new Map<string, () => void>();
  return {
    watch(directory, onChange) {
      // As the platform's watch does: a missing directory is a no-op.
      if (!existsSync(directory)) return () => undefined;
      open.set(directory, onChange);
      stopped.delete(directory);
      openedWaiters.get(directory)?.();
      openedWaiters.delete(directory);
      return () => {
        open.delete(directory);
        stopped.add(directory);
        closedWaiters.get(directory)?.();
        closedWaiters.delete(directory);
      };
    },
    opened(directory) {
      const listener = open.get(directory);
      if (listener !== undefined) return Promise.resolve(listener);
      return new Promise((resolve) => {
        openedWaiters.set(directory, () =>
          resolve(open.get(directory) ?? (() => undefined)),
        );
      });
    },
    closed(directory) {
      if (stopped.has(directory)) return Promise.resolve();
      return new Promise((resolve) => closedWaiters.set(directory, resolve));
    },
    fire(directory, filename = "agent.log") {
      open.get(directory)?.(filename);
    },
    watched(directory) {
      return open.has(directory);
    },
  };
}

/** The fallback timer a test fires by hand; no test waits on wall time. */
interface ManualRepeat {
  readonly repeat: (ms: number, callback: () => void) => () => void;
  fire(): void;
  stopped(): boolean;
}

function manualRepeat(): ManualRepeat {
  let callback: (() => void) | undefined;
  let stopped = false;
  return {
    repeat(_ms, next) {
      callback = next;
      stopped = false;
      return () => {
        stopped = true;
        callback = undefined;
      };
    },
    fire() {
      callback?.();
    },
    stopped() {
      return stopped;
    },
  };
}

/** A plugin whose sections are never live, for the gating test. */
const quiet = definePlugin({
  name: "quiet",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "ticket" }],
  views: {
    ticket: {
      row: (object) => ({ id: object.id, title: object.id, state: "open" }),
      sections: () => [{ id: "body", title: "Body" }],
      load: () => ({ markdown: "" }),
    },
  },
});

interface Pushed {
  readonly section: string;
  readonly tail?: string | undefined;
  readonly data?: Readonly<Record<string, JsonValue>> | undefined;
}

/** A live item whose pushed tail a test controls; `hook` sees each call's number. */
function pushingPlugin(
  hook: (call: number) => Pushed | Promise<Pushed | undefined> | undefined,
) {
  const state = { calls: 0 };
  const plugin = definePlugin({
    name: "pusher",
    kind: "domain",
    version: "0.0.1",
    objects: [{ name: "item" }],
    views: {
      item: {
        row: (object) => ({ id: object.id, title: object.id, state: "open" }),
        sections: () => [{ id: "log", title: "Log", live: true }],
        load: () => ({ markdown: "" }),
        tail: () => {
          state.calls += 1;
          return hook(state.calls);
        },
      },
    },
  });
  return { plugin, state };
}

/** A log whose subscription a test fires by hand; only the files change by itself. */
function manualLog(inner: LogBackend): {
  readonly log: LogBackend;
  changed(object: string): void;
} {
  const listeners = new Set<
    Parameters<NonNullable<LogBackend["subscribe"]>>[0]
  >();
  const log: LogBackend = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    startRun: (flow, object, input, access) =>
      inner.startRun(flow, object, input, access),
    endRun: (runId) => inner.endRun(runId),
    recordInput: (runId, source, key, payload) =>
      inner.recordInput(runId, source, key, payload),
    append: (runId, seq, facts) => inner.append(runId, seq, facts),
    read: (runId) => inner.read(runId),
    runs: (options) => inner.runs(options),
    appendGlobal: (fact, key) => inner.appendGlobal(fact, key),
    readGlobal: () => inner.readGlobal(),
    readInputs: () => inner.readInputs(),
    readInputsAfter: (position) => inner.readInputsAfter(position),
    findInput: (inputId) => inner.findInput(inputId),
    readOutcome: (inputId, kind) => inner.readOutcome(inputId, kind),
    readOutcomesAfter: (seq) => inner.readOutcomesAfter(seq),
    recordOutcome: (inputId, kind, payload) =>
      inner.recordOutcome(inputId, kind, payload),
    readOutcomes: () => inner.readOutcomes(),
    close: () => inner.close(),
  };
  return {
    log,
    changed: (object) => {
      for (const listener of listeners) listener({ runId: "manual", object });
    },
  };
}

interface Env {
  readonly store: MemoryPluginStore;
  readonly registry: PluginRegistry;
  readonly log: LogBackend;
  /** The log the views see, whose subscription a test fires by hand. */
  readonly manual: LogBackend;
  readonly changed: (object: string) => void;
  readonly watches: FakeWatches;
  readonly repeat: ManualRepeat;
  readonly now: { value: number };
  readonly run: { readonly runId: string };
  readonly directory: string;
}

/** A store and a running demo item, with its step log directory when asked. */
async function fixture(
  options: { readonly logDir: boolean },
  plugin: PluginDefinition = demo,
): Promise<Env> {
  const root = await tempRoot();
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  store.put("item", "one", { title: "One" }, "seed");
  store.put("item", "two", { title: "Two" }, "seed");
  const registry = new PluginRegistry([plugin], { store });
  const log = openLog({
    backend: "sqlite",
    path: join(root, "store", "log.sqlite"),
  });
  openedLogs.push(log);
  const run = await log.startRun("demo-flow", "item:one");
  const directory = join(store.root, "logs", plugin.name, "runs", run.runId);
  if (options.logDir) {
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "agent.log"), '{"line":1}\n');
  }
  const manual = manualLog(log);
  return {
    store,
    registry,
    log,
    manual: manual.log,
    changed: manual.changed,
    watches: fakeWatches(),
    repeat: manualRepeat(),
    now: { value: 0 },
    run,
    directory,
  };
}

function viewsOf(
  env: Env,
  options: {
    readonly onLog?: ((message: string) => void) | undefined;
    readonly loadTimeoutMs?: number | undefined;
  } = {},
): Views {
  return trackedViews({
    registry: env.registry,
    store: env.store,
    log: env.manual,
    clock: () => env.now.value,
    watch: env.watches.watch,
    repeat: env.repeat.repeat,
    pollMs: 60_000,
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    ...(options.loadTimeoutMs === undefined
      ? {}
      : { loadTimeoutMs: options.loadTimeoutMs }),
  });
}

describe("a live log that grows without a fact", () => {
  test("a retry item is passed through on a read and a pushed tail", async () => {
    const retry = {
      attempt: 2,
      maxAttempts: 3,
      until: 1_700_000_004_000,
      reason: "the provider is overloaded",
    };
    const retrying = definePlugin({
      name: "retrying",
      kind: "domain",
      version: "0.0.1",
      objects: [{ name: "item" }],
      views: {
        item: {
          row: (object) => ({ id: object.id, title: object.id, state: "open" }),
          sections: () => [{ id: "log", title: "Log", live: true }],
          load: () => ({ markdown: "", retry }),
          tail: () => ({ section: "log", tail: "waiting", retry }),
        },
      },
    });
    const env = await fixture({ logDir: true }, retrying);
    const views = viewsOf(env);
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      expect((await views.section("item:one", "log")).retry).toEqual(retry);
      onChange("agent.log");
      expect(await nextTail(stream)).toEqual({
        id: "one",
        type: "item",
        section: "log",
        tail: "waiting",
        retry,
      });
    } finally {
      await stream.return?.();
    }
  });

  test("an appended line announces the run's object", async () => {
    const env = await fixture({ logDir: true });
    const views = viewsOf(env);
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      const pending = stream.next();
      await appendFile(join(env.directory, "agent.log"), '{"line":2}\n');
      onChange("agent.log");
      const event = await within(pending);
      expect(event.done).toBe(false);
      if (!event.done) expect(event.value).toEqual({ id: "one" });
    } finally {
      await stream.return?.();
    }
  });

  test("many appends in one window give one event, and the last when it ends", async () => {
    const env = await fixture({ logDir: true });
    const views = viewsOf(env);
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      onChange("agent.log");
      expect((await within(stream.next())).value).toEqual({ id: "one" });

      env.now.value = 100;
      for (let line = 2; line <= 6; line += 1) {
        await appendFile(
          join(env.directory, "agent.log"),
          `{"line":${line}}\n`,
        );
        onChange("agent.log");
      }

      // A different object arrives first, so nothing of the growth was announced.
      env.store.put("item", "two", { title: "Two again" }, "seed");
      expect((await within(stream.next())).value).toEqual({ id: "two" });

      // No line is written again: the window ending is enough.
      env.now.value = 250;
      expect((await within(stream.next())).value).toEqual({ id: "one" });
    } finally {
      await stream.return?.();
    }
  });

  test("no event arrives after the run ended", async () => {
    const env = await fixture({ logDir: true });
    const views = viewsOf(env);
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      onChange("agent.log");
      expect((await within(stream.next())).value).toEqual({ id: "one" });

      await env.log.endRun(env.run.runId);
      env.now.value = 1_000;
      env.repeat.fire();
      await within(env.watches.closed(env.directory));

      // A watch that still held the old callback must announce nothing.
      onChange("agent.log");
      env.store.put("item", "two", { title: "Two again" }, "seed");
      expect((await within(stream.next())).value).toEqual({ id: "two" });
    } finally {
      await stream.return?.();
    }
  });

  test("closing the views stops the watch and the fallback check", async () => {
    const env = await fixture({ logDir: true });
    const views = viewsOf(env);
    await env.watches.opened(env.directory);

    views.close();
    openedViews.splice(openedViews.indexOf(views), 1);

    await within(env.watches.closed(env.directory));
    expect(env.watches.watched(env.directory)).toBe(false);
    expect(env.repeat.stopped()).toBe(true);
  });

  test("a run the log says ended is no longer watched, without the timer", async () => {
    const env = await fixture({ logDir: true });
    viewsOf(env);
    await env.watches.opened(env.directory);

    await env.log.endRun(env.run.runId);
    env.changed("item:one");
    await within(env.watches.closed(env.directory));
    expect(env.watches.watched(env.directory)).toBe(false);
  });

  test("a run with no log directory is picked up when it appears", async () => {
    const env = await fixture({ logDir: false });
    // A second run whose directory exists is the barrier: its watch opening
    // means the first refresh looked at the run with no directory.
    const barrier = await env.log.startRun("demo-flow", "item:two");
    const barrierDir = join(
      env.store.root,
      "logs",
      "demo",
      "runs",
      barrier.runId,
    );
    await mkdir(barrierDir, { recursive: true });
    const views = viewsOf(env);
    await within(env.watches.opened(barrierDir));

    await mkdir(env.directory, { recursive: true });
    env.repeat.fire();
    const onChange = await within(env.watches.opened(env.directory));

    const stream = views.events()[Symbol.asyncIterator]();
    try {
      const pending = stream.next();
      await appendFile(join(env.directory, "agent.log"), '{"line":1}\n');
      onChange("agent.log");
      expect((await within(pending)).value).toEqual({ id: "one" });
    } finally {
      await stream.return?.();
    }
  });

  test("a run whose object has no live section is not watched", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "plugins") });
    store.put("item", "one", { title: "One" }, "seed");
    store.put("ticket", "one", { title: "Ticket" }, "seed");
    const registry = new PluginRegistry([demo, quiet], { store });
    let next = 0;
    const log = openLog({
      backend: "sqlite",
      path: join(root, "store", "log.sqlite"),
      clock: () => 0,
      runId: () => (next++ === 0 ? "a-quiet" : "z-demo"),
    });
    openedLogs.push(log);
    const quietRun = await log.startRun("quiet-flow", "ticket:one");
    const demoRun = await log.startRun("demo-flow", "item:one");
    const quietDir = join(store.root, "logs", "quiet", "runs", quietRun.runId);
    const demoDir = join(store.root, "logs", "demo", "runs", demoRun.runId);
    await mkdir(quietDir, { recursive: true });
    await mkdir(demoDir, { recursive: true });
    const watches = fakeWatches();
    const manual = manualLog(log);
    const env: Env = {
      store,
      registry,
      log,
      manual: manual.log,
      changed: manual.changed,
      watches,
      repeat: manualRepeat(),
      now: { value: 0 },
      run: demoRun,
      directory: demoDir,
    };
    viewsOf(env);

    // Runs are read in id order, so the quiet one was looked at first; the
    // demo run's watch opening is the barrier.
    await within(watches.opened(demoDir));
    expect(watches.watched(quietDir)).toBe(false);
  });

  test("a plugin without a tail function sends only the change event", async () => {
    const env = await fixture({ logDir: true });
    const views = viewsOf(env);
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      onChange("agent.log");
      expect((await within(stream.next())).value).toEqual({ id: "one" });
      env.store.put("item", "two", { title: "Two changed" }, "seed");
      expect(await nextChange(stream, "two")).toEqual({ id: "two" });
    } finally {
      await stream.return?.();
    }
  });

  test("a pushed tail carries the live section's data", async () => {
    const data = { replies: [{ runId: "run-1", answer: null }] };
    const { plugin } = pushingPlugin(() => ({ section: "log", tail: "tail 1", data }));
    const env = await fixture({ logDir: true }, plugin);
    const views = viewsOf(env);
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      onChange("agent.log");
      expect(await nextTail(stream)).toEqual({
        id: "one",
        type: "item",
        section: "log",
        tail: "tail 1",
        data,
      });
    } finally {
      await stream.return?.();
    }
  });

  test("a pushed tail is held to one per object per 50 ms and the last growth wins", async () => {
    const { plugin, state } = pushingPlugin((call) => ({ section: "log", tail: `tail ${call}` }));
    const env = await fixture({ logDir: true }, plugin);
    const views = viewsOf(env);
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      onChange("agent.log");
      expect(await nextTail(stream)).toEqual({
        id: "one",
        type: "item",
        section: "log",
        tail: "tail 1",
      });

      env.now.value = 10;
      onChange("agent.log");
      // Another object changes first: the second tail is still inside the window.
      env.store.put("item", "two", { title: "Two changed" }, "seed");
      expect(await nextChange(stream, "two")).toEqual({ id: "two" });
      expect(state.calls).toBe(1);

      env.now.value = 60;
      expect(await nextTail(stream)).toEqual({
        id: "one",
        type: "item",
        section: "log",
        tail: "tail 2",
      });
      expect(state.calls).toBe(2);
    } finally {
      await stream.return?.();
    }
  });

  test("a pushed tail overtaken by a newer growth is dropped", async () => {
    let resolveOld: ((value: Pushed) => void) | undefined;
    let started: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { plugin } = pushingPlugin((call) => {
      if (call !== 1) return { section: "log", tail: "new" };
      return new Promise<Pushed>((resolve) => {
        resolveOld = resolve;
        started?.();
      });
    });
    const env = await fixture({ logDir: true }, plugin);
    const views = viewsOf(env);
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      onChange("agent.log");
      await within(firstStarted);

      env.now.value = 10;
      onChange("agent.log");
      env.now.value = 60;
      expect(await nextTail(stream)).toEqual({
        id: "one",
        type: "item",
        section: "log",
        tail: "new",
      });

      resolveOld?.({ section: "log", tail: "old" });
      // Let the old live computation finish before the next change is read.
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      env.store.put("item", "two", { title: "Two changed" }, "seed");
      expect(await nextChange(stream, "two")).toEqual({ id: "two" });
      env.store.put("item", "three", { title: "Three" }, "seed");
      expect(await nextChange(stream, "three")).toEqual({ id: "three" });
    } finally {
      await stream.return?.();
    }
  });

  test("a pushed tail that fails leaves the stream alone", async () => {
    const { plugin } = pushingPlugin(() => {
      throw new Error("no tail");
    });
    let failed: ((message: string) => void) | undefined;
    const failure = new Promise<string>((resolve) => {
      failed = resolve;
    });
    const env = await fixture({ logDir: true }, plugin);
    const views = viewsOf(env, {
      onLog: (message) => {
        if (message.includes("tail for")) failed?.(message);
      },
    });
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      onChange("agent.log");
      expect(await within(failure)).toContain('plugin "pusher": tail for "item:one" failed: no tail');
      env.store.put("item", "two", { title: "Two changed" }, "seed");
      expect(await nextChange(stream, "two")).toEqual({ id: "two" });
    } finally {
      await stream.return?.();
    }
  });

  test("a pushed tail that does not answer in time is dropped", async () => {
    const { plugin } = pushingPlugin(() => new Promise<Pushed>(() => undefined));
    let timedOut: ((message: string) => void) | undefined;
    const timeout = new Promise<string>((resolve) => {
      timedOut = resolve;
    });
    const env = await fixture({ logDir: true }, plugin);
    const views = viewsOf(env, {
      loadTimeoutMs: 5,
      onLog: (message) => {
        if (message.includes("tail for")) timedOut?.(message);
      },
    });
    const onChange = await env.watches.opened(env.directory);
    const stream = views.events()[Symbol.asyncIterator]();
    try {
      onChange("agent.log");
      expect(await within(timeout)).toContain("did not answer within 5ms");
      env.store.put("item", "two", { title: "Two changed" }, "seed");
      expect(await nextChange(stream, "two")).toEqual({ id: "two" });
    } finally {
      await stream.return?.();
    }
  });
});
