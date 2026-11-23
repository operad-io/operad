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

  describe("with a goal", () => {
    const briefing = (call: { params: Record<string, unknown> }): boolean =>
      String(call.params.prompt).includes("Write a short brief");

    test("one call builds the brief from the old session; the new session starts with it; the cost is recorded", async () => {
      const r = await rig((_ctx, call) =>
        briefing(call)
          ? {
              result: "done",
              data: { finalMessage: "We chose SQLite. Touched db.ts.", usage: { model: "m", costMicros: 40, costQuality: "exact" } },
            }
          : {
              result: "done",
              data: { finalMessage: "hi", sessionId: `s-${r.calls.length}`, usage: { model: "m", costMicros: 100, costQuality: "exact" } },
            },
      );
      const chat = await r.chat();
      await r.say(chat, "one");
      await r.round(chat);
      const done = await command(r, chat, "/new add the export command");
      expect(String(done.value)).toContain("brief");
      expect(r.events.some((event) => String(event.key).startsWith("new:"))).toBe(true);
      expect(lines(r, chat).at(-1)).toMatchObject({ command: "/new add the export command", ok: true });

      await r.round(chat);
      const call = r.calls[1];
      expect(call?.params.resumeSession).toBe("s-1");
      expect(String(call?.params.prompt)).toContain("add the export command");
      expect(r.calls).toHaveLength(2);
      expect(allMessages(r.store, chat)).toHaveLength(2);

      const read = readChat(r.store, chat);
      const entry = read.entries.find((item) => item.toolName === "/new");
      expect(entry).toMatchObject({ kind: "tool", input: "add the export command", output: "We chose SQLite. Touched db.ts.", result: "done" });
      const stored = await r.store.get(CHAT_TYPE, chat);
      expect(chatData(stored?.data ?? {}).costMicros).toBe(140);

      await r.say(chat, "go");
      await r.round(chat);
      const first = r.calls[2];
      expect(first?.params.resumeSession).toBeUndefined();
      expect(String(first?.params.prompt)).toContain("We chose SQLite. Touched db.ts.");
      expect(String(first?.params.prompt)).toContain("Goal for this session: add the export command");
      await r.say(chat, "more");
      await r.round(chat);
      expect(String(r.calls[3]?.params.prompt)).not.toContain("We chose SQLite");
      expect(r.calls).toHaveLength(4);
      expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).costMicros).toBe(340);
    });

    test("a message sent before the round gets the brief in the same round, once", async () => {
      const r = await rig((_ctx, call) =>
        briefing(call) ? { result: "done", data: { finalMessage: "BRIEF" } } : reply("ok", "s-9"),
      );
      const chat = await r.chat();
      await r.say(chat, "one");
      await r.round(chat);
      await command(r, chat, "/new next goal");
      await r.say(chat, "start");
      await r.round(chat);
      expect(r.calls).toHaveLength(3);
      expect(String(r.calls[2]?.params.prompt)).toContain("BRIEF");
      expect(String(r.calls[2]?.params.prompt)).toContain("start");
      await r.round(chat);
      expect(r.calls).toHaveLength(3);
    });

    test("a failed brief call leaves the goal alone and does not hold the session back", async () => {
      const r = await rig((_ctx, call) =>
        briefing(call) ? { result: "failed", data: { reason: "model_error", message: "no quota" } } : reply("ok", "s-2"),
      );
      const chat = await r.chat();
      await r.say(chat, "one");
      await r.round(chat);
      await command(r, chat, "/new fix the build");
      await r.round(chat);
      const entry = readChat(r.store, chat).entries.find((item) => item.toolName === "/new");
      expect(entry).toMatchObject({ result: "failed" });
      await r.say(chat, "go");
      await r.round(chat);
      const prompt = String(r.calls.at(-1)?.params.prompt);
      expect(prompt).toContain("could not be made");
      expect(prompt).toContain("Goal for this session: fix the build");
      expect(r.calls.at(-1)?.params.resumeSession).toBeUndefined();
    });

    test("a chat with no session yet makes no call; and /new alone makes none", async () => {
      const r = await rig(() => reply("ok"));
      const chat = await r.chat();
      await command(r, chat, "/new write the plan");
      await r.round(chat);
      expect(r.calls).toHaveLength(0);
      await r.say(chat, "go");
      await r.round(chat);
      expect(String(r.calls[0]?.params.prompt)).toContain("Goal for this session: write the plan");

      await command(r, chat, "/new");
      expect(r.events.filter((event) => String(event.key).startsWith("new:"))).toHaveLength(1);
      await r.say(chat, "again");
      await r.round(chat);
      expect(String(r.calls[1]?.params.prompt)).not.toContain("Goal for this session");
    });

    test("it is refused while a reply is running, with a goal too", async () => {
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
      await command(r, chat, "/new the next thing");
      expect(lines(r, chat).at(-1)).toMatchObject({ ok: false });
      expect(readChat(r.store, chat).facts.some((fact) => fact.type === "chat.new")).toBe(false);
      expect(r.events.some((event) => String(event.key).startsWith("new:"))).toBe(false);
      release();
      await round;
    });
  });

  test("it is a command with a one-line description", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const help = await command(r, chat, "/help");
    expect(String(help.value)).toContain("/new");
  });
});
