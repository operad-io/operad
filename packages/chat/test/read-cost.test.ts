import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FactsOptions, FactsPage, ObjectRef, ObjectStore, PluginFact, ViewContext } from "@operad-io/engine";
import { chatViews, CHAT_TYPE, RUN_FACT } from "../src/index.ts";
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
