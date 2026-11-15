/**
 * A stand-in for `codex app-server`: speaks its JSON-RPC over stdio and acts by
 * `FAKE_CODEX_MODE`. It never runs Codex and never touches the network.
 *
 * Environment: `FAKE_CODEX_MODE`; `FAKE_CODEX_RECORD` (every message the
 * client sends is appended there as one JSON line); `FAKE_CODEX_MARKER` (the
 * pid is written there once the turn started); `FAKE_CODEX_RELEASE` (a path
 * the `silent-image` and `steer` modes wait for); `FAKE_CODEX_VERSION` (what
 * `--version` prints); `FAKE_CODEX_LOGIN` (`out`: `login status` exits 1);
 * `FAKE_CODEX_COMMAND` and `FAKE_CODEX_PATH` (the call a permission mode asks
 * about).
 *
 * Modes: `done`, `images` (two image generations), `permission`,
 * `permission-network`, `permission-edit`, `usage-limit`, `bad-model`,
 * `bad-effort`, `auth`, `cancel`, `cancel-ignored`, `silent-image`, `steer`,
 * `no-load` (a resume fails), `silent` (no line after the turn starts),
 * `exited-early` (the process exits after the turn starts), `no-app-server`
 * (the help/check probe fails).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { waitForRelease } from "../../process/test/fake-lines.ts";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "9.9.9"}`);
  process.exit(0);
}

if (args.includes("login")) {
  if (process.env.FAKE_CODEX_LOGIN === "out") {
    console.error("Not logged in");
    process.exit(1);
  }
  console.log("Logged in using ChatGPT");
  process.exit(0);
}

if (args.includes("--help")) {
  if (process.env.FAKE_CODEX_MODE === "no-app-server") {
    console.error("error: unrecognized subcommand 'app-server'");
    process.exit(1);
  }
  console.log("Usage: codex app-server [OPTIONS] [COMMAND]");
  process.exit(0);
}

const mode = process.env.FAKE_CODEX_MODE ?? "done";
const recordPath = process.env.FAKE_CODEX_RECORD;
const markerPath = process.env.FAKE_CODEX_MARKER;
const releasePath = process.env.FAKE_CODEX_RELEASE;
const SESSION = "fake-thread-1";
const TURN = "fake-turn-1";

function send(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
}

function respond(id: unknown, result: unknown): void {
  send({ id, result });
}

function fail(id: unknown, message: string, info?: string): void {
  send({
    id,
    error: {
      code: -32603,
      message,
      ...(info === undefined ? {} : { data: { message, codexErrorInfo: info } }),
    },
  });
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ method, params });
}

/** Requests the fake sent and waits for, by id. */
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

function reasoning(): void {
  notify("item/started", {
    threadId: SESSION,
    turnId: TURN,
    startedAtMs: Date.now(),
    item: { type: "reasoning", id: "r1", summary: [], content: [] },
  });
  notify("item/reasoning/textDelta", { threadId: SESSION, turnId: TURN, itemId: "r1", delta: "thinking it over", contentIndex: 0 });
  notify("item/completed", {
    threadId: SESSION,
    turnId: TURN,
    completedAtMs: Date.now(),
    item: { type: "reasoning", id: "r1", summary: ["thinking it over"], content: [] },
  });
}

function agentDelta(itemId: string, delta: string): void {
  notify("item/agentMessage/delta", { threadId: SESSION, turnId: TURN, itemId, delta });
}

function commandItem(id: string, command: string, status: string, output: string | null, exitCode: number | null): Record<string, unknown> {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command,
    cwd: "/w",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: output,
    exitCode,
    durationMs: status === "inProgress" ? null : 5,
  };
}

function fileItem(path: string, status: string): Record<string, unknown> {
  return {
    type: "fileChange",
    id: "t2",
    changes: [{ path, kind: { type: "update", move_path: null }, diff: "changed" }],
    status,
  };
}

function imageItem(id: string, status: string, savedPath?: string): Record<string, unknown> {
  return {
    type: "imageGeneration",
    id,
    status,
    revisedPrompt: null,
    failure: null,
    generationId: null,
    fileId: id,
    ...(savedPath === undefined ? {} : { savedPath }),
  };
}

function finish(): void {
  notify("thread/tokenUsage/updated", {
    threadId: SESSION,
    turnId: TURN,
    tokenUsage: {
      total: { totalTokens: 30, inputTokens: 11, cachedInputTokens: 3, cacheWriteInputTokens: 5, outputTokens: 7, reasoningOutputTokens: 4 },
      last: { totalTokens: 30, inputTokens: 11, cachedInputTokens: 3, cacheWriteInputTokens: 5, outputTokens: 7, reasoningOutputTokens: 4 },
      modelContextWindow: 200000,
    },
  });
  notify("turn/completed", {
    threadId: SESSION,
    turn: {
      id: TURN,
      rootTurnId: TURN,
      items: [],
      itemsView: "notLoaded",
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: 1,
    },
  });
}

async function permissionTurn(): Promise<void> {
  const edit = mode === "permission-edit";
  const network = mode === "permission-network";
  if (edit) {
    const path = process.env.FAKE_CODEX_PATH ?? "/etc/passwd";
    const item = fileItem(path, "inProgress");
    notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item });
    const response = await ask("item/fileChange/requestApproval", {
      threadId: SESSION,
      turnId: TURN,
      itemId: "t2",
      startedAtMs: Date.now(),
      reason: null,
      grantRoot: null,
    });
    if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify({ permissionResponse: response.result })}\n`);
    const decision = (response.result as { decision?: string } | undefined)?.decision;
    const allowed = decision === "accept";
    notify("item/completed", {
      threadId: SESSION,
      turnId: TURN,
      completedAtMs: Date.now(),
      item: fileItem(path, allowed ? "completed" : "declined"),
    });
    agentDelta("m1", allowed ? "it ran" : "it was refused");
  } else {
    const command = process.env.FAKE_CODEX_COMMAND ?? "rm -rf build";
    const item = commandItem("p1", command, "inProgress", null, null);
    notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item });
    const response = await ask("item/commandExecution/requestApproval", {
      kind: "command",
      threadId: SESSION,
      turnId: TURN,
      itemId: "p1",
      startedAtMs: Date.now(),
      command: network && process.env.FAKE_CODEX_COMMAND === undefined ? null : command,
      cwd: "/w",
      reason: network ? "network access" : null,
      ...(network ? { networkApprovalContext: { host: "example.com", protocol: "https" } } : {}),
    });
    if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify({ permissionResponse: response.result })}\n`);
    const decision = (response.result as { decision?: string } | undefined)?.decision;
    const allowed = decision === "accept";
    notify("item/completed", {
      threadId: SESSION,
      turnId: TURN,
      completedAtMs: Date.now(),
      item: commandItem("p1", command, allowed ? "completed" : "declined", allowed ? "ran" : "declined by the user", allowed ? 0 : null),
    });
    agentDelta("m1", allowed ? "it ran" : "it was refused");
  }
  finish();
}

let interrupted: (() => void) | undefined;
let steered: ((text: string) => void) | undefined;

async function runTurn(): Promise<void> {
  if (markerPath !== undefined) writeFileSync(markerPath, String(process.pid));
  notify("turn/started", {
    threadId: SESSION,
    turn: { id: TURN, rootTurnId: TURN, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null },
  });
  switch (mode) {
    case "silent":
      return;
    case "exited-early":
      process.exit(1);
      return;
    case "cancel":
    case "cancel-ignored": {
      const item = commandItem("c1", "sleep 100", "inProgress", null, null);
      notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item });
      if (mode === "cancel-ignored") return;
      await new Promise<void>((resolve) => {
        interrupted = resolve;
      });
      notify("item/completed", { threadId: SESSION, turnId: TURN, completedAtMs: Date.now(), item: commandItem("c1", "sleep 100", "declined", null, null) });
      notify("turn/completed", {
        threadId: SESSION,
        turn: { id: TURN, rootTurnId: TURN, items: [], itemsView: "notLoaded", status: "interrupted", error: null, startedAt: null, completedAt: null, durationMs: 1 },
      });
      return;
    }
    case "steer": {
      const item = commandItem("s1", "sleep 100", "inProgress", null, null);
      notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item });
      const text = await new Promise<string>((resolve) => {
        steered = resolve;
      });
      notify("item/completed", { threadId: SESSION, turnId: TURN, completedAtMs: Date.now(), item: commandItem("s1", "sleep 100", "completed", "done", 0) });
      agentDelta("m1", `heard: ${text}`);
      finish();
      return;
    }
    case "usage-limit":
      notify("error", {
        error: {
          message: "Your ChatGPT allowance is used up. Try again later.",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
          misalignment: null,
        },
        willRetry: false,
        threadId: SESSION,
        turnId: TURN,
      });
      notify("turn/completed", {
        threadId: SESSION,
        turn: {
          id: TURN,
          rootTurnId: TURN,
          items: [],
          itemsView: "notLoaded",
          status: "failed",
          error: {
            message: "Your ChatGPT allowance is used up. Try again later.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
            misalignment: null,
          },
          startedAt: null,
          completedAt: null,
          durationMs: 1,
        },
      });
      return;
    case "silent-image": {
      notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item: imageItem("img1", "inProgress") });
      await waitForRelease(releasePath);
      notify("item/completed", {
        threadId: SESSION,
        turnId: TURN,
        completedAtMs: Date.now(),
        item: imageItem("img1", "completed", "/tmp/fox.png"),
      });
      agentDelta("m1", "made the fox");
      finish();
      return;
    }
    case "permission":
    case "permission-network":
    case "permission-edit":
      await permissionTurn();
      return;
    default:
      break;
  }

  reasoning();
  agentDelta("m1", "starting. ");
  notify("item/started", {
    threadId: SESSION,
    turnId: TURN,
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: "m1", text: "", phase: null, memoryCitation: null, delivery: null, questions: null },
  });
  notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item: commandItem("t1", "make test", "inProgress", null, null) });
  notify("item/commandExecution/outputDelta", { threadId: SESSION, turnId: TURN, itemId: "t1", delta: "all green\nsecond line" });
  notify("item/completed", { threadId: SESSION, turnId: TURN, completedAtMs: Date.now(), item: commandItem("t1", "make test", "completed", "all green\nsecond line", 0) });
  agentDelta("m1", "all ");
  notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item: fileItem("/w/a.ts", "inProgress") });
  notify("item/completed", { threadId: SESSION, turnId: TURN, completedAtMs: Date.now(), item: fileItem("/w/a.ts", "completed") });
  notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item: commandItem("t3", "false", "inProgress", null, null) });
  notify("item/completed", { threadId: SESSION, turnId: TURN, completedAtMs: Date.now(), item: commandItem("t3", "false", "failed", "could not write\nmore", 1) });
  const images = mode === "images" ? 2 : mode === "done" ? 1 : 0;
  for (let index = 1; index <= images; index += 1) {
    notify("item/started", { threadId: SESSION, turnId: TURN, startedAtMs: Date.now(), item: imageItem(`img${index}`, "inProgress") });
    notify("item/completed", {
      threadId: SESSION,
      turnId: TURN,
      completedAtMs: Date.now(),
      item: imageItem(`img${index}`, "completed", `/tmp/img${index}.png`),
    });
  }
  agentDelta("m1", "all ");
  agentDelta("m1", "done (1 blocks)");
  notify("item/completed", {
    threadId: SESSION,
    turnId: TURN,
    completedAtMs: Date.now(),
    item: { type: "agentMessage", id: "m1", text: "starting. all done (1 blocks)", phase: null, memoryCitation: null, delivery: null, questions: null },
  });
  finish();
}

function handle(message: Record<string, unknown>): void {
  if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify(message)}\n`);
  const { id, method } = message;
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (method === undefined) {
    if (typeof id === "number") {
      const resolve = waiting.get(id);
      if (resolve !== undefined) {
        waiting.delete(id);
        resolve(message);
      }
    }
    return;
  }
  switch (method) {
    case "initialize":
      respond(id, {
        userAgent: "fake-codex-app-server/9.9.9",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      });
      return;
    case "initialized":
      return;
    case "model/list":
      respond(id, {
        data: [
          { id: "gpt-fake", model: "gpt-fake", displayName: "Fake", hidden: false, isDefault: true },
          { id: "gpt-other", model: "gpt-other", displayName: "Other", hidden: false, isDefault: false },
        ],
        nextCursor: null,
      });
      return;
    case "thread/start":
      if (mode === "auth") {
        fail(id, "Authentication required", "unauthorized");
        return;
      }
      if (mode === "bad-model" && typeof params.model === "string") {
        fail(id, `model ${params.model} not found`, "modelNotFound");
        return;
      }
      respond(id, {
        thread: { id: SESSION, sessionId: SESSION, cwd: params.cwd ?? "/w" },
        model: params.model ?? "fake-model",
        modelProvider: "openai",
        reasoningEffort: null,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandbox: params.sandbox,
      });
      return;
    case "thread/resume":
      if (mode === "no-load") {
        fail(id, "thread not found");
        return;
      }
      notify("item/started", { threadId: String(params.threadId), turnId: "old-turn", startedAtMs: Date.now(), item: imageItem("old1", "inProgress") });
      notify("item/completed", { threadId: String(params.threadId), turnId: "old-turn", completedAtMs: Date.now(), item: imageItem("old1", "completed", "/tmp/old.png") });
      notify("item/agentMessage/delta", { threadId: String(params.threadId), turnId: "old-turn", itemId: "old-m", delta: "an earlier message" });
      respond(id, { thread: { id: String(params.threadId), sessionId: String(params.threadId), cwd: params.cwd ?? "/w" }, model: params.model ?? "fake-model" });
      return;
    case "turn/start":
      if (mode === "bad-effort" && typeof params.effort === "string") {
        fail(id, `reasoning effort ${params.effort} is not supported`);
        return;
      }
      respond(id, {
        turn: { id: TURN, rootTurnId: TURN, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null },
      });
      void runTurn();
      return;
    case "turn/steer":
      respond(id, {});
      steered?.(String((Array.isArray(params.input) ? (params.input[0] as { text?: unknown } | undefined)?.text : undefined) ?? ""));
      return;
    case "turn/interrupt":
      respond(id, {});
      if (mode === "cancel") interrupted?.();
      return;
    default:
      fail(id, `method not found: ${String(method)}`);
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
