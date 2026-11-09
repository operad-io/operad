/**
 * A stand-in for the claude child program that prints fixed lines. It reads
 * the stdin object, records it, and acts by `FAKE_CLAUDE_MODE`. It never
 * imports the Agent SDK and never runs `claude`.
 *
 * Environment: `FAKE_CLAUDE_MODE`, `FAKE_CLAUDE_RECORD` (the stdin object is
 * written there), `FAKE_CLAUDE_MARKER` (the pid is written there once the
 * program is running), `FAKE_CLAUDE_RELEASE` (a path the program waits for).
 */

import { existsSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const mode = process.env["FAKE_CLAUDE_MODE"] ?? "done";
const recordPath = process.env["FAKE_CLAUDE_RECORD"];
const marker = process.env["FAKE_CLAUDE_MARKER"];
const release = process.env["FAKE_CLAUDE_RELEASE"];

const reader = Bun.stdin.stream().getReader();
let buffered = "";
const decoder = new TextDecoder();
/** The next stdin line; stdin stays open so the host can answer later. */
async function stdinLine(): Promise<string> {
  for (;;) {
    const newline = buffered.indexOf("\n");
    if (newline !== -1) {
      const found = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      return found;
    }
    const chunk = await reader.read();
    if (chunk.done) {
      const rest = buffered;
      buffered = "";
      return rest;
    }
    buffered += decoder.decode(chunk.value, { stream: true });
  }
}

const input = JSON.parse(await stdinLine()) as { cwd: string };
if (recordPath !== undefined) writeFileSync(recordPath, JSON.stringify(input));

function line(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    result: "done",
    sessionId: "11111111-2222-4333-8444-555555555555",
    usage: { input: 11, output: 7, cache_read: 3, cache_write: 5 },
    cost: { micros: 1234, quality: "estimated" },
    finalMessage: "fake final message",
    model: "claude-fake-1",
    ...extra,
  };
}

function failed(reason: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return result({ result: "failed", reason, message, ...extra });
}

function mark(): void {
  if (marker !== undefined) writeFileSync(marker, String(process.pid));
}

/** Resolves when the release file exists; the directory watch wakes it. */
function released(): Promise<void> {
  if (release === undefined || existsSync(release)) return Promise.resolve();
  return new Promise((resolve) => {
    const watcher = watch(dirname(release), () => {
      if (!existsSync(release)) return;
      watcher.close();
      resolve();
    });
    if (existsSync(release)) {
      watcher.close();
      resolve();
    }
  });
}

const hang = (): Promise<never> => new Promise(() => {});

switch (mode) {
  case "done":
    line({ type: "message_end", role: "assistant", stopReason: "end_turn" });
    line(result());
    process.exit(0);
    break;
  case "exact":
    line(result({ cost: { micros: 1234, quality: "exact" } }));
    process.exit(0);
    break;
  case "no-model":
    line(result({ model: null }));
    process.exit(0);
    break;
  case "grant": {
    // Asks to use up a one-time permission, as the real program does before a
    // call the profile refuses, and records the host's answer.
    line({ type: "grant_use", id: 1, waitId: "w1" });
    const ack = await stdinLine();
    if (recordPath !== undefined) writeFileSync(`${recordPath}.ack`, ack);
    line(result());
    process.exit(0);
    break;
  }
  case "message": {
    // Waits for a message from the host and records it.
    mark();
    const said = await stdinLine();
    if (recordPath !== undefined) writeFileSync(`${recordPath}.message`, said);
    line(result());
    process.exit(0);
    break;
  }
  case "no-cost":
    line(result({ cost: null }));
    process.exit(0);
    break;
  case "no-result":
    line({ type: "message_end", role: "assistant", stopReason: "end_turn" });
    process.stderr.write("first stderr line\nsecond stderr line\n");
    process.exit(1);
    break;
  case "kill":
    line({ type: "message_end", role: "assistant", stopReason: "end_turn" });
    mark();
    process.kill(process.pid, "SIGKILL");
    await hang();
    break;
  case "stall":
    line({ type: "message_end", role: "assistant", stopReason: "end_turn" });
    mark();
    await hang();
    break;
  case "tool-silent":
    line({ type: "tool_execution_start", toolCallId: "t1", toolName: "Bash" });
    mark();
    await released();
    line({ type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false });
    line(result());
    process.exit(0);
    break;
  case "model-error-429":
    line(failed("model_error", '429 {"error":{"type":"overloaded_error"}}'));
    process.exit(1);
    break;
  case "model-error-usage-limit":
    line(
      failed("model_error", "claude stopped at its plan limit (five_hour)", {
        modelError: { kind: "usage_limit", message: "claude stopped at its plan limit (five_hour)", rateLimitType: "five_hour", resetsAt: 1790000000 },
      }),
    );
    process.exit(1);
    break;
  case "model-error-other":
    line(failed("model_error", "the stream ended unexpectedly"));
    process.exit(1);
    break;
  case "session-missing":
    line(failed("session_missing", "No conversation found with session ID: nowhere"));
    process.exit(1);
    break;
  case "cancel":
    mark();
    process.on("SIGTERM", () => {
      line(result({ result: "cancelled" }));
      process.exit(143);
    });
    await hang();
    break;
  default:
    process.exit(3);
}
