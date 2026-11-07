import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ViewError,
  createViews,
  loadPluginRegistry,
  openConfigLog,
  openPluginStore,
  readConfig,
  type LogBackend,
  type PluginStore,
  type Views,
} from "@operad-io/engine";
import {
  ChannelTypeError,
  startClaudeChannel,
  type ChannelHandle,
  type ChannelNotification,
} from "../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const channelPluginPath = fileURLToPath(
  new URL("./fixtures/channel.ts", import.meta.url),
);

/** Notifications the channel sent, with a wait for the next one. */
class Sent {
  readonly all: ChannelNotification[] = [];
  private readonly waiting: ((value: ChannelNotification) => void)[] = [];
  private readonly queue: ChannelNotification[] = [];

  push = (notification: ChannelNotification): void => {
    this.all.push(notification);
    const resolve = this.waiting.shift();
    if (resolve !== undefined) resolve(notification);
    else this.queue.push(notification);
  };

  next(): Promise<ChannelNotification> {
    const ready = this.queue.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

/** Counts the reads the channel made, with a wait for the next. */
class Reads {
  private count = 0;
  private readonly waiting: (() => void)[] = [];

  push(): void {
    const resolve = this.waiting.shift();
    if (resolve !== undefined) resolve();
    else this.count += 1;
  }

  next(): Promise<void> {
    if (this.count > 0) {
      this.count -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

interface Setup {
  readonly store: PluginStore;
  readonly log: LogBackend;
  readonly views: Views;
  readonly registry: Awaited<ReturnType<typeof loadPluginRegistry>>;
  readonly logs: string[];
}

async function setup(): Promise<Setup> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [channelPluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
    }),
  );
  const config = await readConfig(home);
  const store = openPluginStore({
    backend: "jsonl",
    root: join(root, "store"),
  });
  const log = openConfigLog(config);
  const logs: string[] = [];
  const registry = await loadPluginRegistry({
    home,
    cwd: home,
    store,
    onAnswer: async () => {},
    onLog: (message) => logs.push(message),
  });
  const views = createViews({ registry, store, log, cwd: home });
  return { store, log, views, registry, logs };
}

function put(
  s: Setup,
  type: string,
  id: string,
  data: Record<string, unknown>,
): void {
  s.store.put(type, id, data, "test");
}

describe("the channel's sources", () => {
  test("a seed that fails makes the first sighting of each object a baseline", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    Object.defineProperty(s.views, "list", {
      value: async () => {
        throw new Error("the list is down");
      },
    });
    // Tells the test when the channel has read an object.
    const read = new Reads();
    const realGet = s.views.get.bind(s.views);
    Object.defineProperty(s.views, "get", {
      value: async (id: string) => {
        try {
          return await realGet(id);
        } finally {
          read.push();
        }
      },
    });
    const sent = new Sent();
    const channel: ChannelHandle = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      send: sent.push,
      onLog: (message) => s.logs.push(message),
    });
    try {
      expect(s.logs.join("\n")).toContain("could not be read");
      // The first sighting of t-1 is a baseline: no `new -> running`.
      put(s, "task", "t-1", { title: "One", phase: "running" });
      await read.next();
      put(s, "task", "t-1", { title: "One", phase: "done" });
      const first = await sent.next();
      expect(first.content).toBe("t-1 running -> done");
      expect(sent.all).toHaveLength(1);
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("an object that is not found is forgotten, so it comes back as new", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      send: sent.push,
    });
    const realGet = s.views.get.bind(s.views);
    let gone = true;
    Object.defineProperty(s.views, "get", {
      value: (id: string) => {
        if (gone) {
          gone = false;
          throw new ViewError("not-found", `no object "${id}"`);
        }
        return realGet(id);
      },
    });
    try {
      // The read fails with not found; the key is dropped.
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      // The same state is now the object's first sighting.
      put(s, "task", "t-1", { title: "One again", phase: "ready" });
      const first = await sent.next();
      expect(first.content).toBe("t-1 new -> ready");
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("a run log change with no object write reports the wait and the running flag", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      send: sent.push,
    });
    try {
      const info = await s.log.startRun("demo-flow", "task:t-1");
      const started = await sent.next();
      expect(started.meta).toMatchObject({
        id: "t-1",
        waiting: "false",
        running: "true",
      });
      await s.log.append(info.runId, 0, [
        {
          kind: "waiting_for_person",
          payload: {
            waitId: "wait:1",
            step: "ask",
            prompt: "Approve?",
            choices: ["yes"],
            waitKind: "step",
            effectId: null,
          },
          cause: "test",
        },
      ]);
      const waiting = await sent.next();
      expect(waiting.meta).toMatchObject({ waiting: "true", running: "false" });
      expect(waiting.content).toBe("t-1 ready -> ready");
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("an object with a new id after the start reports new -> state, and several types are watched", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      types: ["task", "note"],
      send: sent.push,
    });
    try {
      put(s, "task", "t-2", { title: "Two", phase: "ready" });
      put(s, "note", "n-1", { title: "Note", state: "open" });
      const task = await sent.next();
      const note = await sent.next();
      expect(task.content).toBe("t-2 new -> ready");
      expect(task.meta.previous).toBe("new");
      expect(task.meta.type).toBe("task");
      expect(note.content).toBe("n-1 new -> open");
      expect(note.meta.type).toBe("note");
      // t-1 existed at the start and produced nothing.
      expect(sent.all.map((n) => n.meta.id)).toEqual(["t-2", "n-1"]);
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("a type with no views is refused with its name", async () => {
    const s = await setup();
    try {
      await expect(
        startClaudeChannel({
          views: s.views,
          registry: s.registry,
          log: s.log,
          types: ["task", "ghost"],
          send: () => {},
        }),
      ).rejects.toThrow(ChannelTypeError);
      await expect(
        startClaudeChannel({
          views: s.views,
          registry: s.registry,
          log: s.log,
          types: ["ghost"],
          send: () => {},
        }),
      ).rejects.toThrow('"ghost"');
    } finally {
      s.views.close();
      await s.log.close();
    }
  });

  test("held notifications go out at release, in order", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      hold: true,
      send: sent.push,
    });
    try {
      put(s, "task", "t-1", { title: "One", phase: "running" });
      put(s, "task", "t-2", { title: "Two", phase: "ready" });
      // Release queues behind the reads the two writes started.
      await channel.release();
      expect(sent.all.map((n) => n.content)).toEqual([
        "t-1 ready -> running",
        "t-2 new -> ready",
      ]);
      // After the release a change goes out at once.
      put(s, "task", "t-1", { title: "One", phase: "done" });
      expect((await sent.next()).content).toBe("t-1 ready -> running");
      expect((await sent.next()).content).toBe("t-2 new -> ready");
      expect((await sent.next()).content).toBe("t-1 running -> done");
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });
});
