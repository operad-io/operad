import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentDir } from "@operad-io/engine";
import { allMessages, unanswered } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

interface Inbox {
  listen(handler: (text: string) => void): () => void;
}

function latch(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Writes a file where the engine stores a chat's attachments. */
function stored(r: Rig, chat: string, name: string, body: string): string {
  const dir = join(attachmentDir(join(r.root, "home"), "chat", chat), "up-1");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

/** Waits for the next message the harness's inbox hands it. */
function nextInboxMessage(params: Record<string, unknown>): Promise<string> {
  const inbox = params.inbox as Inbox | undefined;
  if (inbox === undefined) throw new Error("the harness was given no inbox");
  return new Promise<string>((resolve) => {
    inbox.listen((text) => resolve(text));
  });
}

function assistantReplyTo(r: Rig, chat: string): readonly (readonly string[] | undefined)[] {
  return allMessages(r.store, chat)
    .filter((message) => message.role === "assistant")
    .map((message) => message.replyTo);
}

describe("a message that arrives while a chat reply is being written", () => {
  test("during text it is delivered once, marked answered by that reply and not answered again", async () => {
    let chat = "";
    let delivered = "";
    const r = await rig(
      async (ctx, call) => {
        if (r.calls.length === 1) {
          const message = nextInboxMessage(call.params);
          ctx.receiver?.(JSON.stringify({ type: "text_delta", text: "writing" }));
          await r.say(chat, "second");
          delivered = await message;
          return reply("answer");
        }
        return reply("again");
      },
      undefined,
      "fake",
      "fake",
      [],
      { takesMessagesMidRun: true },
    );
    chat = await r.chat();
    await r.say(chat, "first");

    const result = await r.round(chat);
    expect(result.result).toBe("done");
    expect(delivered).toBe("second");
    expect(r.calls).toHaveLength(1);
    const messages = allMessages(r.store, chat);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "first"],
      ["user", "second"],
      ["assistant", "answer"],
    ]);
    expect(assistantReplyTo(r, chat)).toEqual([
      messages.filter((message) => message.role === "user").map((message) => message.id),
    ]);
    expect(unanswered(messages)).toEqual([]);

    expect((await r.round(chat)).result).toBe("done");
    expect(r.calls).toHaveLength(1);
    expect(assistantReplyTo(r, chat)).toHaveLength(1);
  });

  test("during a tool call it is delivered once, after the call, and not answered again", async () => {
    let chat = "";
    let delivered = "";
    const r = await rig(
      async (ctx, call) => {
        if (r.calls.length === 1) {
          const message = nextInboxMessage(call.params);
          ctx.receiver?.(
            JSON.stringify({
              type: "tool_execution_start",
              toolCallId: "t1",
              toolName: "Bash",
              input: "make",
              at: 1_000,
            }),
          );
          await r.say(chat, "second");
          delivered = await message;
          return reply("answer");
        }
        return reply("again");
      },
      undefined,
      "fake",
      "fake",
      [],
      { takesMessagesMidRun: true },
    );
    chat = await r.chat();
    await r.say(chat, "build it");

    const result = await r.round(chat);
    expect(result.result).toBe("done");
    expect(delivered).toBe("second");
    expect(r.calls).toHaveLength(1);
    const messages = allMessages(r.store, chat);
    expect(assistantReplyTo(r, chat)).toEqual([
      messages.filter((message) => message.role === "user").map((message) => message.id),
    ]);
    expect(unanswered(messages)).toEqual([]);
  });

  test("a message the worker does not take before the reply ends waits for the next round", async () => {
    let chat = "";
    const entered = latch();
    const finish = latch();
    const r = await rig(
      async () => {
        if (r.calls.length === 1) {
          entered.open();
          await finish.promise;
          return reply("first answer");
        }
        return reply("second answer");
      },
      undefined,
      "fake",
      "fake",
      [],
      { takesMessagesMidRun: true },
    );
    chat = await r.chat();
    await r.say(chat, "first");

    const round = r.round(chat);
    await entered.promise;
    await r.say(chat, "late");
    finish.open();
    const first = await round;
    expect(first.result).toBe("more");
    expect(assistantReplyTo(r, chat)[0]).toHaveLength(1);

    const second = await r.round(chat);
    expect(second.result).toBe("done");
    expect(r.calls.map((call) => call.params.prompt)).toEqual(["first", "late"]);
    const messages = allMessages(r.store, chat);
    const users = messages.filter((message) => message.role === "user");
    expect(assistantReplyTo(r, chat)).toEqual([
      users.slice(0, 1).map((message) => message.id),
      users.slice(1, 2).map((message) => message.id),
    ]);
    expect(unanswered(messages)).toEqual([]);
  });

  test("a message that arrives after the worker stops listening but before the reply is recorded waits", async () => {
    let chat = "";
    const listening = latch();
    const release = latch();
    const closed = latch();
    const r = await rig(
      async (_ctx, call) => {
        if (r.calls.length === 1) {
          const inbox = call.params.inbox as Inbox | undefined;
          if (inbox === undefined) throw new Error("the harness was given no inbox");
          const stop = inbox.listen(() => undefined);
          listening.open();
          await release.promise;
          stop();
          closed.open();
          return reply("first answer");
        }
        return reply("second answer");
      },
      undefined,
      "fake",
      "fake",
      [],
      { takesMessagesMidRun: true },
    );
    chat = await r.chat();
    await r.say(chat, "first");

    const round = r.round(chat);
    await listening.promise;
    release.open();
    await closed.promise;
    await r.say(chat, "late");
    const first = await round;
    expect(first.result).toBe("more");
    expect(assistantReplyTo(r, chat)[0]).toHaveLength(1);

    const second = await r.round(chat);
    expect(second.result).toBe("done");
    expect(r.calls.map((call) => call.params.prompt)).toEqual(["first", "late"]);
    expect(unanswered(allMessages(r.store, chat))).toEqual([]);
  });

  test("a harness without the capability queues the message, even when it is named claude", async () => {
    let chat = "";
    const r = await rig(
      async () => {
        if (r.calls.length === 1) {
          await r.say(chat, "second");
          return reply("first answer");
        }
        return reply("second answer");
      },
      undefined,
      "claude",
    );
    chat = await r.chat();
    await r.say(chat, "first");

    const one = await r.round(chat);
    expect(one.result).toBe("more");
    expect(r.calls[0]?.params.inbox).toBeUndefined();
    const two = await r.round(chat);
    expect(two.result).toBe("done");
    expect(r.calls.map((call) => call.params.prompt)).toEqual(["first", "second"]);
    expect(unanswered(allMessages(r.store, chat))).toEqual([]);
  });

  test("a message with an image waits for the next round, where the image reaches the agent as an image", async () => {
    let chat = "";
    const entered = latch();
    const finish = latch();
    const r = await rig(
      async () => {
        if (r.calls.length === 1) {
          entered.open();
          await finish.promise;
          return reply("first answer");
        }
        return reply("second answer");
      },
      undefined,
      "claude",
      "claude",
      [],
      { takesMessagesMidRun: true },
    );
    chat = await r.chat();
    const photo = stored(r, chat, "photo.png", "12345");
    await r.say(chat, "first");

    const round = r.round(chat);
    await entered.promise;
    await r.say(chat, "look", [{ path: photo, name: "photo.png", type: "image/png", size: 5 }]);
    finish.open();
    const first = await round;
    expect(first.result).toBe("more");
    expect(r.calls).toHaveLength(1);

    const second = await r.round(chat);
    expect(second.result).toBe("done");
    expect(r.calls[1]?.params.images).toEqual([{ path: photo, mediaType: "image/png" }]);
    expect(String(r.calls[1]?.params.prompt)).toStartWith("look");
  });
});
