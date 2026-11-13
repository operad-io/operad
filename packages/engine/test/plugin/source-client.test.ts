import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  HISTORY_SECTION,
  Kernel,
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  ViewError,
  createViews,
  defineFlow,
  definePlugin,
  openLog,
  serveOnce,
  type ClientApi,
  type PendingItem,
} from "../../src/index.ts";
import { FileSecretStore } from "../../src/plugin/secrets.ts";
import { DEFAULT_HTTP_TOKEN_LABEL, ensureHttpToken, readHttpToken } from "../../src/http/token.ts";
import { recordAnswer } from "../../src/runner/answer.ts";
import { parseObjectKey } from "../../src/runner/service.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const ACTOR = { via: "chat-channel", id: "person-7" } as const;

const flow = defineFlow({
  name: "gated",
  entry: "ask",
  steps: [
    {
      id: "ask",
      kind: "wait_person",
      params: { prompt: "Approve?", choices: ["approve"] },
      replay: "safe",
      next: { approve: "done", interrupted: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const gate = definePlugin({
  name: "gate",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "item" }],
  flows: [flow],
  actions: [
    {
      name: "approve",
      on: "item",
      // The action's own rule: an item answered once offers no second answer.
      when: (state) => state.answered !== true,
      async run(ctx) {
        await ctx.answer?.("approve");
        await ctx.store.put("item", ctx.object.id, { answered: true }, "approve");
      },
    },
  ],
  views: {
    item: {
      row: (object) => ({ id: object.id, title: object.id, state: "open" }),
      sections: () => [],
      load: () => ({ markdown: "" }),
    },
  },
});

/** What the test channel saw and did, and the client it was given. */
interface Channel {
  client: ClientApi | undefined;
  seen: PendingItem[];
  answered: () => Promise<void>;
}

function channelPlugin(channel: Channel) {
  let answeredNow: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    answeredNow = resolve;
  });
  channel.answered = () => answered;
  return definePlugin({
    name: "chat-channel",
    kind: "source",
    version: "0.0.1",
    start(ctx) {
      channel.client = ctx.client;
      const stream = ctx.client.events()[Symbol.asyncIterator]();
      const loop = (async () => {
        for (;;) {
          const next = await stream.next();
          if (next.done === true) return;
          for (const item of await ctx.client.pending()) {
            if (item.object === undefined || channel.seen.some((s) => s.runId === item.runId)) {
              continue;
            }
            channel.seen.push(item);
            await ctx.client.act("gate:approve", item.object, { actor: ACTOR });
            answeredNow();
          }
        }
      })();
      return {
        async stop() {
          await stream.return?.();
          await loop;
        },
      };
    },
  });
}

describe("a source plugin's start gets the client API", () => {
  test("it sees a waiting item, answers it with an actor, and history names the actor", async () => {
    const root = await tempRoot();
    const storeRoot = join(root, "store");
    const store = new MemoryPluginStore({ root: storeRoot });
    const channel: Channel = { client: undefined, seen: [], answered: () => Promise.resolve() };
    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const registry = new PluginRegistry([gate, channelPlugin(channel)], {
      home: root,
      storeRoot,
      store,
      onLog: () => undefined,
      onAnswer: (runId, choice, note, actor) =>
        recordAnswer({
          log,
          runId,
          choice,
          ...(note === undefined ? {} : { note }),
          actor,
        }),
    });
    const views = createViews({ registry, store, log });
    const kernel = new Kernel({
      log,
      registry,
      home: root,
      storeRoot,
      rules: [],
      client: views,
      onLog: () => undefined,
    });
    try {
      store.put("item", "1", {}, "test");
      await kernel.startSources();
      // The channel is handed the very object HTTP and the TUI use.
      expect(channel.client).toBe(views);
      expect(typeof channel.client?.answer).toBe("function");
      expect(typeof channel.client?.pending).toBe("function");

      const started = await kernel.start({ flow: "gated", object: "item:1" });
      if (started.kind !== "started") throw new Error(`not started: ${started.kind}`);

      const pass = async (recover: boolean): Promise<void> => {
        const runners: Promise<void>[] = [];
        await serveOnce({
          log,
          registry,
          kernel,
          lockRoot: storeRoot,
          storeRoot,
          home: root,
          spawnRun: (runId) => {
            runners.push(
              (async () => {
                const object = parseObjectKey("item:1");
                await new Runner({
                  log,
                  flow,
                  runId,
                  registry,
                  lockRoot: storeRoot,
                  recover,
                  ...(object === undefined ? {} : { object }),
                }).run();
              })(),
            );
          },
        });
        await Promise.all(runners);
      };

      // The run reaches its wait; the channel hears of it through events,
      // finds it in pending and answers.
      await pass(false);
      await channel.answered();
      expect(channel.seen.map((item) => item.choices)).toEqual([["approve"]]);

      // The answer is applied and the run goes on to its end.
      let active = true;
      for (let round = 0; round < 5 && active; round += 1) {
        await pass(true);
        const run = (await log.runs()).find((item) => item.runId === started.runId);
        active = run?.active !== false;
      }
      expect(active).toBe(false);
      const history = await views.section("item:1", HISTORY_SECTION);
      expect(history.markdown).toContain("via chat-channel");
      expect(history.markdown).toContain("as person-7");

      // A second answer to the same item is refused, and the action is not
      // offered on it any more; the refusal runs nothing.
      const ref = { type: "item", id: "1" };
      const before = store.facts(ref).facts.length;
      const second = await channel.client?.act("gate:approve", "item:1", { actor: ACTOR }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(second).toBeInstanceOf(ViewError);
      expect(store.facts(ref).facts.length).toBe(before);
    } finally {
      await kernel.stopSources();
      views.close();
      await log.close();
    }
  });

  test("act without an actor is refused and answers nothing", async () => {
    const root = await tempRoot();
    const storeRoot = join(root, "store");
    const store = new MemoryPluginStore({ root: storeRoot });
    const registry = new PluginRegistry([gate], { home: root, storeRoot, store });
    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const views = createViews({ registry, store, log });
    try {
      store.put("item", "1", {}, "test");
      const ref = { type: "item", id: "1" };
      const before = store.facts(ref).facts.length;
      const noActor = views.act("gate:approve", "item:1", {} as never);
      await expect(noActor).rejects.toThrow(/needs an actor/);
      const empty = views.act("gate:approve", "item:1", { actor: { via: "x", id: "" } });
      await expect(empty).rejects.toThrow(/needs an actor/);
      // Nothing ran: the item has no new fact and was not answered.
      expect(store.facts(ref).facts.length).toBe(before);
      expect(store.get("item", "1")?.data.answered).toBeUndefined();
    } finally {
      views.close();
      await log.close();
    }
  });

  test("answer without an actor is refused and answers nothing", async () => {
    const root = await tempRoot();
    const storeRoot = join(root, "store");
    const store = new MemoryPluginStore({ root: storeRoot });
    const registry = new PluginRegistry([gate], { home: root, storeRoot, store });
    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const views = createViews({ registry, store, log });
    try {
      const answerWithout = views.answer({ runId: "r", waitId: "w", choice: "x" } as never);
      await expect(answerWithout).rejects.toThrow(/answer needs an actor/);
      const answerEmpty = views.answer({
        runId: "r",
        waitId: "w",
        choice: "x",
        actor: { via: "x", id: "" },
      });
      await expect(answerEmpty).rejects.toThrow(/answer needs an actor/);
    } finally {
      views.close();
      await log.close();
    }
  });

  test("an empty token label acts under the default label, so its actions are not refused", async () => {
    const home = await tempRoot();
    await ensureHttpToken(home);
    await new FileSecretStore({ home, plugin: "http" }).set("label", "");
    expect((await readHttpToken(home))?.label).toBe(DEFAULT_HTTP_TOKEN_LABEL);
    expect((await ensureHttpToken(home)).label).toBe(DEFAULT_HTTP_TOKEN_LABEL);
  });

  test("pending shows the trigger candidates HTTP shows", async () => {
    const root = await tempRoot();
    const storeRoot = join(root, "store");
    const store = new MemoryPluginStore({ root: storeRoot });
    const registry = new PluginRegistry([gate], { home: root, storeRoot, store });
    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const views = createViews({ registry, store, log });
    const kernel = new Kernel({
      log,
      registry,
      home: root,
      storeRoot,
      rules: [
        {
          source: "feed",
          type: "new",
          start: { flow: "gated" },
          object: "item:1",
          mode: "candidate",
        },
      ],
      client: views,
      onLog: () => undefined,
    });
    views.useCandidates(kernel);
    try {
      store.put("item", "1", {}, "test");
      expect(await views.pending()).toEqual([]);
      await kernel.receive({ source: "feed", key: "k1", type: "new", hops: 0 });
      const items = await views.pending();
      expect(items.map((item) => item.kind)).toEqual(["candidate"]);
    } finally {
      views.close();
      await log.close();
    }
  });
});
