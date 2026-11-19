import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SectionContent, StepContext, ViewContext } from "@operad-io/engine";
import { allEntries, allMessages, chatViews, ENTRY_FACT, RUN_FACT } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

interface Inbox {
  listen(handler: (text: string) => boolean | void): () => void;
}

function nextInboxMessage(params: Record<string, unknown>): Promise<string> {
  const inbox = params.inbox as Inbox | undefined;
  if (inbox === undefined) throw new Error("the harness was given no inbox");
  return new Promise<string>((resolve) => inbox.listen((text) => resolve(text)));
}

/** One line as the harness writes it to the log and hands it to the fold. */
async function write(ctx: StepContext, line: Record<string, unknown>): Promise<void> {
  const stamped = JSON.stringify(line);
  await ctx.logger.write(stamped);
  ctx.receiver?.(stamped);
}

async function view(
  r: Rig,
  chat: string,
  options: { readonly after?: string; readonly running?: boolean } = {},
): Promise<SectionContent> {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
    runTimes: async () => ({ startedAt: 1, endedAt: options.running === false ? 2 : null, segments: [] }),
  } as unknown as ViewContext;
  return chatViews.load(ctx, object, "transcript", options.after === undefined ? {} : { after: options.after });
}

function position(markdown: string, text: string): number {
  const at = markdown.indexOf(text);
  if (at < 0) throw new Error(`the transcript does not contain ${text}`);
  return at;
}

function inOrder(markdown: string, parts: readonly string[]): void {
  const positions = parts.map((part) => position(markdown, part));
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
}

describe("the transcript places a message sent during a reply by its time", () => {
  test("stored: the reply's items before the message stay above it, and those after stay below it", async () => {
    let chat = "";
    let before = 0;
    let mid = 0;
    let after = 0;
    const r = await rig(
      async (ctx, call) => {
        if (r.calls.length !== 1) return reply("again");
        const inbox = nextInboxMessage(call.params);
        before = Date.now() - 2_000;
        await write(ctx, { type: "thinking_end", text: "before thought", receivedAt: before - 1 });
        await write(ctx, { type: "text_end", text: "before words", receivedAt: before });
        await write(ctx, {
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "Bash",
          input: "echo before",
          at: before + 1,
        });
        await write(ctx, {
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "Bash",
          isError: false,
          durationMs: 1,
          receivedAt: before + 2,
        });
        const id = await r.say(chat, "second question");
        const sent = allMessages(r.store, chat).find((message) => message.id === id);
        if (sent === undefined) throw new Error("the mid-run message was not recorded");
        mid = sent.at;
        await inbox;
        after = Date.now();
        await write(ctx, { type: "thinking_end", text: "after thought", receivedAt: after });
        await write(ctx, { type: "text_end", text: "after words", receivedAt: after });
        await write(ctx, {
          type: "tool_execution_start",
          toolCallId: "t2",
          toolName: "Read",
          input: "after.ts",
          at: after,
        });
        await write(ctx, {
          type: "tool_execution_end",
          toolCallId: "t2",
          toolName: "Read",
          isError: false,
          durationMs: 1,
          receivedAt: after,
        });
        return reply("final answer");
      },
      undefined,
      "fake",
      "fake",
      [],
      { takesMessagesMidRun: true },
    );
    chat = await r.chat();
    await r.say(chat, "first question");
    await r.round(chat);

    const entries = allEntries(r.store, chat);
    expect(entries.filter((entry) => entry.kind === "text").map((entry) => entry.startedAt)).toEqual([before, after]);
    expect(entries.filter((entry) => entry.kind === "thinking").map((entry) => entry.startedAt)).toEqual([before - 1, after]);
    expect(entries.filter((entry) => entry.kind === "tool").map((entry) => entry.startedAt)).toEqual([before + 1, after]);

    const stored = await view(r, chat, { running: false });
    expect(stored.markdown).toContain("second question");
    inOrder(stored.markdown, ["first question", "> before thought", "before words", "tool Bash <1s `echo before`", "second question", "> after thought", "after words", "tool Read <1s `after.ts`", "final answer"]);
    expect(mid).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(mid);
  });

  test("live: the tail puts the message among the reply's lines, and the stored read after the run keeps that order", async () => {
    let chat = "";
    let live: SectionContent | undefined;
    let holder: Rig | undefined;
    const r = await rig(
      async (ctx, call) => {
        if (r.calls.length !== 1) return reply("again");
        const inbox = nextInboxMessage(call.params);
        const before = Date.now() - 2_000;
        await write(ctx, { type: "thinking_end", text: "before thought", receivedAt: before - 1 });
        await write(ctx, { type: "text_end", text: "before words", receivedAt: before });
        await write(ctx, {
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "Bash",
          input: "echo before",
          at: before + 1,
        });
        await write(ctx, {
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "Bash",
          isError: false,
          durationMs: 1,
          receivedAt: before + 2,
        });
        await r.say(chat, "second question");
        await inbox;
        const after = Date.now();
        await write(ctx, { type: "thinking_end", text: "after thought", receivedAt: after });
        await write(ctx, { type: "text_end", text: "after words", receivedAt: after });
        await write(ctx, {
          type: "tool_execution_start",
          toolCallId: "t2",
          toolName: "Read",
          input: "after.ts",
          at: after,
        });
        await write(ctx, {
          type: "tool_execution_end",
          toolCallId: "t2",
          toolName: "Read",
          isError: false,
          durationMs: 1,
          receivedAt: after,
        });
        if (holder === undefined) throw new Error("the rig was not ready");
        live = await view(holder, chat, { running: true });
        return reply("final answer");
      },
      undefined,
      "fake",
      "fake",
      [],
      { takesMessagesMidRun: true },
    );
    holder = r;
    chat = await r.chat();
    await r.say(chat, "first question");
    await r.round(chat);
    if (live === undefined) throw new Error("the live view was not read");

    const liveText = `${live.markdown}\n\n${live.tail ?? ""}`;
    inOrder(liveText, ["first question", "> before thought", "before words", "tool Bash <1s `echo before`", "second question", "> after thought", "after words", "tool Read <1s `after.ts`"]);
    expect(live.tail).not.toContain("final answer");

    const stored = await view(r, chat, { running: false });
    inOrder(stored.markdown, ["first question", "> before thought", "before words", "tool Bash <1s `echo before`", "second question", "> after thought", "after words", "tool Read <1s `after.ts`", "final answer"]);

    // A client that was live reads on from its mark and sees the same lines as
    // finished content, with no message left above the whole reply.
    const switched = await view(r, chat, { after: live.mark ?? "", running: false });
    expect(switched.tail).toBeUndefined();
    inOrder(switched.markdown, ["before words", "tool Bash <1s `echo before`", "second question", "after words", "tool Read <1s `after.ts`", "final answer"]);
  });

  test("stored: a message the run did not take stays out of the reply's items and waits below it", async () => {
    let chat = "";
    const r = await rig(async (ctx) => {
      if (r.calls.length !== 1) return reply("second answer");
      const before = Date.now() - 2_000;
      await write(ctx, { type: "thinking_end", text: "before thought", receivedAt: before - 1 });
      await write(ctx, { type: "text_end", text: "before words", receivedAt: before });
      await write(ctx, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "Bash",
        input: "echo before",
        at: before + 1,
      });
      await write(ctx, {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "Bash",
        isError: false,
        durationMs: 1,
        receivedAt: before + 2,
      });
      await r.say(chat, "second question");
      const after = Date.now();
      await write(ctx, { type: "thinking_end", text: "after thought", receivedAt: after });
      await write(ctx, { type: "text_end", text: "after words", receivedAt: after });
      await write(ctx, {
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "Read",
        input: "after.ts",
        at: after,
      });
      await write(ctx, {
        type: "tool_execution_end",
        toolCallId: "t2",
        toolName: "Read",
        isError: false,
        durationMs: 1,
        receivedAt: after,
      });
      return reply("first answer");
    });
    chat = await r.chat();
    await r.say(chat, "first question");

    expect((await r.round(chat)).result).toBe("more");
    expect(r.calls[0]?.params.inbox).toBeUndefined();
    expect((await r.round(chat)).result).toBe("done");
    expect(r.calls.map((call) => call.params.prompt)).toEqual(["first question", "second question"]);

    const stored = await view(r, chat, { running: false });
    inOrder(stored.markdown, [
      "first question",
      "> before thought",
      "before words",
      "tool Bash <1s `echo before`",
      "> after thought",
      "after words",
      "tool Read <1s `after.ts`",
      "first answer",
      "second question",
      "second answer",
    ]);
    expect(stored.markdown.split("second question")).toHaveLength(2);
  });

  test("an older store whose entries carry no time keeps the order it recorded", async () => {
    const r = await rig(() => reply("plain answer"));
    const chat = await r.chat();
    await r.say(chat, "first question");
    await r.store.append({ type: RUN_FACT, object: { type: "chat", id: chat }, cause: "test", data: { runId: "run-old" } });
    await r.say(chat, "during words");
    await r.store.append({
      type: ENTRY_FACT,
      object: { type: "chat", id: chat },
      cause: "test",
      data: { runId: "run-old", kind: "text", text: "old text item" },
    });
    const shown = await view(r, chat, { running: false });
    inOrder(shown.markdown, ["first question", "during words", "old text item"]);
    expect(allEntries(r.store, chat)[0]?.startedAt).toBeUndefined();
  });
});
