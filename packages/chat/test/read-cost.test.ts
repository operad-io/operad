import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FactsOptions, FactsPage, ObjectRef, ObjectStore, PluginFact, ViewContext } from "@operad-io/engine";
import { agentLogPath, allMessages, chatViews, CHAT_TYPE, MESSAGE_CHANGE_FACT, MESSAGE_FACT, RUN_FACT } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

/** A store that counts the chat fact scans its reader makes. */
function countedStore(inner: ObjectStore): { readonly store: ObjectStore; readonly scans: () => number } {
  let scans = 0;
  const store = Object.create(inner) as ObjectStore;
  store.facts = ((object?: ObjectRef, options?: FactsOptions) => {
    if (object === undefined) return inner.facts();
    scans += 1;
    return inner.facts(object, options);
  }) as ObjectStore["facts"];
  return { store, scans: () => scans };
}

/** Counts the chat fact scans a reply round makes through the rig's own store. */
function countChatScans(r: Rig): { readonly scans: () => number; readonly restore: () => void } {
  const store = r.store;
  const original = store.facts as unknown as (
    object?: ObjectRef,
    options?: FactsOptions,
  ) => readonly PluginFact[] | FactsPage;
  let scans = 0;
  store.facts = ((object?: ObjectRef, options?: FactsOptions) => {
    if (object !== undefined && object.type === CHAT_TYPE) scans += 1;
    return object === undefined ? original.call(store) : original.call(store, object, options);
  }) as typeof store.facts;
  return {
    scans: () => scans,
    restore: () => {
      store.facts = original as typeof store.facts;
    },
  };
}

describe("what reading a chat costs", () => {
  test("one live push scans the facts once and does not refresh the bot", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat({ parent: "bot:default" });
    await r.store.put("bot", "default", { speaker: "Nova" }, "test");
    await r.say(chat, "go");
    await r.store.append({
      type: RUN_FACT,
      object: { type: CHAT_TYPE, id: chat },
      cause: "test",
      data: { runId: "run-live" },
    });
    const object = await r.store.get(CHAT_TYPE, chat);
    if (object === undefined) throw new Error("no chat");
    const counted = countedStore(r.store);
    let botRefreshes = 0;
    let valueReads = 0;
    let secretGets = 0;
    const ctx = {
      plugin: "chat",
      home: join(r.root, "home"),
      cwd: r.root,
      store: counted.store,
      settings: {},
      secrets: {
        names: async (): Promise<readonly string[]> => [],
        get: async () => {
          secretGets += 1;
          return undefined;
        },
        values: async (): Promise<readonly string[]> => {
          valueReads += 1;
          return [];
        },
      },
      runTimes: async () => ({ startedAt: 1, endedAt: null, segments: [] }),
      refreshedObject: async (type: string, id: string) => {
        if (type === "bot") botRefreshes += 1;
        return r.store.get(type, id);
      },
    } as unknown as ViewContext;
    const live = chatViews.tail;
    if (live === undefined) throw new Error("the chat type pushes no tail");
    const pushed = await live(ctx, object);
    expect(pushed?.status?.text).toBe("Starting");
    expect(counted.scans()).toBe(1);
    expect(botRefreshes).toBe(0);
    expect(valueReads).toBe(1);
    expect(secretGets).toBe(0);
  });

  test("one reply round scans the chat a bounded number of times", async () => {
    const r = await rig(() => reply("hello"));
    const chat = await r.chat();
    await r.say(chat, "go");
    const counted = countChatScans(r);
    try {
      expect((await r.round(chat)).result).toBe("done");
    } finally {
      counted.restore();
    }
    expect(counted.scans()).toBeLessThanOrEqual(4);
  });
});

test("a live tail keeps the stored speaker while a load refreshes a renamed bot", async () => {
  const r = await rig(() => reply("x"));
  const chat = await r.chat({ parent: "bot:default" });
  const oldBot = await r.store.put("bot", "default", { speaker: "Nova" }, "test");
  await r.say(chat, "go");
  const run = "run-speaker";
  await r.store.append({
    type: RUN_FACT,
    object: { type: CHAT_TYPE, id: chat },
    cause: "test",
    data: { runId: run },
  });
  const path = agentLogPath(r.store.root, "fake", run);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ type: "text_delta", text: "hello", receivedAt: 1 })}\n`,
  );
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");

  const store = Object.create(r.store) as ObjectStore;
  const original = r.store.get.bind(r.store);
  store.get = ((type: string, id: string) =>
    type === "bot" ? oldBot : original(type, id)) as ObjectStore["get"];
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store,
    settings: {},
    secrets: {
      names: async (): Promise<readonly string[]> => [],
      get: async () => undefined,
      values: async (): Promise<readonly string[]> => [],
    },
    runTimes: async () => ({ startedAt: 1, endedAt: null, segments: [] }),
    refreshedObject: async (type: string, id: string) => r.store.get(type, id),
  } as unknown as ViewContext;

  const live = chatViews.tail;
  if (live === undefined) throw new Error("the chat type pushes no tail");
  expect((await live(ctx, object))?.tail).toContain("**Nova:** hello");

  await r.store.put("bot", "default", { speaker: "Ada" }, "test");
  await r.store.append({
    type: MESSAGE_FACT,
    object: { type: CHAT_TYPE, id: chat },
    cause: "test",
    data: {
      id: "m-stored",
      role: "assistant",
      from: { via: "agent", id: "default" },
      text: "stored hello",
      attachments: [],
      source: { kind: "agent", ref: null },
      runId: run,
    },
  });
  const loaded = await chatViews.load(ctx, object, "transcript", {});
  expect(loaded.markdown).toContain("**Ada**");
  expect(loaded.markdown).not.toContain("**Nova**");
});

test("a withdrawal removes a person's message but never an answer", async () => {
  const r = await rig(() => reply("x"));
  const chat = await r.chat();
  await r.say(chat, "go");
  const answer = "m-answer";
  await r.store.append({
    type: MESSAGE_FACT,
    object: { type: CHAT_TYPE, id: chat },
    cause: "test",
    data: {
      id: answer,
      role: "assistant",
      from: { via: "agent", id: "default" },
      text: "the answer stays",
      attachments: [],
      source: { kind: "agent", ref: null },
    },
  });
  await r.store.append({
    type: MESSAGE_CHANGE_FACT,
    object: { type: CHAT_TYPE, id: chat },
    cause: "test",
    data: { id: answer, kind: "withdraw", by: { via: "tui", id: "1" } },
  });
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
    secrets: {
      names: async (): Promise<readonly string[]> => [],
      get: async () => undefined,
      values: async (): Promise<readonly string[]> => [],
    },
  } as unknown as ViewContext;
  const loaded = await chatViews.load(ctx, object, "transcript", {});
  expect(loaded.markdown).toContain("the answer stays");
  expect(allMessages(r.store, chat).map((message) => message.text)).toContain(
    "the answer stays",
  );
});
