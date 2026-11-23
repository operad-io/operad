import { afterAll, describe, expect, test } from "bun:test";
import { createViews } from "@operad-io/engine";
import { mainChatOf } from "@operad-io/chat";
import { openChat } from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

type R = Awaited<ReturnType<typeof rig>>;

async function pageData(r: R, bot: string): Promise<unknown> {
  const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
  try {
    return (await views.section(`bot:${bot}`, "bot")).data;
  } finally {
    views.close();
  }
}

describe("the bot's main chat", () => {
  test("a bot with no open chat has none", async () => {
    const r = await rig({ other: {} });
    expect(await mainChatOf(r.store, "bot:default")).toBeUndefined();
    expect(await pageData(r, "default")).toEqual({ mainChat: null });
  });

  test("the most recent open chat is the main chat, and closing it falls back to the one before", async () => {
    const r = await rig({ other: {} });
    const first = await r.open("default");
    const second = await r.open("default");
    await r.open("other");
    expect(await mainChatOf(r.store, "bot:default")).toBe(second);
    expect(await pageData(r, "default")).toEqual({ mainChat: `chat:${second}` });
    await r.act("chat", second, "chat/close");
    expect(await mainChatOf(r.store, "bot:default")).toBe(first);
    await r.act("chat", first, "chat/close");
    expect(await mainChatOf(r.store, "bot:default")).toBeUndefined();
  });

  test("a chat bound to Telegram is the main chat even when a newer one is open", async () => {
    const r = await rig();
    const bound = await r.open("default", { channels: ["telegram:42"] });
    const newer = await r.open("default");
    expect(newer > bound).toBe(true);
    expect(await mainChatOf(r.store, "bot:default")).toBe(bound);
    // A closed bound chat no longer holds the place.
    await r.act("chat", bound, "chat/close");
    expect(await mainChatOf(r.store, "bot:default")).toBe(newer);
  });

  test("a chat a scheduled prompt opened is not the main chat", async () => {
    const r = await rig();
    const person = await r.open("default");
    // A chat a scheduled prompt opened before routines were their own objects.
    await openChat({
      store: r.store,
      home: r.home,
      settings: { bot: { bots: {} } } as never,
      harnesses: ["claude"],
      bot: "default",
      scheduled: { bot: "default", entry: "Morning" },
      cause: "test",
    });
    expect(await mainChatOf(r.store, "bot:default")).toBe(person);
  });
});
