/**
 * A stand-in for the claude child program that prints fixed lines. It reads
 * the stdin object, records it, and acts by `FAKE_CLAUDE_MODE`. It never
 * imports the Agent SDK and never runs `claude`.
 *
 * Environment: see `startFakeLines` in harness-process's test support, with
 * the prefix `FAKE_CLAUDE`.
 */

import { writeFileSync } from "node:fs";
import { startFakeLines } from "@operad-io/harness-process/test-fake-lines";

const { mode, recordPath, input, stdinLine, line, mark, released, hang } = await startFakeLines("FAKE_CLAUDE");

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

switch (mode) {
  case "tools":
    line({ type: "tool_execution_start", toolCallId: "t1", toolName: "Bash", at: 5, input: "make test" });
    line({ type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false, durationMs: 7 });
    line({ type: "message_end", role: "assistant", stopReason: "end_turn", text: "all done" });
    line(result());
    process.exit(0);
    break;
  case "secret-line":
    line({ type: "message_end", role: "assistant", stopReason: "end_turn", text: "the key is store-secret-9" });
    line(result());
    process.exit(0);
    break;
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
  case "ask": {
    // What the real program does for a call that must ask a person. A run with
    // a one-time permission (an answered question came back) first uses it up
    // for the call it covers, then asks about another call.
    const access = (input as { access?: { grants?: Array<{ waitId: string }> } }).access;
    const grant = access?.grants?.at(0);
    const session = (input as { resumeSession?: string }).resumeSession ?? "11111111-2222-4333-8444-555555555555";
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
