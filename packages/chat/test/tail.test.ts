import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SectionContent, StepContext, ViewContext } from "@operad-io/engine";
import { agentLogPath, chatViews, foldLogTail, RUN_FACT } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

/** Whether the run the view asks about still runs; the test decides. */
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
    secrets: {
      names: async () => ["token"],
      get: async () => ({ reveal: () => "s3cr3t-value" }),
    },
    runTimes: async () => ({ startedAt: 1, endedAt: options.running === false ? 2 : null, segments: [] }),
  } as unknown as ViewContext;
  return chatViews.load(ctx, object, "transcript", options.after === undefined ? {} : { after: options.after });
}

async function write(ctx: StepContext, ...lines: Record<string, unknown>[]): Promise<void> {
  // The harness gives each line to the log and to the receiver that records entries.
  for (const line of lines) {
    await ctx.logger.write(JSON.stringify(line));
    ctx.receiver?.(JSON.stringify(line));
  }
}

const start = (callId: string, toolName: string, input: string, at: number): Record<string, unknown> => ({
  type: "tool_execution_start",
  toolCallId: callId,
  toolName,
  at,
  input,
});

/** Runs one round whose agent writes `lines`, and gives what the view said while it ran. */
async function whileRunning(
  lines: Record<string, unknown>[],
  harness?: string,
): Promise<{ r: Rig; chat: string; during: SectionContent; after: SectionContent }> {
  let during: SectionContent | undefined;
  let chatId = "";
  let holder: Rig | undefined;
  const r = await rig(async (ctx) => {
    await write(ctx, ...lines);
    if (holder !== undefined) during = await view(holder, chatId);
    return reply("final answer");
  }, undefined, harness);
  holder = r;
  const chat = await r.chat();
  chatId = chat;
  await r.say(chat, "go");
  await r.round(chat);
  if (during === undefined) throw new Error("the agent did not run");
  return { r, chat, during, after: await view(r, chat, { running: false }) };
}

describe("chat transcript: after, mark and tail", () => {
  test("a read with after returns only what was recorded later, and says so", async () => {
    const r = await rig(() => reply("first answer"));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    const first = await view(r, chat, { running: false });
    expect(first.markdown).toContain("first answer");
    expect(first.delta).toBeUndefined();
    await r.say(chat, "two");
    const later = await view(r, chat, { after: first.mark ?? "", running: false });
    expect(later.delta).toBe(true);
    expect(later.markdown).toContain("two");
    expect(later.markdown).not.toContain("one");
    expect(later.markdown).not.toContain("first answer");
    expect(later.markdown).not.toContain("Agent:");
  });

  test("the mark moves with what was recorded and holds when nothing was", async () => {
    const r = await rig(() => reply("an answer"));
    const chat = await r.chat();
    await r.say(chat, "one");
    const a = await view(r, chat, { running: false });
    const same = await view(r, chat, { after: a.mark ?? "", running: false });
    expect(same.markdown).toBe("");
    expect(same.mark).toBe(a.mark);
    await r.round(chat);
    const b = await view(r, chat, { after: a.mark ?? "", running: false });
    expect(Number(b.mark)).toBeGreaterThan(Number(a.mark));
    expect(b.markdown).toContain("an answer");
    const full = await view(r, chat, { running: false });
    expect(full.mark).toBe(b.mark);
  });

  test("text being written is in the tail and not in the markdown", async () => {
    const { during, after } = await whileRunning([
      { type: "text_delta", text: "I am " },
      { type: "text_delta", text: "writing" },
    ]);
    expect(during.tail).toBe("**Operad Bot:** I am writing");
    expect(during.markdown).not.toContain("I am writing");
    expect(after.tail).toBeUndefined();
  });

  test("thinking being written is a block quote with no label", async () => {
    const { during } = await whileRunning([{ type: "thinking_delta", text: "hmm\nwell" }]);
    expect(during.tail).toBe("> hmm\n> well");
  });

  test("a tool call that started and did not end is one line with its start", async () => {
    const { during } = await whileRunning([
      start("t1", "Bash", "ls -la", Date.UTC(2026, 10, 12, 9, 5, 7)),
      start("t2", "Read", "a.ts", Date.UTC(2026, 10, 12, 9, 5, 8)),
      { type: "tool_execution_end", toolCallId: "t2", toolName: "Read", isError: false, durationMs: 5 },
    ]);
    expect(during.tail).toBe("tool Bash since 09:05:07 `ls -la`");
  });

  test("there is no tail when nothing runs, and none without a log", async () => {
    const { r, chat } = await whileRunning([{ type: "text_delta", text: "partial" }]);
    expect((await view(r, chat, { running: false })).tail).toBeUndefined();
    const quiet = await rig(() => reply("x"));
    const idle = await quiet.chat();
    await quiet.say(idle, "hi");
    expect((await view(quiet, idle)).tail).toBeUndefined();
    // A run recorded whose log does not exist yet.
    await quiet.store.append({ type: RUN_FACT, object: { type: "chat", id: idle }, cause: "test", data: { runId: "run-9" } });
    expect((await view(quiet, idle)).tail).toBeUndefined();
  });

  test("a finished entry is never in both the markdown and the tail", async () => {
    const { r, chat } = await whileRunning([
      { type: "text_end", text: "done thought" },
      start("t1", "Bash", "ls", 1_000),
      { type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false, durationMs: 1 },
      { type: "text_delta", text: "still writing" },
    ]);
    // Between rounds the run still runs: the facts hold the first two, the log still holds the rest.
    const between = await view(r, chat);
    expect(between.markdown).toContain("done thought");
    expect(between.tail ?? "").not.toContain("done thought");
    expect(between.tail ?? "").not.toContain("tool Bash");
    // An open call that the facts already hold as finished is not repeated.
    await r.store.append({
      type: "chat.entry",
      object: { type: "chat", id: chat },
      cause: "test",
      data: { runId: "run-1", kind: "tool", callId: "t9", toolName: "Bash", result: "done", input: "pwd", startedAt: 1, durationMs: 1 },
    });
    writeFileSync(agentLogPath(r.store.root, "fake", "run-1"), `${JSON.stringify(start("t9", "Bash", "pwd", 1))}\n`, { flag: "a" });
    expect((await view(r, chat)).tail ?? "").not.toContain("pwd");
    // Text the facts already hold, as the reply, is not repeated either.
    writeFileSync(agentLogPath(r.store.root, "fake", "run-1"), `${JSON.stringify({ type: "text_delta", text: "final answer" })}\n`, { flag: "a" });
    expect((await view(r, chat)).tail ?? "").not.toContain("final answer");
  });

  test("a secret is masked in the tail", async () => {
    const { during } = await whileRunning([
      start("t1", "Bash", "echo s3cr3t-value", 1_000),
      { type: "text_delta", text: "the key is s3cr3t-value" },
    ]);
    expect(during.tail).not.toContain("s3cr3t-value");
    expect(during.tail).toContain("the key is ***");
    expect(during.tail).toContain("echo ***");
  });

  test("a radian chat's tail has the tool lines only", async () => {
    const { during } = await whileRunning(
      [
        start("t1", "Bash", "ls", 1_000),
        { type: "text_delta", text: "quiet words" },
        { type: "thinking_delta", text: "quiet thought" },
      ],
      "radian",
    );
    expect(during.tail).toContain("tool Bash");
    expect(during.tail).not.toContain("quiet");
  });

  const logIn = (r: Rig, run: string): string => {
    const path = agentLogPath(r.store.root, "fake", run);
    mkdirSync(join(path, ".."), { recursive: true });
    return path;
  };
  const text = (lines: readonly Record<string, unknown>[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  const big = "y".repeat(1024);
  const ids = (path: string): string[] | undefined => foldLogTail(path)?.state.calls.map((call) => call.callId);

  test("a text, thinking or tool call that began long ago is still whole", async () => {
    const r = await rig(() => reply("x"));
    const thinkingPath = logIn(r, "run-thinking");
    writeFileSync(
      thinkingPath,
      text([
        { type: "message_end", role: "assistant" },
        { type: "thinking_delta", text: "T-start " },
        ...Array.from({ length: 400 }, () => ({ type: "thinking_delta", text: big })),
      ]),
    );
    const thinking = foldLogTail(thinkingPath)?.state.thinking ?? "";
    expect(thinking.startsWith("T-start ")).toBe(true);
    expect(thinking.length).toBe(8 + 400 * 1024);

    const toolPath = logIn(r, "run-tool");
    writeFileSync(
      toolPath,
      text([
        start("long", "Bash", "make", 1_000),
        ...Array.from({ length: 400 }, () => ({ type: "tool_output", toolCallId: "long", text: big })),
        start("other", "Read", "a", 2_000),
        { type: "tool_execution_end", toolCallId: "other", toolName: "Read", isError: false, durationMs: 1 },
      ]),
    );
    expect(ids(toolPath)).toEqual(["long"]);
  });

  test("a silent call stays in the tail while a parallel call fills the log", async () => {
    const r = await rig(() => reply("x"));
    const path = logIn(r, "run-parallel");
    writeFileSync(
      path,
      text([
        { type: "message_end", role: "assistant" },
        start("A", "Bash", "sleep 999", 1_000),
        start("B", "Bash", "make", 1_001),
        ...Array.from({ length: 400 }, () => ({ type: "tool_output", toolCallId: "B", text: big })),
        { type: "tool_execution_end", toolCallId: "B", toolName: "Bash", isError: false, durationMs: 9 },
      ]),
    );
    expect(ids(path)).toEqual(["A"]);
  });

  test("in a log with no message ends a finished call does not hide a running one", async () => {
    const r = await rig(() => reply("x"));
    const path = logIn(r, "run-radian");
    writeFileSync(
      path,
      text([
        start("A", "Bash", "sleep 999", 1_000),
        start("B", "Bash", "make", 1_001),
        ...Array.from({ length: 400 }, () => ({ type: "journal", note: big })),
        { type: "tool_execution_end", toolCallId: "B", toolName: "Bash", isError: false, durationMs: 9 },
      ]),
    );
    expect(ids(path)).toEqual(["A"]);
  });

  test("reading the tail of a log of 50 000 lines reads a bounded number of bytes", async () => {
    const r = await rig(() => reply("x"));
    const path = logIn(r, "run-big");
    // A radian-shaped log: many complete calls and no message end.
    const done: Record<string, unknown>[] = [];
    for (let index = 0; index < 25_000; index += 1) {
      done.push(start(`c${index}`, "Bash", `echo ${index}`, index));
      done.push({ type: "tool_execution_end", toolCallId: `c${index}`, toolName: "Bash", isError: false, durationMs: 1 });
    }
    writeFileSync(path, text([...done, start("open", "Bash", "sleep 9", 5_000)]));
    const first = foldLogTail(path);
    expect(first?.bytesRead).toBe(statSync(path).size);
    expect(ids(path)).toEqual(["open"]);
    // The second read takes nothing; a read after an append takes only the append.
    expect(foldLogTail(path)?.bytesRead).toBe(0);
    const added = text([{ type: "text_delta", text: "now writing" }]);
    appendFileSync(path, added);
    const next = foldLogTail(path);
    expect(next?.bytesRead).toBe(Buffer.byteLength(added));
    expect(next?.state.text).toBe("now writing");
    expect(next?.state.calls.map((call) => call.callId)).toEqual(["open"]);
  });

  test("a log that was cut short or replaced is read again from its start", async () => {
    const r = await rig(() => reply("x"));
    const path = logIn(r, "run-replaced");
    writeFileSync(path, text([start("old", "Bash", "a long command so the file is long", 1_000), { type: "text_delta", text: "stale words" }]));
    expect(ids(path)).toEqual(["old"]);
    writeFileSync(path, text([start("new", "Bash", "b", 2_000)]));
    const read = foldLogTail(path);
    expect(read?.state.calls.map((call) => call.callId)).toEqual(["new"]);
    expect(read?.state.text).toBe("");
    expect(read?.bytesRead).toBe(statSync(path).size);
  });

  test("a line split across two appends is folded once, whole", async () => {
    const r = await rig(() => reply("x"));
    const path = logIn(r, "run-split");
    const line = `${JSON.stringify({ type: "text_delta", text: "whole" })}\n`;
    writeFileSync(path, line + line.slice(0, 10));
    expect(foldLogTail(path)?.state.text).toBe("whole");
    appendFileSync(path, line.slice(10));
    expect(foldLogTail(path)?.state.text).toBe("wholewhole");
    expect(foldLogTail(path)?.state.text).toBe("wholewhole");
  });
});
