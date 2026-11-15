import { describe, expect, test } from "bun:test";
import { StepTimings } from "../src/timings.ts";

function line(value: Record<string, unknown>, at: number): string {
  return JSON.stringify({ ...value, receivedAt: at });
}

describe("StepTimings", () => {
  test("it measures the step to the session line, from there to the first increment, and in all", () => {
    let now = 1_000;
    const timings = new StepTimings(() => now);
    timings.line(line({ type: "session", sessionId: "s-1" }, 1_500));
    now = 2_000;
    timings.line(line({ type: "text_delta", text: "hello" }, 3_000));
    timings.line(line({ type: "tool_execution_start", toolCallId: "t", toolName: "Bash", at: 1 }, 3_500));
    now = 5_000;
    expect(timings.finish()).toEqual({
      startToReadyMs: 500,
      readyToFirstMs: 1_500,
      totalMs: 4_000,
    });
  });

  test("a log without a session or an increment reports those durations as absent", () => {
    let now = 10;
    const timings = new StepTimings(() => now);
    timings.line(JSON.stringify({ type: "journal", event: "Line" }));
    now = 25;
    expect(timings.finish()).toEqual({
      startToReadyMs: null,
      readyToFirstMs: null,
      totalMs: 15,
    });
  });

  test("a text after a tool does not replace the first increment", () => {
    let now = 100;
    const timings = new StepTimings(() => now);
    timings.line(line({ type: "session" }, 120));
    timings.line(line({ type: "tool_execution_start", toolCallId: "t", toolName: "Bash", at: 1 }, 180));
    now = 400;
    timings.line(line({ type: "text_delta", text: "done" }, 300));
    expect(timings.finish()).toMatchObject({ readyToFirstMs: 60 });
  });
});
