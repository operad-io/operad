import { afterAll, describe, expect, test } from "bun:test";
import {
  allMessages,
  CHAT_TYPE,
  chatData,
  chatRef,
  commandOfFact,
  currentSession,
  lastReplyContext,
  type Command,
} from "../src/index.ts";
import { readChat } from "../src/model.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

async function command(r: Rig, chat: string, text: string) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/send", { note: text }, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

function lines(r: Rig, chat: string): readonly Command[] {
  return r.store
    .facts(chatRef(chat))
    .facts.map(commandOfFact)
    .filter((item): item is Command => item !== undefined);
}

describe("/new", () => {
  test("the next reply starts a session with no resume, the transcript stays, and the line is recorded", async () => {
    const r = await rig(() => ({
      result: "done",
      data: { finalMessage: "hi", sessionId: "s-1", context: { used: 50 } },
    }));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    expect(r.calls[0]?.params.resumeSession).toBeUndefined();
    await r.say(chat, "two");
    await r.round(chat);
    expect(r.calls[1]?.params.resumeSession).toBe("s-1");

    const stored = await r.store.get(CHAT_TYPE, chat);
    if (stored === undefined) throw new Error("no chat");
    const before = readChat(r.store, chat);
    expect(lastReplyContext(chatData(stored.data), before.messages, before.facts)?.used).toBe(50);

    const done = await command(r, chat, "/new");
    expect(String(done.value)).toContain("started a new session");
    expect(lines(r, chat).at(-1)).toMatchObject({ command: "/new", ok: true });
    expect(allMessages(r.store, chat)).toHaveLength(4);

    const fresh = await r.store.get(CHAT_TYPE, chat);
    if (fresh === undefined) throw new Error("no chat");
    const read = readChat(r.store, chat);
    expect(currentSession(chatData(fresh.data), read.messages, read.facts)).toBeUndefined();
    expect(lastReplyContext(chatData(fresh.data), read.messages, read.facts)).toBeUndefined();

    await r.say(chat, "three");
    await r.round(chat);
    expect(r.calls[2]?.params.resumeSession).toBeUndefined();
    expect(allMessages(r.store, chat)).toHaveLength(6);
  });

  test("an agent that reports no session id still shows no context after /new", async () => {
    const r = await rig(() => ({ result: "done", data: { finalMessage: "hi", context: { used: 7 } } }));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await command(r, chat, "/new");
    const stored = await r.store.get(CHAT_TYPE, chat);
    if (stored === undefined) throw new Error("no chat");
    const read = readChat(r.store, chat);
    expect(lastReplyContext(chatData(stored.data), read.messages, [])?.used).toBe(7);
    expect(lastReplyContext(chatData(stored.data), read.messages, read.facts)).toBeUndefined();
  });

  test("it is refused while a reply is running and changes nothing", async () => {
    let open: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      open = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await rig(async () => {
      open();
      await held;
      return reply("done", "s-1");
    });
    const chat = await r.chat();
    await r.say(chat, "go");
    const round = r.round(chat);
    await entered;
    await command(r, chat, "/new");
    expect(lines(r, chat).at(-1)).toMatchObject({ command: "/new", ok: false });
    expect(lines(r, chat).at(-1)?.outcome).toContain("writing a reply");
    expect(readChat(r.store, chat).facts.some((fact) => fact.type === "chat.new")).toBe(false);
    release();
    await round;
  });

  test("the first message after /new carries a pointer to the earlier record, and only that one", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    expect(String(r.calls[0]?.params.prompt)).not.toContain("Earlier record");
    await command(r, chat, "/new");
    await r.say(chat, "two");
    await r.round(chat);
    const prompt = String(r.calls[1]?.params.prompt);
    expect(prompt).toContain("[Earlier record of this chat]");
    expect(prompt).toContain(`chat:${chat}`);
    expect(prompt).toContain("`section`");
    expect(prompt).toContain("`search`");
    expect(prompt.indexOf("[End of earlier record]")).toBeLessThan(prompt.indexOf("two"));
    await r.say(chat, "three");
    await r.round(chat);
    expect(String(r.calls[2]?.params.prompt)).not.toContain("Earlier record");
  });

  test("it is a command with a one-line description", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const help = await command(r, chat, "/help");
    expect(String(help.value)).toContain("/new");
  });
});
