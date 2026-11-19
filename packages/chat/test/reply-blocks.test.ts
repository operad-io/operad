import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SectionContent, StepContext, ViewContext } from "@operad-io/engine";
import {
  allMessages,
  chatViews,
  type ReplyBlock,
  type ReplyItem,
  type ReplyToolItem,
} from "../src/index.ts";
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

async function write(ctx: StepContext, line: Record<string, unknown>): Promise<void> {
  const stamped = JSON.stringify(line);
  await ctx.logger.write(stamped);
  ctx.receiver?.(stamped);
}

async function view(
  r: Rig,
  chat: string,
  options: { readonly running?: boolean } = {},
): Promise<SectionContent> {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
    secrets: {
      names: async () => [],
      get: async () => undefined,
    },
    runTimes: async () => ({ startedAt: 1, endedAt: options.running === true ? null : 2, segments: [] }),
  } as unknown as ViewContext;
  return chatViews.load(ctx, object, "transcript", {});
}

function replies(content: SectionContent): readonly ReplyBlock[] {
  const data = content.data as { readonly replies?: readonly ReplyBlock[] } | undefined;
  return data?.replies ?? [];
}

function items(replyBlock: ReplyBlock): readonly ReplyItem[] {
  return replyBlock.process.flatMap((group) => group.items);
}

function tool(replyBlock: ReplyBlock, name: string): ReplyToolItem {
  const found = items(replyBlock).find((item): item is ReplyToolItem => item.kind === "tool" && item.name === name);
  if (found === undefined) throw new Error(`the reply has no ${name} call`);
  return found;
}

describe("a reply's structured form", () => {
  test("live: the input and the process are there, and the stored read adds the answer and the reply's duration", async () => {
    let chat = "";
    let during: SectionContent | undefined;
    const r = await rig(async (ctx) => {
      const at = Date.UTC(2026, 10, 12, 9, 5, 7);
      await write(ctx, { type: "thinking_end", text: "look first", receivedAt: at - 2 });
      await write(ctx, { type: "text_end", text: "I will look.", receivedAt: at - 1 });
      await write(ctx, { type: "tool_execution_start", toolCallId: "t1", toolName: "Bash", input: "ls", at });
      await write(ctx, { type: "tool_output", toolCallId: "t1", text: "a.txt\n" });
      await write(ctx, { type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false, durationMs: 1_500 });
      during = await view(r, chat, { running: true });
      return {
        result: "done",
        data: {
          finalMessage: "final answer",
          sessionId: "s-1",
          timings: { startToReadyMs: 10, readyToFirstMs: 20, totalMs: 1_234 },
        },
      };
    });
    chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);
    if (during === undefined) throw new Error("the live view was not read");

    const live = replies(during)[0];
    if (live === undefined) throw new Error("the live reply is not structured");
    expect(live.runId).toBe("run-1");
    expect(live.input.map((message) => message.text)).toEqual(["hello"]);
    expect(live.answer).toBeUndefined();
    expect(live.durationMs).toBeUndefined();
    expect(live.process).toHaveLength(1);
    expect(live.process[0]?.categories).toEqual(["run"]);
    expect(items(live).map((item) => item.kind)).toEqual(["thinking", "text", "tool"]);
    expect(tool(live, "Bash")).toMatchObject({
      callId: "t1",
      name: "Bash",
      input: "ls",
      durationMs: 1_500,
      failed: false,
      result: "done",
      output: { text: "a.txt\n", lines: 1 },
    });

    const stored = replies(await view(r, chat))[0];
    if (stored === undefined) throw new Error("the stored reply is not structured");
    expect(stored.answer?.text).toBe("final answer");
    expect(stored.durationMs).toBe(1_234);
    expect(stored.process).toEqual(live.process);
  });

  test("a failed tool keeps its name, input, duration and failure, and a long output keeps its first lines, count and file", async () => {
    const output = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const r = await rig(async (ctx) => {
      await write(ctx, { type: "tool_execution_start", toolCallId: "r", toolName: "Read", input: "src/a.ts", at: 1_000 });
      await write(ctx, { type: "tool_execution_end", toolCallId: "r", toolName: "Read", isError: false, durationMs: 30 });
      await write(ctx, { type: "tool_execution_start", toolCallId: "w", toolName: "Write", input: "src/a.ts", at: 1_100 });
      await write(ctx, { type: "tool_execution_end", toolCallId: "w", toolName: "Write", isError: false, durationMs: 40 });
      await write(ctx, { type: "tool_execution_start", toolCallId: "b", toolName: "Bash", input: "make test", at: 1_200 });
      await write(ctx, { type: "tool_output", toolCallId: "b", text: output });
      await write(ctx, {
        type: "tool_execution_end",
        toolCallId: "b",
        toolName: "Bash",
        isError: true,
        durationMs: 700,
        error: "boom\nmore",
      });
      await write(ctx, { type: "tool_execution_start", toolCallId: "g", toolName: "Grep", input: "needle", at: 1_300 });
      await write(ctx, { type: "tool_execution_end", toolCallId: "g", toolName: "Grep", isError: false, durationMs: 50 });
      await write(ctx, { type: "tool_execution_start", toolCallId: "x", toolName: "mcp__notes__list", input: "notes", at: 1_400 });
      await write(ctx, { type: "tool_execution_end", toolCallId: "x", toolName: "mcp__notes__list", isError: false, durationMs: 60 });
      return reply("done");
    });
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    const block = replies(await view(r, chat))[0];
    if (block === undefined) throw new Error("the reply is not structured");
    expect(block.process).toHaveLength(1);
    expect(block.process[0]?.categories).toEqual(["read", "edit", "run", "search", "other"]);

    const failed = tool(block, "Bash");
    expect(failed).toMatchObject({
      callId: "b",
      name: "Bash",
      input: "make test",
      durationMs: 700,
      failed: true,
      result: "failed",
    });
    expect(failed.output.text.startsWith("line 1\nline 2")).toBe(true);
    expect(failed.output.text).not.toContain("line 1000");
    expect(failed.output.lines).toBeGreaterThan(16);
    expect(failed.output.path).toBeDefined();
    expect(failed.output.truncated).toBe(true);
    if (failed.output.path === undefined) throw new Error("the long output has no file");
    expect(await Bun.file(failed.output.path).text()).toBe(output);
  });

  test("a reply with a mid-run message keeps both in time order and splits its process there", async () => {
    let chat = "";
    let during: SectionContent | undefined;
    const r = await rig(
      async (ctx, call) => {
        if (r.calls.length !== 1) return reply("again");
        const inbox = nextInboxMessage(call.params);
        const before = Date.now() - 2_000;
        await write(ctx, { type: "thinking_end", text: "before thought", receivedAt: before - 1 });
        await write(ctx, { type: "tool_execution_start", toolCallId: "t1", toolName: "Bash", input: "echo before", at: before });
        await write(ctx, { type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false, durationMs: 1 });
        await r.say(chat, "second question");
        await inbox;
        const after = Date.now();
        await write(ctx, { type: "thinking_end", text: "after thought", receivedAt: after });
        await write(ctx, { type: "tool_execution_start", toolCallId: "t2", toolName: "Read", input: "after.ts", at: after });
        await write(ctx, { type: "tool_execution_end", toolCallId: "t2", toolName: "Read", isError: false, durationMs: 1 });
        during = await view(r, chat, { running: true });
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
    if (during === undefined) throw new Error("the live view was not read");

    const check = (block: ReplyBlock | undefined, live: boolean): void => {
      if (block === undefined) throw new Error("the reply is not structured");
      expect(block.input.map((message) => message.text)).toEqual(["first question", "second question"]);
      const times = block.input.map((message) => message.at);
      expect(times[0]).toBeLessThan(times[1] ?? 0);
      expect(block.process).toHaveLength(2);
      expect(block.process[0]?.categories).toEqual(["run"]);
      expect(block.process[0]?.items.map((item) => item.kind)).toEqual(["thinking", "tool"]);
      expect(block.process[1]?.categories).toEqual(["read"]);
      expect(block.process[1]?.items.map((item) => item.kind)).toEqual(["thinking", "tool"]);
      expect(block.answer === undefined).toBe(live);
    };
    check(replies(during)[0], true);
    check(replies(await view(r, chat))[0], false);

    const stored = replies(await view(r, chat))[0];
    expect(stored?.answer?.text).toBe("final answer");
    expect(allMessages(r.store, chat).map((message) => message.role)).toEqual(["user", "user", "assistant"]);
  });
});
