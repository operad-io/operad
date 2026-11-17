import { afterAll, describe, expect, test } from "bun:test";
import { Views, type PluginStepResult } from "@operad-io/engine";
import { allMessages, CHAT_TYPE } from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

const MODELS = {
  list: ["small", "large"],
  default: "small",
  windows: { small: 100_000, large: 200_000 },
} as const;

function answer(sessionId: string, model: string, used: number): PluginStepResult {
  return {
    result: "done",
    data: {
      finalMessage: "ok",
      sessionId,
      usage: {
        model,
        tokens: { input: 40, output: 2, cacheread: 0, cachewrite: 0 },
        costMicros: 10,
        costQuality: "exact",
      },
      context: { used },
    },
  };
}

describe("a chat's context usage", () => {
  test("the reply records the last call's context and the model's window, and the view shows both", async () => {
    const r = await rig(() => answer("s-1", "small", 25_059), MODELS);
    const chat = await r.chat({ model: "small" });
    await r.say(chat, "hello");
    await r.round(chat);

    const reply = allMessages(r.store, chat).find((message) => message.role === "assistant");
    expect(reply?.context).toEqual({ used: 25_059, window: 100_000 });

    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const object = await views.get(`${CHAT_TYPE}:${chat}`);
      expect(object.context).toEqual({ used: 25_059, window: 100_000, model: "small" });
      const section = await views.section(`${CHAT_TYPE}:${chat}`, "transcript", undefined, {});
      expect(section.context).toEqual({ used: 25_059, window: 100_000, model: "small" });
      const after = await views.section(`${CHAT_TYPE}:${chat}`, "transcript", undefined, { after: section.mark });
      expect(after.context).toEqual({ used: 25_059, window: 100_000, model: "small" });
    } finally {
      views.close();
    }
  });

  test("a new session clears the view until the next reply", async () => {
    let count = 0;
    const r = await rig(() => {
      count += 1;
      return answer(`s-${count}`, "small", count === 1 ? 1_000 : 2_000);
    }, MODELS);
    const chat = await r.chat({ model: "small" });
    await r.say(chat, "one");
    await r.round(chat);

    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      expect((await views.get(`${CHAT_TYPE}:${chat}`)).context?.used).toBe(1_000);

      // `/new` starts a session, so the session reference is cleared first.
      const stored = await r.store.get(CHAT_TYPE, chat);
      if (stored === undefined) throw new Error("no chat");
      await r.store.put(CHAT_TYPE, chat, { ...stored.data, session: null }, "action:chat/new");
      expect((await views.get(`${CHAT_TYPE}:${chat}`)).context).toBeUndefined();
      const section = await views.section(`${CHAT_TYPE}:${chat}`, "transcript", undefined, {});
      expect(section.context).toBeUndefined();

      await r.say(chat, "two");
      await r.round(chat);
      expect((await views.get(`${CHAT_TYPE}:${chat}`)).context).toEqual({
        used: 2_000,
        window: 100_000,
        model: "small",
      });
    } finally {
      views.close();
    }
  });

  test("a model whose window the agent does not know leaves the window out", async () => {
    const r = await rig(() => answer("s-1", "small", 40), { list: ["small"], default: "small" });
    const chat = await r.chat({ model: "small" });
    await r.say(chat, "hello");
    await r.round(chat);

    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const object = await views.get(`${CHAT_TYPE}:${chat}`);
      expect(object.context).toEqual({ used: 40, model: "small" });
      expect(object.context).not.toHaveProperty("window");
    } finally {
      views.close();
    }
  });

  test("a harness that reports no context leaves it out of the reply and the view", async () => {
    const r = await rig(() => ({
      result: "done",
      data: {
        finalMessage: "ok",
        sessionId: "s-1",
        usage: {
          model: "small",
          tokens: { input: 4, output: 2, cacheread: 0, cachewrite: 0 },
          costMicros: null,
          costQuality: null,
        },
      },
    }), MODELS);
    const chat = await r.chat({ model: "small" });
    await r.say(chat, "hello");
    await r.round(chat);

    const reply = allMessages(r.store, chat).find((message) => message.role === "assistant");
    expect(reply?.context).toBeUndefined();
    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      expect((await views.get(`${CHAT_TYPE}:${chat}`)).context).toBeUndefined();
    } finally {
      views.close();
    }
  });
});
