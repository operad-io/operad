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
  listPending,
  type LogBackend,
  type PendingItem,
  type PluginStore,
  type Views,
} from "@operad-io/engine";
import {
  ChannelNotifyError,
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
      notify: ["changes"],
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
      notify: ["changes"],
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

  const waitFact = (waitId: string) => ({
    kind: "waiting_for_person",
    payload: {
      waitId,
      step: "ask",
      prompt: "Approve?",
      choices: ["yes"],
      waitKind: "step",
      effectId: null,
    },
    cause: "test",
  });

  test("a running flag flip alone sends nothing, and a wait turning on sends with the step", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const running = new Reads();
    const realGet = s.views.get.bind(s.views);
    Object.defineProperty(s.views, "get", {
      value: async (id: string) => {
        const current = await realGet(id);
        if (current.row.running) running.push();
        return current;
      },
    });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      notify: ["changes"],
      views: s.views,
      registry: s.registry,
      log: s.log,
      send: sent.push,
    });
    try {
      const info = await s.log.startRun("demo-flow", "task:t-1");
      await running.next();
      await s.log.append(info.runId, 0, [
        {
          kind: "step_entered",
          payload: { kind: "call", step: "verify" },
          cause: "test",
        },
      ]);
      await s.log.append(info.runId, 1, [waitFact("wait:1")]);
      // The running flip and the step produced no block: the wait is the first.
      const waiting = await sent.next();
      expect(waiting.meta).toMatchObject({
        id: "t-1",
        waiting: "true",
        running: "false",
        step: "verify",
      });
      expect(waiting.content).toBe("t-1 ready -> ready");
      // The run ends: waiting turns off with the same state, nothing is sent,
      // and no step is reported once no run is active.
      await s.log.endRun(info.runId);
      put(s, "task", "t-1", { title: "One", phase: "review" });
      const changed = await sent.next();
      expect(changed.meta).toMatchObject({
        state: "review",
        previous: "ready",
        waiting: "false",
      });
      expect(changed.meta.step).toBeUndefined();
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("the step is the one of the run with the latest fact when two flows are active on one object", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      notify: ["changes"],
      views: s.views,
      registry: s.registry,
      log: s.log,
      send: sent.push,
    });
    try {
      const first = await s.log.startRun("demo-flow", "task:t-1");
      await s.log.append(first.runId, 0, [
        { kind: "step_entered", payload: { kind: "call", step: "old" }, cause: "test" },
      ]);
      const second = await s.log.startRun("other-flow", "task:t-1");
      await s.log.append(second.runId, 0, [
        { kind: "step_entered", payload: { kind: "call", step: "verify" }, cause: "test" },
      ]);
      await s.log.append(second.runId, 1, [waitFact("wait:2")]);
      const waiting = await sent.next();
      expect(waiting.meta).toMatchObject({ waiting: "true", step: "verify" });
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("the step of two active runs with equal times is chosen the same way every time", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    // Every fact and run reads as made at one instant.
    const real = s.log;
    const fixed = new Proxy(real, {
      get(target, name) {
        if (name === "runs") {
          return async (options: Parameters<LogBackend["runs"]>[0]) =>
            (await real.runs(options)).map((run) => ({ ...run, startedAt: 1000 }));
        }
        if (name === "read") {
          return async function* (...args: Parameters<LogBackend["read"]>) {
            for await (const fact of real.read(...args)) {
              yield { ...fact, time: 1000 };
            }
          };
        }
        const value: unknown = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      notify: ["changes"],
      views: s.views,
      registry: s.registry,
      log: fixed,
      send: sent.push,
    });
    try {
      const first = await s.log.startRun("demo-flow", "task:t-1");
      await s.log.append(first.runId, 0, [
        { kind: "step_entered", payload: { kind: "call", step: "a" }, cause: "test" },
        { kind: "step_entered", payload: { kind: "call", step: "a2" }, cause: "test" },
      ]);
      const second = await s.log.startRun("other-flow", "task:t-1");
      await s.log.append(second.runId, 0, [
        { kind: "step_entered", payload: { kind: "call", step: "b" }, cause: "test" },
      ]);
      await s.log.append(second.runId, 1, [waitFact("wait:2")]);
      const waiting = await sent.next();
      // Equal time, start and last seq: the larger run id wins, whatever the order.
      const expected = second.runId > first.runId ? "b" : "a2";
      expect(waiting.meta.step).toBe(expected);
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("a wait turning on again with the state and flags of the last block sent sends nothing", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    // Tells the test when the channel has read the object with no wait open.
    const idle = new Reads();
    const again = new Reads();
    let armed = false;
    const realGet = s.views.get.bind(s.views);
    Object.defineProperty(s.views, "get", {
      value: async (id: string) => {
        const current = await realGet(id);
        if (armed && !current.row.waiting) idle.push();
        if (armed && current.row.waiting) again.push();
        return current;
      },
    });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      notify: ["changes"],
      views: s.views,
      registry: s.registry,
      log: s.log,
      send: sent.push,
    });
    try {
      const first = await s.log.startRun("demo-flow", "task:t-1");
      await s.log.append(first.runId, 0, [waitFact("wait:1")]);
      expect((await sent.next()).meta.waiting).toBe("true");
      armed = true;
      await s.log.endRun(first.runId);
      await idle.next();
      const second = await s.log.startRun("demo-flow", "task:t-1");
      await s.log.append(second.runId, 0, [waitFact("wait:2")]);
      await again.next();
      put(s, "task", "t-1", { title: "One", phase: "done" });
      const next = await sent.next();
      expect(next.meta).toMatchObject({ state: "done", previous: "ready" });
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("a change back to the starting row after a block is sent, since no block reported the starting row", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      notify: ["changes"],
      views: s.views,
      registry: s.registry,
      log: s.log,
      send: sent.push,
    });
    try {
      put(s, "task", "t-1", { title: "One", phase: "review" });
      expect((await sent.next()).meta.state).toBe("review");
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      expect((await sent.next()).meta).toMatchObject({
        state: "ready",
        previous: "review",
      });
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("a restarted channel does not send the row the last block reported again", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sentFile = join(await tempRoot(), "sent.json");
    const first = new Sent();
    const one = await startClaudeChannel({
      notify: ["changes"],
      views: s.views,
      registry: s.registry,
      log: s.log,
      sentFile,
      send: first.push,
    });
    try {
      put(s, "task", "t-1", { title: "One", phase: "review" });
      expect((await first.next()).meta.state).toBe("review");
    } finally {
      await one.close();
    }
    // The change back happens while no server runs; the new one seeds "ready".
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const second = new Sent();
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
    const two = await startClaudeChannel({
      notify: ["changes"],
      views: s.views,
      registry: s.registry,
      log: s.log,
      sentFile,
      send: second.push,
    });
    try {
      put(s, "task", "t-1", { title: "One", phase: "review" });
      await read.next();
      put(s, "task", "t-1", { title: "One", phase: "done" });
      const next = await second.next();
      // "review" was already reported by the first server: only "done" is new.
      expect(next.meta).toMatchObject({ state: "done", previous: "review" });
      expect(second.all).toHaveLength(1);
    } finally {
      await two.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("an object with a new id after the start reports new -> state, and several types are watched", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      notify: ["changes"],
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
      notify: ["changes"],
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

  describe("what the default sends", () => {
    async function open(
      s: Setup,
      sent: Sent,
      extra: {
        loopAfter?: number;
        notify?: Parameters<typeof startClaudeChannel>[0]["notify"];
        sentFile?: string;
        pending?: () => Promise<readonly PendingItem[]>;
      } = {},
    ): Promise<ChannelHandle> {
      return startClaudeChannel({
        views: s.views,
        registry: s.registry,
        log: s.log,
        send: sent.push,
        ...extra,
      });
    }

    async function shut(s: Setup, channel: ChannelHandle): Promise<void> {
      await channel.close();
      s.views.close();
      await s.log.close();
    }

    /** Puts each phase and waits until the channel has read it. */
    function stepper(s: Setup): (type: string, phases: readonly string[]) => Promise<void> {
      const states: string[] = [];
      const waiting: (() => void)[] = [];
      const realGet = s.views.get.bind(s.views);
      Object.defineProperty(s.views, "get", {
        value: async (id: string) => {
          const current = await realGet(id);
          states.push(current.row.state);
          for (const wake of waiting.splice(0)) wake();
          return current;
        },
      });
      return async (type, phases) => {
        for (const phase of phases) {
          put(s, type, "t-1", { title: "One", phase });
          while (!states.includes(phase)) {
            await new Promise<void>((resolve) => waiting.push(resolve));
          }
          states.length = 0;
        }
      };
    }

    test("a start and a check starting send nothing; a wait opening and an end send with their reason", async () => {
      const s = await setup();
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      const sent = new Sent();
      const step = stepper(s);
      const channel = await open(s, sent);
      try {
        await step("task", ["running", "review"]);
        const info = await s.log.startRun("demo-flow", "task:t-1");
        await s.log.append(info.runId, 0, [waitFact("wait:1")]);
        const waiting = await sent.next();
        // Nothing before the wait: the two state changes were silent.
        expect(sent.all).toHaveLength(1);
        expect(waiting.meta).toMatchObject({
          state: "review",
          waiting: "true",
          reason: "waiting",
        });
        put(s, "task", "t-1", { title: "One", phase: "merged" });
        const ended = await sent.next();
        expect(ended.meta).toMatchObject({
          state: "merged",
          previous: "review",
          reason: "ended",
        });
        expect(sent.all).toHaveLength(2);
      } finally {
        await shut(s, channel);
      }
    });

    test("a plan-like object reaching its final state sends with reason ended", async () => {
      const s = await setup();
      put(s, "note", "n-1", { title: "Plan", state: "open" });
      const sent = new Sent();
      const channel = await open(s, sent);
      try {
        put(s, "note", "n-1", { title: "Plan", state: "closed" });
        put(s, "note", "n-1", { title: "Plan", state: "finished" });
        const ended = await sent.next();
        expect(ended.meta).toMatchObject({
          type: "note",
          state: "finished",
          reason: "ended",
        });
        expect(sent.all).toHaveLength(1);
      } finally {
        await shut(s, channel);
      }
    });

    test("three returns to one state without a wait send one loop block, not three", async () => {
      const s = await setup();
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      const sent = new Sent();
      const step = stepper(s);
      const channel = await open(s, sent);
      try {
        await step("task", ["running", "review", "running", "review", "running"]);
        const loop = await sent.next();
        expect(loop.meta).toMatchObject({ state: "running", reason: "loop" });
        // More rounds are the same loop: still one block. The end that
        // follows proves the earlier changes were read and stayed silent.
        await step("task", ["review", "running", "review", "merged"]);
        const ended = await sent.next();
        expect(ended.meta.reason).toBe("ended");
        expect(sent.all.map((one) => one.meta.reason)).toEqual(["loop", "ended"]);
      } finally {
        await shut(s, channel);
      }
    });

    test("a restarted channel does not send a loop block again for the same stretch", async () => {
      const s = await setup();
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      const sentFile = join(await tempRoot(), "sent.json");
      const first = new Sent();
      const step = stepper(s);
      const one = await open(s, first, { sentFile });
      try {
        await step("task", ["running", "review", "running", "review", "running"]);
        expect((await first.next()).meta.reason).toBe("loop");
      } finally {
        await one.close();
      }
      const second = new Sent();
      const two = await open(s, second, { sentFile });
      try {
        await step("task", ["review", "running", "review", "running", "review", "running", "merged"]);
        expect((await second.next()).meta.reason).toBe("ended");
        expect(second.all.map((x) => x.meta.reason)).toEqual(["ended"]);
      } finally {
        await shut(s, two);
      }
    });

    test("a wait carries the reason of its pending item when the row has no note", async () => {
      const s = await setup();
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      const sent = new Sent();
      const pending = async (): Promise<readonly PendingItem[]> => [
        {
          runId: "r-1",
          flow: "demo-flow",
          step: "gate",
          prompt: "ready to merge",
          choices: [],
          actions: [],
          object: "task:t-1",
        },
      ];
      const channel = await open(s, sent, { pending });
      try {
        const info = await s.log.startRun("demo-flow", "task:t-1");
        await s.log.append(info.runId, 0, [waitFact("wait:1")]);
        const waiting = await sent.next();
        expect(waiting.meta.reason).toBe("waiting");
        expect(waiting.content).toContain("ready to merge");
      } finally {
        await shut(s, channel);
      }
    });

    test("a block for a state change of a waiting object still carries the wait's prompt", async () => {
      const s = await setup();
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      const sent = new Sent();
      const pending = async (): Promise<readonly PendingItem[]> => [
        {
          runId: "r-1",
          flow: "demo-flow",
          step: "gate",
          prompt: "ready to merge",
          choices: [],
          actions: [],
          object: "task:t-1",
          announce: false,
        },
      ];
      const channel = await open(s, sent, { pending, notify: ["changes"] });
      try {
        const info = await s.log.startRun("demo-flow", "task:t-1");
        await s.log.append(info.runId, 0, [waitFact("wait:1")]);
        // The wait itself is not announced; the state change under it is.
        put(s, "task", "t-1", { title: "One", phase: "review" });
        const changed = await sent.next();
        expect(changed.meta.state).toBe("review");
        expect(changed.content).toContain("ready to merge");
      } finally {
        await shut(s, channel);
      }
    });

    test("a wait between the returns starts the count again", async () => {
      const s = await setup();
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      const sent = new Sent();
      const step = stepper(s);
      const channel = await open(s, sent, { loopAfter: 2 });
      try {
        await step("task", ["running", "review"]);
        const info = await s.log.startRun("demo-flow", "task:t-1");
        await s.log.append(info.runId, 0, [waitFact("wait:1")]);
        await sent.next();
        await s.log.endRun(info.runId);
        // Without the wait this second arrival at running would be a loop.
        await step("task", ["running", "merged"]);
        const ended = await sent.next();
        expect(ended.meta.reason).toBe("ended");
        expect(sent.all.map((one) => one.meta.reason)).toEqual([
          "waiting",
          "ended",
        ]);
      } finally {
        await shut(s, channel);
      }
    });

    test("notify \"changes\" sends every state change", async () => {
      const s = await setup();
      put(s, "task", "t-1", { title: "One", phase: "ready" });
      const sent = new Sent();
      const channel = await startClaudeChannel({
        views: s.views,
        registry: s.registry,
        log: s.log,
        notify: ["changes"],
        send: sent.push,
      });
      try {
        put(s, "task", "t-1", { title: "One", phase: "running" });
        expect((await sent.next()).meta).toMatchObject({
          state: "running",
          reason: "changes",
        });
        put(s, "task", "t-1", { title: "One", phase: "review" });
        expect((await sent.next()).meta.state).toBe("review");
      } finally {
        await shut(s, channel);
      }
    });

    test("an unknown notify entry is refused with its name", async () => {
      const s = await setup();
      try {
        await expect(
          startClaudeChannel({
            views: s.views,
            registry: s.registry,
            log: s.log,
            notify: ["waiting", "bogus"] as never,
            send: () => {},
          }),
        ).rejects.toThrow(ChannelNotifyError);
        await expect(
          startClaudeChannel({
            views: s.views,
            registry: s.registry,
            send: () => {},
            notify: ["bogus"] as never,
          }),
        ).rejects.toThrow(/"bogus"/);
      } finally {
        s.views.close();
        await s.log.close();
      }
    });
  });
});

describe("a wait the plugin answers itself", () => {
  const waitFact = (waitId: string) => ({
    kind: "waiting_for_person",
    payload: {
      waitId,
      step: "ask",
      prompt: "Approve?",
      choices: ["yes"],
      waitKind: "step",
      effectId: null,
    },
    cause: "test",
  });

  function item(auto: boolean): PendingItem {
    return {
      runId: "r",
      flow: "demo-flow",
      step: "ask",
      prompt: "ready to merge",
      choices: [],
      actions: [],
      object: "task:t-1",
      ...(auto ? { auto: true as const } : {}),
    };
  }

  test("is not announced, and its end is", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const read = new Reads();
    const channel = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      pending: async () => {
        read.push();
        return [item(true)];
      },
      send: sent.push,
    });
    try {
      const info = await s.log.startRun("demo-flow", "task:t-1");
      await s.log.append(info.runId, 0, [waitFact("wait:1")]);
      // The channel saw the wait and skipped it.
      await read.next();
      await s.log.endRun(info.runId);
      put(s, "task", "t-1", { title: "One", phase: "merged" });
      const ended = await sent.next();
      expect(ended.meta.reason).toBe("ended");
      expect(sent.all).toHaveLength(1);
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("is announced when the automatic answer is withdrawn", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    put(s, "task", "t-2", { title: "Two", phase: "ready" });
    const sent = new Sent();
    let auto = true;
    const read = new Reads();
    const channel = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      pending: async () => {
        read.push();
        return [item(auto)];
      },
      send: sent.push,
    });
    try {
      const info = await s.log.startRun("demo-flow", "task:t-1");
      await s.log.append(info.runId, 0, [waitFact("wait:1")]);
      await read.next();
      // The same change that makes the wait a person's, seen on another object.
      auto = false;
      put(s, "task", "t-2", { title: "Two", phase: "review" });
      const waiting = await sent.next();
      expect(waiting.meta).toMatchObject({ id: "t-1", reason: "waiting" });
      expect(waiting.content).toContain("ready to merge");
      expect(sent.all).toHaveLength(1);
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });

  test("a wait without the mark is announced as before", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready" });
    const sent = new Sent();
    const channel = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      pending: async () => [item(false)],
      send: sent.push,
    });
    try {
      const info = await s.log.startRun("demo-flow", "task:t-1");
      await s.log.append(info.runId, 0, [waitFact("wait:1")]);
      expect((await sent.next()).meta.reason).toBe("waiting");
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });
});

describe("the pending view and the plugin's automatic answer", () => {
  const waitFact = {
    kind: "waiting_for_person",
    payload: {
      waitId: "wait:1",
      step: "ask",
      prompt: "ready to merge",
      choices: ["merge"],
      waitKind: "step",
      effectId: null,
    },
    cause: "test",
  };

  test("a marked wait is left out of the pending view unless asked for", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready", auto: true });
    put(s, "task", "t-2", { title: "Two", phase: "ready" });
    for (const id of ["t-1", "t-2"]) {
      const info = await s.log.startRun("demo-flow", `task:${id}`);
      await s.log.append(info.runId, 0, [waitFact]);
    }
    try {
      const shown = await listPending(s.log, s.registry);
      expect(shown.map((item) => item.object)).toEqual(["task:t-2"]);
      const all = await listPending(s.log, s.registry, undefined, undefined, {
        withAuto: true,
      });
      // Runs started in the same millisecond have no fixed order: sort by object.
      const byObject = all
        .map((item) => [item.object, item.auto])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
      expect(byObject).toEqual([
        ["task:t-1", true],
        ["task:t-2", undefined],
      ]);
    } finally {
      s.views.close();
      await s.log.close();
    }
  });

  test("an auto wait sends no block and its merge sends ended; a refused answer is announced", async () => {
    const s = await setup();
    put(s, "task", "t-1", { title: "One", phase: "ready", auto: true });
    put(s, "task", "t-2", { title: "Two", phase: "ready", auto: true });
    const sent = new Sent();
    const skipped = new Reads();
    const channel = await startClaudeChannel({
      views: s.views,
      registry: s.registry,
      log: s.log,
      pending: async () => {
        const items = await listPending(s.log, s.registry, undefined, s.views, {
          withAuto: true,
        });
        for (const item of items) if (item.auto === true) skipped.push();
        return items;
      },
      send: sent.push,
    });
    try {
      const merged = await s.log.startRun("demo-flow", "task:t-1");
      await s.log.append(merged.runId, 0, [waitFact]);
      const refused = await s.log.startRun("demo-flow", "task:t-2");
      await s.log.append(refused.runId, 0, [waitFact]);
      // Both waits were seen and skipped before anything changes.
      await skipped.next();
      await skipped.next();
      await s.log.endRun(merged.runId);
      put(s, "task", "t-1", { title: "One", phase: "merged", auto: true });
      const ended = await sent.next();
      expect(ended.meta).toMatchObject({ id: "t-1", reason: "ended" });
      // The answer for t-2 is refused: the mark ends and the wait is announced.
      put(s, "task", "t-2", { title: "Two", phase: "ready", auto: false });
      const waiting = await sent.next();
      expect(waiting.meta).toMatchObject({ id: "t-2", reason: "waiting" });
      expect(waiting.content).toContain("ready to merge");
      expect(sent.all).toHaveLength(2);
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });
});

describe("a proposed task", () => {
  test("is pending and drawn waiting; one block for what the plugin opened, none for a person's", async () => {
    const s = await setup();
    const sent = new Sent();
    const channel = await startClaudeChannel({
      notify: ["waiting"],
      views: s.views,
      registry: s.registry,
      log: s.log,
      pending: () => listPending(s.log, s.registry, undefined, s.views),
      send: sent.push,
    });
    try {
      put(s, "task", "t-person", { title: "Mine", phase: "proposed" });
      put(s, "task", "t-dev", { title: "Theirs", phase: "proposed", by: "dev" });
      const block = await sent.next();
      expect(block.meta).toMatchObject({ id: "t-dev", waiting: "true", reason: "waiting" });
      const items = await listPending(s.log, s.registry, undefined, s.views);
      expect(items.map((item) => item.object).sort()).toEqual(["task:t-dev", "task:t-person"]);
      expect(items.find((item) => item.object === "task:t-person")?.row?.waiting).toBe(true);
      // The person's task was seen before the block arrived; nothing else was sent.
      expect(sent.all).toHaveLength(1);
      // Confirmed, the task leaves pending and nothing is sent.
      put(s, "task", "t-dev", { title: "Theirs", phase: "ready", by: "dev" });
      expect((await listPending(s.log, s.registry)).map((item) => item.object)).toEqual(["task:t-person"]);
    } finally {
      await channel.close();
      s.views.close();
      await s.log.close();
    }
  });
});
