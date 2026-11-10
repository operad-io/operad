/**
 * A stand-in for the pi child program that prints fixed lines. It reads the
 * stdin object, records it, and acts by `FAKE_PI_MODE`. It never imports pi and
 * never touches a credential file.
 *
 * Environment: `FAKE_PI_MODE`, `FAKE_PI_RECORD` (the stdin object is written
 * there), `FAKE_PI_MARKER` (the pid is written there once the program is
 * running), `FAKE_PI_RELEASE` (a path the program waits for), `FAKE_PI_COMMIT`
 * (a file name the `commit` mode creates and commits in the input's `cwd`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const mode = process.env["FAKE_PI_MODE"] ?? "done";
const recordPath = process.env["FAKE_PI_RECORD"];
const marker = process.env["FAKE_PI_MARKER"];
const release = process.env["FAKE_PI_RELEASE"];

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
    sessionId: "fake-session",
    usage: { input: 11, output: 7 },
    cost: { micros: 1234 },
    finalMessage: "fake final message",
    ...extra,
  };
}

function failed(reason: string, message: string): Record<string, unknown> {
  return result({ result: "failed", reason, message });
}

function mark(): void {
  if (marker !== undefined) writeFileSync(marker, String(process.pid));
}

/**
 * Resolves when the release file exists. The directory watch wakes it at once;
 * a watch can miss an event under load, so a look every 100 ms backs it.
 */
function released(): Promise<void> {
  if (release === undefined || existsSync(release)) return Promise.resolve();
  const path = release;
  return new Promise((resolve) => {
    const check = (): void => {
      if (!existsSync(path)) return;
      watcher.close();
      clearInterval(timer);
      resolve();
    };
    const watcher = watch(dirname(path), check);
    const timer = setInterval(check, 100);
    check();
  });
}

const hang = (): Promise<never> => new Promise(() => {});

switch (mode) {
  case "done":
    line({ type: "message_end", role: "assistant", stopReason: "stop" });
    line(result());
    process.exit(0);
    break;
  case "message": {
    // Waits for a message from the host and records it.
    mark();
    const said = await stdinLine();
    if (recordPath !== undefined) writeFileSync(`${recordPath}.message`, said);
    line(result());
    process.exit(0);
    break;
  }
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
  case "incomplete":
    line(result({ cost: { micros: 900, incomplete: true } }));
    process.exit(0);
    break;
  case "no-cost":
    line(result({ cost: null }));
    process.exit(0);
    break;
  case "commit": {
    const name = process.env["FAKE_PI_COMMIT"] ?? "worker.txt";
    writeFileSync(join(input.cwd, name), "done\n");
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", input.cwd, "-c", "user.name=worker", "-c", "user.email=worker@example.com", ...args]);
    git("add", name);
    git("commit", "-qm", "worker work");
    line(result());
    process.exit(0);
    break;
  }
  case "no-result":
    line({ type: "message_end", role: "assistant", stopReason: "stop" });
    process.stderr.write("first stderr line\nsecond stderr line\n");
    process.exit(1);
    break;
  case "kill":
    line({ type: "message_end", role: "assistant", stopReason: "stop" });
    mark();
    process.kill(process.pid, "SIGKILL");
    await hang();
    break;
  case "stall":
    line({ type: "message_end", role: "assistant", stopReason: "stop" });
    mark();
    await hang();
    break;
  case "tool-silent":
    line({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
    mark();
    await released();
    line({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false });
    line(result());
    process.exit(0);
    break;
  case "model-error-429":
    line(failed("model_error", "429 {\"error\":{\"type\":\"overloaded_error\"}}"));
    process.exit(1);
    break;
  case "model-error-usage-limit":
    line(failed("model_error", "You have hit your usage limit; it resets at 5pm"));
    process.exit(1);
    break;
  case "model-error-other":
    line(failed("model_error", "the stream ended unexpectedly"));
    process.exit(1);
    break;
  case "session-missing":
    line(failed("session_missing", "resumeSession does not exist: /nowhere"));
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
