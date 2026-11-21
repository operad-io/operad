import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { StepContext, ViewContext } from "@operad-io/engine";
import { chatViews, type ReplyBlock, type ReplyToolItem } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

/** The live part the chat pushes while a reply runs. */
async function pushed(
  r: Rig,
  chat: string,
  options: { readonly sectionCapBytes?: number } = {},
): Promise<Awaited<ReturnType<NonNullable<typeof chatViews.tail>>> | undefined> {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
    ...(options.sectionCapBytes === undefined ? {} : { sectionCapBytes: options.sectionCapBytes }),
    secrets: {
      names: async () => [],
      get: async () => undefined,
      values: async () => [],
    },
    runTimes: async () => ({ startedAt: 1, endedAt: null, segments: [] }),
  } as unknown as ViewContext;
  const live = chatViews.tail;
  if (live === undefined) throw new Error("the chat type pushes no tail");
  return live(ctx, object);
}

/** Writes log lines through the harness's logger, as a real harness does. */
async function write(ctx: StepContext, ...lines: Record<string, unknown>[]): Promise<void> {
  for (const line of lines) {
    await ctx.logger.write(JSON.stringify(line));
    ctx.receiver?.(JSON.stringify(line));
  }
}

/** Runs one round whose agent writes `lines`, and gives what the chat pushed while it ran. */
async function whileRunning(
  lines: Record<string, unknown>[],
  options: { readonly sectionCapBytes?: number } = {},
): Promise<Awaited<ReturnType<typeof pushed>>> {
  let during: Awaited<ReturnType<typeof pushed>>;
  let chatId = "";
  let holder: Rig | undefined;
  const r = await rig(async (ctx) => {
    await write(ctx, ...lines);
    if (holder !== undefined) during = await pushed(holder, chatId, options);
    return reply("final answer");
  });
  holder = r;
  const chat = await r.chat();
  chatId = chat;
  await r.say(chat, "go");
  await r.round(chat);
  if (during === undefined) throw new Error("the agent did not run");
  return during;
}

describe("the chat's pushed tail", () => {
  test("the text being written is the same tail the section shows", async () => {
    const live = await whileRunning([
      { type: "text_delta", text: "I am " },
      { type: "text_delta", text: "writing" },
    ]);
    expect(live?.section).toBe("transcript");
    expect(live?.tail).toBe("**Operad Bot:** I am writing");
    expect(live?.status?.text).toBe("Starting");
  });

  test("thinking being written is a block quote", async () => {
    const live = await whileRunning([{ type: "thinking_delta", text: "hmm\nwell" }]);
    expect(live?.tail).toBe("> hmm\n> well");
  });

  test("a tool call starting is one line with its start", async () => {
    const live = await whileRunning([
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "Bash",
        at: Date.UTC(2026, 10, 12, 9, 5, 7),
        input: "ls -la",
      },
    ]);
    expect(live?.tail).toBe("tool Bash since 09:05:07 `ls -la`");
  });

  test("a retry is pushed with the time of its next attempt", async () => {
    const live = await whileRunning([
      {
        type: "retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        reason: "the provider is overloaded",
        receivedAt: 1_700_000_000_000,
      },
    ]);
    expect(live?.retry).toEqual({
      attempt: 1,
      maxAttempts: 3,
      until: 1_700_000_002_000,
      reason: "the provider is overloaded",
    });
    expect(live?.tail).toContain("Retrying the model request (1 of 3)");
  });

  test("a tool call ending replaces its start with how long it took", async () => {
    const live = await whileRunning([
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "Bash",
        at: 1_000,
        input: "ls -la",
      },
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "Bash",
        isError: false,
        durationMs: 1_200,
      },
    ]);
    expect(live?.tail).toBe("tool Bash 1s `ls -la`");
  });

  test("the pushed running reply's data stays under the cap", async () => {
    const long = "z".repeat(10_000);
    const lines: Record<string, unknown>[] = [];
    for (let index = 0; index < 10; index += 1) {
      lines.push({ type: "tool_execution_start", toolCallId: `t${index}`, toolName: "Bash", input: long, at: index });
      lines.push({ type: "tool_execution_end", toolCallId: `t${index}`, toolName: "Bash", isError: false, durationMs: 1 });
    }
    const live = await whileRunning(lines, { sectionCapBytes: 20_000 });
    const data = live?.data === undefined ? 0 : Buffer.byteLength(JSON.stringify(live.data), "utf8");
    expect(data).toBeLessThanOrEqual(20_000);
    const calls = (live?.data as { readonly replies?: readonly ReplyBlock[] } | undefined)?.replies
      ?.flatMap((block) => block.process)
      .flatMap((group) => group.items)
      .filter((item): item is ReplyToolItem => item.kind === "tool") ?? [];
    expect(calls.length).toBe(10);
    for (const call of calls) expect(call.input?.length ?? 0).toBeLessThan(long.length);
  });

  test("a whitespace-only delta pushes no empty speaker line", async () => {
    const live = await whileRunning([{ type: "text_delta", text: " \n " }]);
    expect(live?.tail).toBeUndefined();
  });

  test("the running reply is structured in the push", async () => {
    const live = await whileRunning([
      { type: "thinking_end", text: "look first", receivedAt: 1_001 },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "Bash", input: "ls", at: 1_002 },
      { type: "tool_output", toolCallId: "t1", text: "a.txt\n" },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false, durationMs: 1_200 },
    ]);
    const data = live?.data as { readonly replies?: readonly ReplyBlock[] } | undefined;
    const reply = data?.replies?.[0];
    expect(reply?.runId).toBe("run-1");
    expect(reply?.input.map((message) => message.text)).toEqual(["go"]);
    expect(reply?.answer).toBeUndefined();
    expect(reply?.process[0]?.categories).toEqual(["run"]);
    const call = reply?.process[0]?.items.find((item): item is ReplyToolItem => item.kind === "tool");
    expect(call).toMatchObject({
      callId: "t1",
      name: "Bash",
      input: "ls",
      durationMs: 1_200,
      failed: false,
      result: "done",
      output: { text: "a.txt\n", lines: 1 },
    });
  });
});
