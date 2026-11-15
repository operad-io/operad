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

describe("StepTimings first increment", () => {
  test("each kind of increment can be the first one", () => {
    const kinds = ["text_delta", "thinking_delta", "text_end", "thinking_end", "tool_execution_start", "message_end"] as const;
    for (const kind of kinds) {
      let now = 100;
      const timings = new StepTimings(() => now);
      timings.line(line({ type: "session" }, 120));
      timings.line(line({ type: kind, text: "something" }, 180));
      now = 200;
      expect(timings.finish()).toMatchObject({ startToReadyMs: 20, readyToFirstMs: 60 });
    }
  });

  test("a message_end with no text is not an increment, and a later one is", () => {
    let now = 100;
    const timings = new StepTimings(() => now);
    timings.line(line({ type: "session" }, 120));
    timings.line(line({ type: "message_end", role: "assistant" }, 150));
    timings.line(line({ type: "message_end", role: "assistant", text: "" }, 160));
    now = 170;
    expect(timings.finish().readyToFirstMs).toBeNull();

    timings.line(line({ type: "message_end", role: "assistant", text: "hello" }, 190));
    now = 200;
    expect(timings.finish().readyToFirstMs).toBe(70);
  });

  test("an increment before the session leaves the wait to the first increment absent", () => {
    let now = 100;
    const timings = new StepTimings(() => now);
    timings.line(line({ type: "text_delta", text: "early" }, 110));
    timings.line(line({ type: "session" }, 140));
    now = 160;
    expect(timings.finish()).toEqual({
      startToReadyMs: 40,
      readyToFirstMs: null,
      totalMs: 60,
    });
  });
});
