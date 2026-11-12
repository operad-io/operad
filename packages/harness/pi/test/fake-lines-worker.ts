/**
 * A stand-in for the pi child program that prints fixed lines. It reads the
 * stdin object, records it, and acts by `FAKE_PI_MODE`. It never imports pi and
 * never touches a credential file.
 *
 * Environment: see `startFakeLines` in harness-process's test support, with the
 * prefix `FAKE_PI`, and `FAKE_PI_COMMIT` (a file name the `commit` mode creates
 * and commits in the input's `cwd`).
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeLines } from "@operad-io/harness-process/test-fake-lines";

const { mode, recordPath, input, stdinLine, line, mark, released, hang } = await startFakeLines("FAKE_PI");

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

switch (mode) {
  case "tools":
    line({ type: "tool_execution_start", toolCallId: "t1", toolName: "Bash", at: 5, input: "make test" });
    line({ type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false, durationMs: 7 });
    line({ type: "message_end", role: "assistant", stopReason: "stop", text: "all done" });
    line(result());
    process.exit(0);
    break;
  case "done":
    line({ type: "message_end", role: "assistant", stopReason: "stop" });
    line(result());
    process.exit(0);
    break;
  case "ask": {
    // What the real program does for a call that must ask a person. A run with
    // a one-time permission (an answered question came back) first uses it up
    // for the call it covers, then asks about another call.
    const access = (input as { access?: { grants?: Array<{ waitId: string }> } }).access;
    const grant = access?.grants?.at(0);
    const session = (input as { resumeSession?: string }).resumeSession ?? "/sessions/one.jsonl";
    if (grant !== undefined) {
      line({ type: "grant_use", id: 1, waitId: grant.waitId });
      const used = await stdinLine();
      if (recordPath !== undefined) writeFileSync(`${recordPath}.grant`, used);
    }
    mark();
    line({ type: "ask_call", id: 7, kind: "command", value: grant === undefined ? "git push origin main" : "git push origin other", shown: "git push", session });
    process.on("SIGTERM", () => {
      line(result({ result: "cancelled" }));
      process.exit(143);
    });
    const ack = await stdinLine();
    if (recordPath !== undefined) writeFileSync(`${recordPath}.ack`, ack);
    line({ type: "ask_resolved", id: 7 });
    if ((JSON.parse(ack) as { decision?: string }).decision === "stop") await hang();
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
