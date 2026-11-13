/**
 * A stand-in for `codex-acp`: speaks ACP over stdio and acts by
 * `FAKE_CODEX_MODE`. It never runs Codex and never touches the network.
 *
 * Environment: `FAKE_CODEX_MODE`; `FAKE_CODEX_RECORD` (every message the
 * client sends is appended there as one JSON line); `FAKE_CODEX_MARKER` (the
 * pid is written there once the prompt started); `FAKE_CODEX_RELEASE` (a path
 * the `silent-image` mode waits for).
 *
 * Modes: `done`, `images` (two image generations), `permission-network` (asks for the network, with the command in `FAKE_CODEX_COMMAND` if set), `permission` (asks to run
 * the command in `FAKE_CODEX_COMMAND` or `rm -rf build`), `permission-edit`
 * (asks to change the path in `FAKE_CODEX_PATH`), `usage-limit`, `bad-model`,
 * `bad-effort`, `auth`, `cancel` (waits for `session/cancel`),
 * `cancel-ignored` (never answers it), `silent-image` (an open image
 * generation that prints nothing until released), `no-load` (no
 * `session/load`), `silent` (no tool call and no output after the prompt).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { waitForRelease } from "../../process/test/fake-lines.ts";

if (process.argv.includes("--version")) {
  console.log("fake-codex-acp 9.9.9");
  process.exit(0);
}

if (process.argv.includes("login")) {
  // `codex login status`, when this file stands in for the codex command.
  if (process.env.FAKE_CODEX_LOGIN === "out") {
    console.error("Not logged in");
    process.exit(1);
  }
  console.log("Logged in using ChatGPT");
  process.exit(0);
}

const mode = process.env.FAKE_CODEX_MODE ?? "done";
const recordPath = process.env.FAKE_CODEX_RECORD;
const markerPath = process.env.FAKE_CODEX_MARKER;
const releasePath = process.env.FAKE_CODEX_RELEASE;
const SESSION = "fake-session-1";

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(value as Record<string, unknown>) })}\n`);
}

function update(value: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId: SESSION, update: value } });
}

function respond(id: unknown, result: unknown): void {
  send({ id, result });
}

function fail(id: unknown, code: number, message: string, data?: unknown): void {
  send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function text(value: string): Record<string, unknown> {
  return { type: "content", content: { type: "text", text: value } };
}

/** Requests the agent sent and waits for, by id. */
const waiting = new Map<number, (message: Record<string, unknown>) => void>();
let nextRequest = 100;
function ask(method: string, params: unknown): Promise<Record<string, unknown>> {
  nextRequest += 1;
  const id = nextRequest;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}

let promptId: unknown;
let cancelled: (() => void) | undefined;

async function closeCancelled(): Promise<void> {
  respond(promptId, { stopReason: "cancelled", usage: null });
}

async function prompt(id: unknown, params: Record<string, unknown>): Promise<void> {
  promptId = id;
  if (markerPath !== undefined) writeFileSync(markerPath, String(process.pid));
  switch (mode) {
    case "usage-limit":
      fail(id, -32603, "Internal error", {
        message: "Your ChatGPT allowance is used up. Try again later.",
        codexErrorInfo: "usageLimitExceeded",
      });
      return;
    case "silent":
      // Nothing to say and nothing to end with: the stall limit decides.
      return;
    case "cancel": {
      update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Run sleep 100", kind: "execute", status: "in_progress", rawInput: { command: "sleep 100" } });
      await new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      await closeCancelled();
      return;
    }
    case "cancel-ignored":
      update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Run sleep 100", kind: "execute", status: "in_progress", rawInput: { command: "sleep 100" } });
      return;
    case "silent-image":
      update({ sessionUpdate: "tool_call", toolCallId: "img1", title: "Image generation", kind: "other", status: "in_progress", rawInput: { id: "img1" } });
      await waitForRelease(releasePath);
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "img1",
        status: "completed",
        content: [text("Revised prompt: a red fox"), { type: "content", content: { type: "resource_link", uri: "file:///tmp/fox.png", name: "fox.png" } }],
        rawOutput: { status: "completed", savedPath: "/tmp/fox.png" },
      });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "made the fox" } });
      respond(id, { stopReason: "end_turn", usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 } });
      return;
    case "permission":
    case "permission-network":
    case "permission-edit": {
      const edit = mode === "permission-edit";
      const network = mode === "permission-network";
      const toolCall = network
        ? { toolCallId: "p1", title: "https network access to example.com", kind: "execute", status: "pending", rawInput: { url: "https://example.com", ...(process.env.FAKE_CODEX_COMMAND === undefined ? {} : { command: process.env.FAKE_CODEX_COMMAND }) } }
        : edit
        ? { toolCallId: "p1", title: "Edit files", kind: "edit", status: "pending", locations: [{ path: process.env.FAKE_CODEX_PATH ?? "/etc/passwd" }] }
        : { toolCallId: "p1", title: "Run command", kind: "execute", status: "pending", rawInput: { command: process.env.FAKE_CODEX_COMMAND ?? "rm -rf build", cwd: "/w" } };
      update({ sessionUpdate: "tool_call", ...toolCall, status: "in_progress" });
      const response = await ask("session/request_permission", {
        sessionId: SESSION,
        toolCall,
        options: [
          { optionId: "approve", name: "Yes", kind: "allow_once" },
          { optionId: "approve-always", name: "Yes, always", kind: "allow_always" },
          { optionId: "deny", name: "No", kind: "reject_once" },
        ],
      });
      if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify({ permissionResponse: response.result })}\n`);
      const outcome = (response.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
      const allowed = outcome?.outcome === "selected" && outcome.optionId === "approve";
      update({ sessionUpdate: "tool_call_update", toolCallId: "p1", status: allowed ? "completed" : "failed", content: [text(allowed ? "ran" : "declined by the user")] });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "it ran" : "it was refused" } });
      respond(id, { stopReason: "end_turn", usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } });
      return;
    }
    default:
      break;
  }

  const blocks = Array.isArray(params.prompt) ? (params.prompt as Record<string, unknown>[]) : [];
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking it over" } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "starting. " } });
  update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run make test", kind: "execute", status: "in_progress", rawInput: { command: "make test", cwd: "/w" } });
  update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [text("all green\nsecond line")] });
  update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit files", kind: "edit", status: "in_progress", locations: [{ path: "/w/a.ts" }] });
  update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", content: [text("could not write\nmore")] });
  const images = mode === "images" ? 2 : mode === "done" ? 1 : 0;
  for (let index = 1; index <= images; index += 1) {
    update({ sessionUpdate: "tool_call", toolCallId: `img${index}`, title: "Image generation", kind: "other", status: "in_progress", rawInput: { id: `img${index}` } });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: `img${index}`,
      status: "completed",
      rawOutput: { status: "completed", savedPath: `/tmp/img${index}.png` },
    });
  }
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all " } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `done (${blocks.length} blocks)` } });
  respond(id, {
    stopReason: "end_turn",
    usage: { totalTokens: 30, inputTokens: 11, outputTokens: 7, cachedReadTokens: 3, cachedWriteTokens: 5, thoughtTokens: 4 },
    _meta: { quota: { token_count: null } },
  });
}

function handle(message: Record<string, unknown>): void {
  if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify(message)}\n`);
  const { id, method } = message;
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (method === undefined) {
    const resolve = typeof id === "number" ? waiting.get(id) : undefined;
    if (resolve !== undefined && typeof id === "number") {
      waiting.delete(id);
      resolve(message);
    }
    return;
  }
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentInfo: { name: "fake-codex-acp", version: "9.9.9" },
        agentCapabilities: { loadSession: mode !== "no-load", promptCapabilities: { image: true } },
        authMethods: [],
      });
      return;
    case "session/new":
      if (mode === "auth") {
        fail(id, -32000, "Authentication required");
        return;
      }
      respond(id, { sessionId: SESSION, configOptions: [] });
      return;
    case "session/load": {
      // A load replays the earlier conversation as updates, then answers.
      update({ sessionUpdate: "tool_call", toolCallId: "old1", title: "Image generation", kind: "other", status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "an earlier message" } });
      respond(id, { configOptions: [] });
      return;
    }
    case "session/set_config_option":
      if (mode === "bad-model" && params.configId === "model") {
        fail(id, -32602, "Invalid params");
        return;
      }
      if (mode === "bad-effort" && params.configId === "reasoning_effort") {
        fail(id, -32602, "Invalid params");
        return;
      }
      respond(id, { configOptions: [] });
      return;
    case "session/prompt":
      void prompt(id, params);
      return;
    case "session/cancel":
      if (mode === "cancel") cancelled?.();
      return;
    default:
      fail(id, -32601, `method not found: ${String(method)}`);
  }
}

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffered = "";
for (;;) {
  const chunk = await reader.read();
  if (chunk.done) break;
  buffered += decoder.decode(chunk.value, { stream: true });
  for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim().length > 0) handle(JSON.parse(line) as Record<string, unknown>);
  }
}
