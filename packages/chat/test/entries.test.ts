import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, ViewContext } from "@operad-io/engine";
import {
  allEntries,
  allMessages,
  chatViews,
  TOOL_OUTPUT_FACT_BYTES,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

function send(ctx: StepContext): (line: Record<string, unknown>) => void {
  return (line) => ctx.receiver?.(JSON.stringify(line));
}

function start(callId: string, toolName: string, input?: string, at = 1_000): Record<string, unknown> {
  return {
    type: "tool_execution_start",
    toolCallId: callId,
    toolName,
    at,
    ...(input === undefined ? {} : { input }),
  };
}

function end(
  callId: string,
  toolName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "tool_execution_end",
    toolCallId: callId,
    toolName,
    isError: false,
    durationMs: 100,
    ...extra,
  };
}

async function transcript(r: Rig, chat: string, cursor?: string): Promise<{ markdown: string; next?: string | undefined }> {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
  } as unknown as ViewContext;
  return chatViews.load(ctx, object, "transcript", cursor === undefined ? {} : { cursor });
}

describe("chat entries", () => {
  test("a run records its text, thinking and tool calls with its run id, and leaves the final reply as the message", async () => {
    const r = await rig((ctx) => {
      const line = send(ctx);
      line({ type: "thinking_delta", text: "weigh " });
      line({ type: "thinking_delta", text: "it" });
      line({ type: "thinking_end", text: "weigh it" });
      line({ type: "text_delta", text: "Let me " });
      line({ type: "text_delta", text: "look." });
      line({ type: "text_end", text: "Let me look." });
      line(start("t1", "Bash", "ls -la", 1_000));
      line({ type: "tool_output", toolCallId: "t1", text: "a.txt" });
      line(end("t1", "Bash", { durationMs: 1_500 }));
      line(start("t2", "Read", "src/a.ts", 2_000));
      line(end("t2", "Read", { durationMs: 20 }));
      line({ type: "text_delta", text: "All done." });
      line({ type: "text_end", text: "All done." });
      return reply("All done.");
    });
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    const entries = allEntries(r.store, chat);
    expect(entries.map((entry) => entry.kind)).toEqual(["thinking", "text", "tool", "tool"]);
    expect(entries[0]).toMatchObject({ runId: "run-1", kind: "thinking", text: "weigh it" });
    expect(entries[1]).toMatchObject({ runId: "run-1", kind: "text", text: "Let me look." });
    expect(entries[2]).toMatchObject({
      runId: "run-1",
      kind: "tool",
      callId: "t1",
      toolName: "Bash",
      input: "ls -la",
      result: "done",
      startedAt: 1_000,
      durationMs: 1_500,
      output: "a.txt",
      error: null,
    });
    expect(entries[3]).toMatchObject({ callId: "t2", toolName: "Read", durationMs: 20 });
    expect(entries.some((entry) => entry.kind !== "tool" && entry.text === "All done.")).toBe(false);
    expect(allMessages(r.store, chat).find((message) => message.role === "assistant")?.runId).toBe("run-1");
  });

  test("tool output longer than 4 KB keeps its head in the fact and the whole output in a file under the chat", async () => {
    const fourKb = 4 * 1024;
    expect(TOOL_OUTPUT_FACT_BYTES).toBe(fourKb);
    const output = `${"x".repeat(fourKb)}and more`;
    const r = await rig((ctx) => {
      const line = send(ctx);
      line(start("t1", "Bash", "make output"));
      line({ type: "tool_output", toolCallId: "t1", text: output });
      line(end("t1", "Bash"));
      return reply("done");
    });
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);
    const entry = allEntries(r.store, chat)[0];
    expect(new TextEncoder().encode(entry?.output ?? "").length).toBe(fourKb);
    expect(entry?.output?.endsWith("x")).toBe(true);
    const path = entry?.outputPath;
    if (path === undefined) throw new Error("no output file");
    expect(path.startsWith(join(r.root, "home"))).toBe(true);
    expect(path.startsWith(r.root)).toBe(true);
    expect(await Bun.file(path).text()).toBe(output);
  });

  test("secret values are masked before a text, thinking, tool or file fact is written", async () => {
    const secret = "s3cr3t-value";
    const output = `${secret} `.repeat(2_000);
    const r = await rig((ctx) => {
      const line = send(ctx);
      line({ type: "thinking_end", text: `think ${secret}` });
      line({ type: "text_end", text: `say ${secret}` });
      line(start("t1", "Bash", `echo ${secret}`));
      line({ type: "tool_output", toolCallId: "t1", text: output });
      line(end("t1", "Bash", { isError: true, error: `bad ${secret}\nmore` }));
      return reply(`final ${secret}`);
    });
    mkdirSync(join(r.root, "home", "secrets"), { recursive: true });
    writeFileSync(join(r.root, "home", "secrets", "chat.json"), JSON.stringify({ token: secret }));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    const entries = allEntries(r.store, chat);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(allMessages(r.store, chat))).not.toContain(secret);
    const tool = entries.find((entry) => entry.kind === "tool");
    expect(tool?.input).toBe("echo ***");
    expect(tool?.error).toBe("bad ***");
    const path = tool?.outputPath;
    if (path === undefined) throw new Error("no output file");
    expect(await Bun.file(path).text()).not.toContain(secret);
    const shown = await transcript(r, chat);
    expect(shown.markdown).not.toContain(secret);
  });

  test("a step that runs again does not record the same entries twice", async () => {
    let first = true;
    const r = await rig((ctx) => {
      const line = send(ctx);
      line({ type: "thinking_end", text: "same thought" });
      line({ type: "text_end", text: "same words" });
      line(start("t1", "Bash", "same command"));
      line(end("t1", "Bash"));
      if (first) {
        first = false;
        return { result: "failed", data: { message: "boom" } };
      }
      return reply("finished");
    });
    const chat = await r.chat();
    await r.say(chat, "hello");
    expect((await r.round(chat)).result).toBe("failed");
    const once = allEntries(r.store, chat);
    expect(once).toHaveLength(3);
    expect((await r.round(chat)).result).toBe("done");
    const twice = allEntries(r.store, chat);
    expect(twice).toHaveLength(once.length);
    expect(twice.filter((entry) => entry.kind === "tool")).toHaveLength(1);
    expect(twice.filter((entry) => entry.kind === "text" || entry.kind === "thinking")).toHaveLength(2);
  });

  test("increments with no end are not stored as entries", async () => {
    const r = await rig((ctx) => {
      const line = send(ctx);
      line({ type: "thinking_delta", text: "not finished" });
      line({ type: "text_delta", text: "not finished either" });
      return reply("the finished reply");
    });
    const chat = await r.chat();
    await r.say(chat, "go");
    await r.round(chat);
    expect(allEntries(r.store, chat)).toEqual([]);
    expect((await transcript(r, chat)).markdown).toContain("the finished reply");
  });

  test("a stopped run keeps its half-written reply", async () => {
    const r = await rig((ctx) => {
      send(ctx)({ type: "thinking_delta", text: "almost" });
      send(ctx)({ type: "text_delta", text: "Half a thought" });
      return { result: "interrupted", data: { reason: "cancelled", message: "stopped" } };
    });
    const chat = await r.chat();
    await r.say(chat, "go");
    expect((await r.round(chat)).result).toBe("interrupted");
    const entries = allEntries(r.store, chat);
    expect(entries.map((entry) => entry.kind)).toEqual(["stopped"]);
    expect(entries.find((entry) => entry.kind === "stopped")).toMatchObject({
      runId: "run-1",
      text: "Half a thought",
    });
    expect((await transcript(r, chat)).markdown).toContain("Half a thought");
    expect(allMessages(r.store, chat).filter((message) => message.role === "assistant")).toHaveLength(0);
  });

  test("the transcript shows done, failed, blocked and denied tool calls, and thinking as an unlabeled quote", async () => {
    const r = await rig((ctx) => {
      const line = send(ctx);
      line({ type: "thinking_end", text: "checking" });
      line(start("t1", "Bash", "make test"));
      line({ type: "tool_output", toolCallId: "t1", text: "hidden output" });
      line(end("t1", "Bash", { durationMs: 2_000 }));
      line(start("t2", "Bash", "false"));
      line(end("t2", "Bash", { isError: true, error: "boom\nmore" }));
      line(start("t3", "Write", "src/a.ts"));
      line({ type: "blocked", toolName: "Write", reason: "not allowed" });
      line(end("t3", "Write", { isError: true }));
      line(start("t4", "Read", "Read denied by the access profile (rule: /x)"));
      line(end("t4", "Read", { isError: true }));
      return reply("finished");
    });
    const chat = await r.chat();
    await r.say(chat, "go");
    await r.round(chat);
    const markdown = (await transcript(r, chat)).markdown;
    expect(markdown).toContain("> checking");
    expect(markdown).not.toContain("Thinking");
    expect(markdown).toContain("tool Bash 2s `make test`");
    expect(markdown).toContain("failed: boom");
    expect(markdown).not.toContain("more");
    expect(markdown).toContain("blocked: not allowed");
    expect(markdown).toContain("denied");
    expect(markdown).not.toContain("hidden output");
    expect(markdown.indexOf("finished")).toBeGreaterThan(markdown.indexOf("tool Bash"));
  });

  test("a radian chat shows the tool lines only", async () => {
    const r = await rig((ctx) => {
      const line = send(ctx);
      line({ type: "thinking_end", text: "quiet thought" });
      line({ type: "text_end", text: "quiet words" });
      line(start("t1", "Bash", "ls"));
      line(end("t1", "Bash"));
      return reply("final answer");
    }, undefined, "radian");
    const chat = await r.chat();
    await r.say(chat, "go");
    await r.round(chat);
    const markdown = (await transcript(r, chat)).markdown;
    expect(markdown).toContain("tool Bash");
    expect(markdown).not.toContain("quiet thought");
    expect(markdown).not.toContain("quiet words");
    expect(markdown).toContain("final answer");
  });

  test("a page counts messages and keeps a turn's entries with its reply", async () => {
    const r = await rig((ctx) => {
      const line = send(ctx);
      line(start("t1", "Bash", "ls"));
      line(end("t1", "Bash"));
      return reply("the answer");
    });
    const chat = await r.chat();
    for (let index = 0; index < 49; index += 1) await r.say(chat, `message ${index}`);
    await r.round(chat);
    const first = await transcript(r, chat);
    expect(first.markdown).toContain("tool Bash");
    expect(first.markdown).toContain("the answer");
    expect(first.next).toBeUndefined();
  });

  test("a chat with no entries reads as before", async () => {
    const r = await rig(() => reply("plain reply"));
    const chat = await r.chat();
    await r.say(chat, "plain question");
    await r.round(chat);
    expect(allEntries(r.store, chat)).toEqual([]);
    const markdown = (await transcript(r, chat)).markdown;
    expect(markdown).toContain("plain question");
    expect(markdown).toContain("plain reply");
    expect(markdown).not.toContain("tool ");

    const empty = await r.chat();
    expect((await transcript(r, empty)).markdown).toBe("Agent: fake\n\nNo messages yet.");
  });
});
