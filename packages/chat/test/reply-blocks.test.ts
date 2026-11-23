import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SectionContent, StepContext, ViewContext } from "@operad-io/engine";
import {
  ENTRY_FACT,
  MESSAGE_FACT,
  allMessages,
  chatRef,
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
  options: {
    readonly running?: boolean;
    readonly cursor?: string;
    readonly after?: string;
    readonly full?: boolean;
    readonly sectionCapBytes?: number;
  } = {},
): Promise<SectionContent> {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
    sectionCapBytes: options.sectionCapBytes ?? 256 * 1024,
    secrets: {
      names: async () => [],
      get: async () => undefined,
      values: async () => [],
    },
    runTimes: async () => ({ startedAt: 1, endedAt: options.running === true ? null : 2, segments: [] }),
  } as unknown as ViewContext;
  return chatViews.load(ctx, object, "transcript", {
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.after === undefined ? {} : { after: options.after }),
    ...(options.full === true ? { full: true } : {}),
  });
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

/** A chat with `count` finished replies, each with `tools` calls and an optional output. */
async function chatWithReplies(
  count: number,
  tools: number,
  outputFor?: (round: number, tool: number) => string | undefined,
): Promise<{ readonly r: Rig; readonly chat: string }> {
  const r = await rig(async (ctx) => {
    const round = r.calls.length;
    for (let index = 0; index < tools; index += 1) {
      const callId = `r${round}-${index}`;
      const toolName = index % 2 === 0 ? "Bash" : "Read";
      await write(ctx, {
        type: "tool_execution_start",
        toolCallId: callId,
        toolName,
        input: `call ${round}-${index}`,
        at: round * 100 + index,
      });
      const output = outputFor?.(round, index);
      if (output !== undefined) await write(ctx, { type: "tool_output", toolCallId: callId, text: output });
      await write(ctx, {
        type: "tool_execution_end",
        toolCallId: callId,
        toolName,
        isError: false,
        durationMs: 1,
      });
    }
    return reply(`answer ${round}`);
  });
  const chat = await r.chat();
  for (let index = 1; index <= count; index += 1) {
    await r.say(chat, `question ${index}`);
    await r.round(chat);
  }
  return { r, chat };
}

describe("a reply's structured form", () => {
  test("live: the input and the process are there, and the stored read adds the answer and the reply's duration", async () => {
    let chat = "";
    let during: SectionContent | undefined;
    let afterMark: SectionContent | undefined;
    let emptyMark = "";
    const r = await rig(async (ctx) => {
      const at = Date.UTC(2026, 10, 12, 9, 5, 7);
      await write(ctx, { type: "thinking_end", text: "look first", receivedAt: at - 2 });
      await write(ctx, { type: "text_end", text: "I will look.", receivedAt: at - 1 });
      await write(ctx, { type: "tool_execution_start", toolCallId: "t1", toolName: "Bash", input: "ls", at });
      await write(ctx, { type: "tool_output", toolCallId: "t1", text: "a.txt\n" });
      await write(ctx, { type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false, durationMs: 1_500 });
      during = await view(r, chat, { running: true });
      afterMark = await view(r, chat, { running: true, after: emptyMark });
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
    emptyMark = (await view(r, chat)).mark ?? "";
    await r.say(chat, "hello");
    await r.round(chat);
    if (during === undefined) throw new Error("the live view was not read");
    if (afterMark === undefined) throw new Error("the after read was not made");

    const live = replies(during)[0];
    if (live === undefined) throw new Error("the live reply is not structured");
    expect(afterMark.markdown).toContain("hello");
    expect(afterMark.markdown).not.toContain("final answer");
    expect(replies(afterMark).map((reply) => reply.runId)).toEqual(["run-1"]);
    expect(replies(afterMark)[0]?.answer).toBeUndefined();
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
    expect(failed.output.url).toBe(
      `/v1/attachments/chat/${chat}/tool-output/${block.runId}/b.txt`,
    );
    expect(failed.output.truncated).toBe(true);
    expect(failed.output).not.toHaveProperty("path");
    const stored = join(r.root, "home", "attachments", "chat", chat, "tool-output", block.runId, "b.txt");
    expect(await Bun.file(stored).text()).toBe(output);
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

  test("a stored tool entry without a call id or name stays as a tool", async () => {
    let live: SectionContent | undefined;
    let chat = "";
    let holder: Rig | undefined;
    const r = await rig(async (ctx) => {
      await ctx.facts.append({
        type: ENTRY_FACT,
        object: chatRef(chat),
        cause: "test",
        data: { runId: ctx.runId, kind: "tool", result: "done", input: "ls", output: "a.txt\n" },
      });
      if (holder !== undefined) live = await view(holder, chat, { running: true });
      return reply("the answer");
    });
    holder = r;
    chat = await r.chat();
    await r.say(chat, "go");
    await r.round(chat);
    if (live === undefined) throw new Error("the reply did not run");
    expect(live.markdown).toContain("tool `ls`");
    const call = replies(live).flatMap(items).find((item): item is ReplyToolItem => item.kind === "tool");
    expect(call).toMatchObject({ callId: "", name: "tool", input: "ls" });
  });

  test("the cap shortens the thinking, text and answer of a reply too", async () => {
    const long = "z".repeat(20_000);
    const r = await rig(async (ctx) => {
      await write(ctx, { type: "thinking_end", text: long });
      await write(ctx, { type: "text_end", text: long });
      return reply(long);
    });
    const chat = await r.chat();
    await r.say(chat, "go");
    await r.round(chat);
    const cap = 20_000;
    const page = await view(r, chat, { sectionCapBytes: cap });
    expect(Buffer.byteLength(JSON.stringify(page.data), "utf8")).toBeLessThanOrEqual(cap);
  });

  test("the cap shortens a tool's input when its output is already empty", async () => {
    const long = "z".repeat(10_000);
    const r = await rig(async (ctx) => {
      for (let index = 0; index < 10; index += 1) {
        await write(ctx, { type: "tool_execution_start", toolCallId: `t${index}`, toolName: "Bash", input: long, at: index });
        await write(ctx, { type: "tool_execution_end", toolCallId: `t${index}`, toolName: "Bash", isError: false, durationMs: 1 });
      }
      return reply("the answer");
    });
    const chat = await r.chat();
    await r.say(chat, "go");
    await r.round(chat);
    const cap = 20_000;
    const page = await view(r, chat, { sectionCapBytes: cap });
    expect(Buffer.byteLength(JSON.stringify(page.data), "utf8")).toBeLessThanOrEqual(cap);
    const calls = replies(page).flatMap(items).filter((item): item is ReplyToolItem => item.kind === "tool");
    expect(calls.length).toBe(10);
    for (const call of calls) expect(call.input?.length ?? 0).toBeLessThan(long.length);
  });

  test("many replies: a page carries the replies on it, and an after read only what finished since its mark", async () => {
    const { r, chat } = await chatWithReplies(55, 1);
    const pages: SectionContent[] = [];
    let page = await view(r, chat);
    for (;;) {
      pages.push(page);
      if (page.next === undefined) break;
      page = await view(r, chat, { cursor: page.next });
    }
    expect(pages.length).toBeGreaterThan(1);

    const seen = new Set<string>();
    for (const one of pages) {
      const onPage = replies(one);
      expect(onPage.length).toBeGreaterThan(0);
      for (const reply of onPage) {
        expect(one.markdown).toContain(reply.answer?.text ?? "");
        expect(seen.has(reply.runId)).toBe(false);
        seen.add(reply.runId);
      }
    }
    expect(seen.size).toBe(55);

    const last = pages.at(-1);
    if (last === undefined) throw new Error("the chat has no last page");
    await r.say(chat, "question 56");
    await r.round(chat);
    const after = await view(r, chat, { after: last.mark ?? "" });
    expect(after.markdown).toContain("answer 56");
    expect(after.markdown).not.toContain("answer 55");
    expect(replies(after).map((reply) => reply.answer?.text)).toEqual(["answer 56"]);
  });

  test("many replies: a page's first reply keeps its own input, and an after read starts at its mark", async () => {
    const r = await rig(() => reply("unused"));
    const chat = await r.chat();
    for (let index = 1; index <= 60; index += 1) {
      await r.store.append({
        type: MESSAGE_FACT,
        object: chatRef(chat),
        cause: "test",
        data: {
          id: `u${index}`,
          role: "user",
          text: `question ${index}`,
          attachments: [],
          source: { kind: "cli", ref: null },
        },
      });
      await r.store.append({
        type: MESSAGE_FACT,
        object: chatRef(chat),
        cause: "test",
        data: {
          id: `a${index}`,
          role: "assistant",
          text: `answer ${index}`,
          runId: `run-${index}`,
          attachments: [],
          source: { kind: "fake", ref: null },
        },
      });
    }

    const first = await view(r, chat);
    if (first.next === undefined) throw new Error("the chat has only one page");
    const second = await view(r, chat, { cursor: first.next });
    const firstOnPage = replies(second)[0];
    expect(firstOnPage?.answer?.text).toBe("answer 26");
    expect(firstOnPage?.input.map((message) => message.text)).toEqual(["question 26"]);

    const after = await view(r, chat, { after: first.mark ?? "" });
    expect(replies(after)[0]?.answer?.text).toBe("answer 26");
    expect(replies(after)[0]?.input.map((message) => message.text)).toEqual(["question 26"]);
  });

  test("many replies: the cap cuts tool output text before it cuts the Markdown, keeping its lines", async () => {
    const output = Array.from({ length: 2_000 }, () => "x").join("\n");
    const { r, chat } = await chatWithReplies(20, 4, () => output);
    const cap = 60_000;
    const page = await view(r, chat, { sectionCapBytes: cap });
    expect(page.markdown).not.toContain("[Truncated.");
    const bytes =
      Buffer.byteLength(page.markdown, "utf8") +
      Buffer.byteLength(page.tail ?? "", "utf8") +
      Buffer.byteLength(JSON.stringify(page.data), "utf8");
    expect(bytes).toBeLessThanOrEqual(cap);

    const shown = replies(page).flatMap(items).filter((item): item is ReplyToolItem => item.kind === "tool");
    expect(shown).toHaveLength(80);
    for (const call of shown) {
      expect(call.output.text).toBe("");
      expect(call.output.truncated).toBe(true);
      expect(call.output.lines).toBe(2_000);
    }

    const full = await view(r, chat, { full: true });
    const fullTool = replies(full).flatMap(items).find((item): item is ReplyToolItem => item.kind === "tool");
    expect(fullTool?.output.text.length ?? 0).toBeGreaterThan(0);
  });
});

describe("a page over the size cap cuts the oldest replies first", () => {
  async function longChat(count: number): Promise<{ readonly r: Rig; readonly chat: string }> {
    const r = await rig(async () => reply(`${r.calls.length}: ${"word ".repeat(180)}end`));
    const chat = await r.chat();
    for (let index = 1; index <= count; index += 1) {
      await r.say(chat, `question ${index}`);
      await r.round(chat);
    }
    return { r, chat };
  }
  const bytesOf = (value: unknown): number => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");

  test("the newest replies stay whole, older ones are cut and marked, and the whole read has every text", async () => {
    const { r, chat } = await longChat(8);
    const whole = await view(r, chat, { full: true });
    const cap = bytesOf(whole.markdown) + bytesOf(whole.data) - 2_500;
    const page = await view(r, chat, { sectionCapBytes: cap });
    expect(bytesOf(page.markdown) + bytesOf(page.data)).toBeLessThanOrEqual(cap);

    const shown = replies(page);
    const all = replies(whole);
    expect(shown).toHaveLength(8);
    const last = shown.at(-1);
    expect(last?.answer?.text).toBe(all.at(-1)?.answer?.text ?? "x");
    expect(last?.answer?.cut).toBeUndefined();
    const first = shown[0];
    expect(first?.answer?.cut).toBe(true);
    expect((first?.answer?.text.length ?? 0) < (all[0]?.answer?.text.length ?? 0)).toBe(true);
    // Once a reply is whole, every newer one is whole.
    const cutFlags = shown.map((one) => one.answer?.cut === true);
    expect(cutFlags).toEqual([...cutFlags].sort((a, b) => Number(b) - Number(a)));
    for (const one of all) expect(one.answer?.cut).toBeUndefined();
    expect(all.every((one) => one.answer !== undefined && one.answer.text.endsWith("end"))).toBe(true);
  });
});
