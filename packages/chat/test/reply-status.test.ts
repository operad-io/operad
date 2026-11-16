import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunTimes, SectionContent, ViewContext } from "@operad-io/engine";
import {
  agentLogPath,
  allMessages,
  chatRef,
  chatViews,
  ENTRY_FACT,
  MESSAGE_FACT,
  RUN_FACT,
  STOP_FACT,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;
type Times = RunTimes;
async function view(
  r: Rig,
  chat: string,
  options: { readonly after?: string; readonly times?: Times } = {},
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
    runTimes: async () => options.times,
  } as unknown as ViewContext;
  return chatViews.load(ctx, object, "transcript", options.after === undefined ? {} : { after: options.after });
}

const start = (callId: string, toolName: string, at: number): Record<string, unknown> => ({
  type: "tool_execution_start",
  toolCallId: callId,
  toolName,
  at,
  input: null,
});

const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

function logIn(r: Rig, runId: string): string {
  const path = agentLogPath(r.store.root, "fake", runId);
  mkdirSync(join(path, ".."), { recursive: true });
  return path;
}

async function runFact(r: Rig, chat: string, runId: string): Promise<void> {
  await r.store.append({
    type: RUN_FACT,
    object: chatRef(chat),
    cause: "test",
    data: { runId },
  });
}

const active = (startedAt: number): Times => ({
  startedAt,
  endedAt: null,
  segments: [{ step: "chat-reply", person: false, from: startedAt, to: null }],
});

describe("a reply's status", () => {
  test("Starting starts at the first unanswered message and lasts until the ready line", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.say(chat, "two");
    const first = allMessages(r.store, chat)[0];
    if (first === undefined) throw new Error("no message");

    expect((await view(r, chat)).status).toEqual({ text: "Starting", since: first.at });

    await runFact(r, chat, "run-start");
    writeFileSync(logIn(r, "run-start"), line({ type: "text_delta", text: "warming", receivedAt: 5_000 }));
    expect((await view(r, chat, { times: active(1_000) })).status).toEqual({ text: "Starting", since: first.at });

    appendFileSync(logIn(r, "run-start"), line({ type: "session", sessionId: "s", receivedAt: 6_000 }));
    expect((await view(r, chat, { times: active(1_000) })).status).toEqual({ text: "Thinking", since: 6_000 });
  });

  test("Running names the oldest call still going, since when it started", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await r.say(chat, "go");
    await runFact(r, chat, "run-tools");
    const path = logIn(r, "run-tools");
    writeFileSync(
      path,
      line({ type: "session", sessionId: "s", receivedAt: 1_000 }) +
        line(start("first", "Read", 2_000)) +
        line(start("second", "Bash", 2_500)),
    );
    const times = active(1_000);

    expect((await view(r, chat, { times })).status).toEqual({ text: "Running Read", since: 2_000 });

    appendFileSync(path, line({ type: "tool_execution_end", toolCallId: "first", toolName: "Read", isError: false, durationMs: 100 }));
    expect((await view(r, chat, { times })).status).toEqual({ text: "Running Bash", since: 2_500 });
  });

  test("there is no status while a question waits for the person", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await r.say(chat, "go");
    await runFact(r, chat, "run-ask");
    writeFileSync(logIn(r, "run-ask"), line({ type: "session", receivedAt: 1_000 }));
    const times: Times = {
      startedAt: 1_000,
      endedAt: null,
      segments: [
        { step: "chat-reply", person: false, from: 1_000, to: 2_000 },
        { step: "ask", person: true, from: 2_000, to: null },
      ],
    };
    expect((await view(r, chat, { times })).status).toBeUndefined();
  });

  test("there is no status after a failure", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await r.say(chat, "go");
    await runFact(r, chat, "run-failed");
    writeFileSync(logIn(r, "run-failed"), line({ type: "session", receivedAt: 1_000 }));
    await r.store.append({
      type: ENTRY_FACT,
      object: chatRef(chat),
      cause: "test",
      data: { runId: "run-failed", kind: "failure", text: "The reply failed: boom" },
    });
    expect((await view(r, chat, { times: active(1_000) })).status).toBeUndefined();
  });

  test("there is no status after a stop", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await r.say(chat, "go");
    await runFact(r, chat, "run-stopped");
    writeFileSync(logIn(r, "run-stopped"), line({ type: "session", receivedAt: 1_000 }));
    await r.store.append({
      type: STOP_FACT,
      object: chatRef(chat),
      cause: "test",
      data: { runId: "run-stopped", by: { via: "cli", id: "me" } },
    });
    expect((await view(r, chat, { times: active(1_000) })).status).toBeUndefined();
  });

  test("there is no status once every message is answered", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const id = await r.say(chat, "go");
    await r.store.append({
      type: MESSAGE_FACT,
      object: chatRef(chat),
      cause: "test",
      data: {
        id: "m-reply",
        role: "assistant",
        from: { via: "fake", id: "fake" },
        text: "done",
        attachments: [],
        source: { kind: "fake", ref: null },
        replyTo: [id],
      },
    });
    expect((await view(r, chat)).status).toBeUndefined();
  });

  test("a read with after carries the same status", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await r.say(chat, "go");
    await runFact(r, chat, "run-delta");
    writeFileSync(logIn(r, "run-delta"), line({ type: "session", receivedAt: 1_000 }));
    const full = await view(r, chat, { times: active(1_000) });
    const delta = await view(r, chat, { after: full.mark ?? "", times: active(1_000) });
    expect(delta.delta).toBe(true);
    expect(delta.status).toEqual({ text: "Thinking", since: 1_000 });
  });
});
