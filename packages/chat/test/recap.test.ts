import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { allMessages, CHAT_TYPE, deliverResult, messageMarkdown, type Delivery } from "../src/index.ts";
import { cleanupRoots, clock, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

const HOUR = 3_600_000;
let now = 1_700_000_000_000;

beforeEach(() => {
  now = 1_700_000_000_000;
  clock.now = () => now;
});

async function send(r: Rig, chat: string, text: string): Promise<void> {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  await r.registry.runAction("chat/send", { note: text }, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

async function deliver(r: Rig, chat: string, runId: string, routine: string, failed = false): Promise<void> {
  const item: Delivery = { routine, runId, summary: "s", text: "whole result", from: { via: "bot", id: routine }, ...(failed ? { failed } : {}) };
  await deliverResult({ store: r.store, facts: { append: async (input) => r.store.append({ ...input, cause: "test" }) } }, chat, item);
}

const recaps = (r: Rig, chat: string) => allMessages(r.store, chat).filter((message) => message.role === "recap");

describe("a recap on return", () => {
  test("one message lists the routine results and replies that came while the person was away", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await send(r, chat, "first");
    now += 1_000;
    await r.round(chat);
    now += 5 * HOUR;
    await deliver(r, chat, "R-1", "Morning news");
    await deliver(r, chat, "R-2", "Morning news");
    await deliver(r, chat, "R-3", "Dreaming", true);
    now += HOUR;
    await send(r, chat, "back");
    const found = recaps(r, chat);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("Routine results: Morning news ×2, Dreaming (failed)");
    expect(found[0]?.text).toContain("1 reply finished");
    expect(found[0]?.text).toContain("6 h");
    expect(messageMarkdown(found[0] ?? (() => { throw new Error("none"); })())).toContain("**Recap**");
  });

  test("none when the person was not away for the set time", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await send(r, chat, "first");
    await r.round(chat);
    now += 3 * HOUR;
    await deliver(r, chat, "R-1", "Morning news");
    now += 59 * 60_000;
    await send(r, chat, "again");
    expect(recaps(r, chat)).toHaveLength(0);
  });

  test("a command counts as the person being there", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await send(r, chat, "first");
    await r.round(chat);
    now += 5 * HOUR;
    await send(r, chat, "/help");
    now += HOUR;
    await deliver(r, chat, "R-1", "Morning news");
    now += HOUR;
    await send(r, chat, "back");
    expect(recaps(r, chat)).toHaveLength(0);
  });

  test("none when nothing happened meanwhile, and none for the first message", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await send(r, chat, "first");
    now += 10 * HOUR;
    await send(r, chat, "second");
    expect(recaps(r, chat)).toHaveLength(0);
  });

  test("is never in the prompt, and starts no reply of its own", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await send(r, chat, "first");
    await r.round(chat);
    now += 6 * HOUR;
    await deliver(r, chat, "R-1", "Morning news");
    now += HOUR;
    await send(r, chat, "back");
    expect(recaps(r, chat)).toHaveLength(1);
    await r.round(chat);
    expect(String(r.calls[1]?.params.prompt)).not.toContain("While you were away");
    expect(r.calls).toHaveLength(2);
  });

  test("the away time is a setting: 0 turns the recap off", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await send(r, chat, "first");
    await r.round(chat);
    now += 5 * HOUR;
    await deliver(r, chat, "R-1", "Morning news");
    now += HOUR;
    const object = await r.store.get(CHAT_TYPE, chat);
    if (object === undefined) throw new Error("no chat");
    const { sendMessage } = await import("../src/index.ts");
    await sendMessage({ facts: { append: async (input) => r.store.append({ ...input, cause: "test" }) }, emit: undefined, actor: { via: "cli", id: "me" }, store: r.store, awayMinutes: 0 }, chat, "back");
    expect(recaps(r, chat)).toHaveLength(0);
  });
});
