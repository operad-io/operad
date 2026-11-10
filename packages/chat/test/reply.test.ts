import { afterAll, describe, expect, test } from "bun:test";
import { allMessages, currentSession, unanswered } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

describe("chat/reply", () => {
  test("answers the unanswered messages from the facts and keeps the session", async () => {
    const r = await rig(() => reply("hello back", "s-9"));
    const chat = await r.chat();
    await r.say(chat, "hello");
    const result = await r.round(chat);
    expect(result.result).toBe("done");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.params.prompt).toBe("hello");
    expect(r.calls[0]?.params.resumeSession).toBeUndefined();
    const messages = allMessages(r.store, chat);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hello back"],
    ]);
    expect(unanswered(messages)).toEqual([]);
    expect((await r.store.get("chat", chat))?.data.session).toBe("s-9");
  });

  test("a rerun after the reply was recorded does not answer twice", async () => {
    const r = await rig(() => reply("once"));
    const chat = await r.chat();
    await r.say(chat, "ask");
    await r.round(chat);
    const again = await r.round(chat);
    expect(again.result).toBe("done");
    expect(r.calls).toHaveLength(1);
    expect(allMessages(r.store, chat).filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  test("a message that arrives during a reply is answered in the next round, on the same session", async () => {
    let arrived = "";
    const r = await rig(async () => {
      if (r.calls.length === 1) arrived = await r.say(chatId, "second");
      return reply(`answer ${r.calls.length}`, `s-${r.calls.length}`);
    });
    const chatId = await r.chat();
    await r.say(chatId, "first");
    const one = await r.round(chatId);
    expect(one.result).toBe("more");
    const two = await r.round(chatId);
    expect(two.result).toBe("done");
    expect(r.calls.map((call) => call.params.prompt)).toEqual(["first", "second"]);
    expect(r.calls[1]?.params.resumeSession).toBe("s-1");
    const messages = allMessages(r.store, chatId);
    const first = messages[0]?.id ?? "";
    expect(messages.filter((message) => message.role === "assistant").map((message) => message.replyTo)).toEqual([
      [first],
      [arrived],
    ]);
  });

  test("several unanswered messages go in one prompt, oldest first", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.say(chat, "two");
    await r.round(chat);
    expect(r.calls[0]?.params.prompt).toBe("one\n\ntwo");
  });

  test("the session after the last reply wins over a stale reference on the chat", async () => {
    const r = await rig(() => reply("ok", "fresh"));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    const stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    await r.store.put("chat", chat, { ...stored.data, session: "stale" }, "test");
    const messages = allMessages(r.store, chat);
    expect(currentSession({ ...stored.data, session: "stale" } as never, messages)).toBe("fresh");
  });

  test("a harness that fails leaves the messages unanswered", async () => {
    const r = await rig(() => ({ result: "failed", data: { message: "boom" } }));
    const chat = await r.chat();
    await r.say(chat, "hi");
    const result = await r.round(chat);
    expect(result.result).toBe("failed");
    expect(unanswered(allMessages(r.store, chat))).toHaveLength(1);
  });

  test("a harness that is not loaded fails the round and says which", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    await r.store.put("chat", chat, { ...stored.data, harness: "absent" }, "test");
    await r.say(chat, "hi");
    const result = await r.round(chat);
    expect(result.result).toBe("failed");
    expect(JSON.stringify(result.data)).toContain("absent");
  });

  test("a question that ran out of grace ends the round as waiting and the answer resumes it", async () => {
    const r = await rig(async (ctx, call) => {
      if (call.params.askAnswer === undefined) {
        await ctx.ask({ prompt: "Proceed?", choices: ["yes", "no"], resume: "s-q" });
      }
      return reply("continued", "s-q");
    });
    const chat = await r.chat();
    await r.say(chat, "do it");
    const asker = {
      async ask() {
        return { kind: "timeout" as const, waitId: "w1", prompt: "Proceed?", choices: ["yes", "no"] };
      },
      async useGrant() {
        return false;
      },
    };
    const waiting = await r.round(chat, {}, asker);
    expect(waiting.result).toBe("waiting");
    expect(unanswered(allMessages(r.store, chat))).toHaveLength(1);
    const resumed = await r.round(chat, { resumeSession: "s-q", askAnswer: { prompt: "Proceed?", choice: "yes" } });
    expect(resumed.result).toBe("done");
    expect(r.calls[1]?.params.resumeSession).toBe("s-q");
    expect(r.calls[1]?.params.askAnswer).toEqual({ prompt: "Proceed?", choice: "yes" });
  });
});
