import { afterAll, describe, expect, test } from "bun:test";
import type { ViewContext } from "@operad-io/engine";
import { allMessages, chatViews } from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

function usageReply(model: string, micros: number, quality: string) {
  return () => ({
    result: "done" as const,
    data: { finalMessage: "hi", sessionId: "s", usage: { model, costMicros: micros, costQuality: quality } },
  });
}

async function rowOf(r: Awaited<ReturnType<typeof rig>>, chat: string) {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  return { object, row: chatViews.row(object) };
}

describe("the chat row says the agent", () => {
  test("a chat with no reply yet shows the agent alone", async () => {
    const r = await rig(usageReply("sonnet", 0, "exact"));
    const chat = await r.chat();
    expect((await rowOf(r, chat)).row.note).toBe("fake");
  });

  test("after a reply the note has agent, model and cost; an estimate is marked ~$", async () => {
    const r = await rig(usageReply("sonnet", 120000, "estimated"));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);
    expect((await rowOf(r, chat)).row.note).toBe("fake · sonnet · ~$0.12");
  });

  test("the cost adds up over replies and keeps the least exact quality", async () => {
    let n = 0;
    const r = await rig(() => {
      n += 1;
      return usageReply("opus", 100000, n === 1 ? "exact" : "estimated")();
    });
    const chat = await r.chat();
    await r.say(chat, "a");
    await r.round(chat);
    expect((await rowOf(r, chat)).row.note).toBe("fake · opus · $0.10");
    await r.say(chat, "b");
    await r.round(chat);
    expect((await rowOf(r, chat)).row.note).toBe("fake · opus · ~$0.20");
  });

  test("a reply without usage leaves the agent alone", async () => {
    const r = await rig(() => ({ result: "done" as const, data: { finalMessage: "hi", sessionId: "s" } }));
    const chat = await r.chat();
    await r.say(chat, "a");
    await r.round(chat);
    expect((await rowOf(r, chat)).row.note).toBe("fake");
  });

  test("the page names the agent at the top and each answer carries its model and cost", async () => {
    const r = await rig(usageReply("sonnet", 120000, "exact"));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);
    const { object } = await rowOf(r, chat);
    const ctx = { store: r.store, settings: {}, plugin: "chat" } as unknown as ViewContext;
    const markdown = (await chatViews.load(ctx, object, "transcript", {})).markdown;
    expect(markdown.startsWith("Agent: fake · sonnet · $0.12\n")).toBe(true);
    expect(markdown).toContain("hi\n\n*sonnet · $0.12*");
    expect(allMessages(r.store, chat).find((m) => m.role === "assistant")?.model).toBe("sonnet");
  });
});
