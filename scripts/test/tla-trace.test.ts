import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTrace,
  eventOf,
  parseHistory,
  renderModule,
  verdictOf,
  type HistoryLine,
} from "../tla-trace.ts";

const fixtures = join(import.meta.dir, "fixtures", "tla-trace");
const A = "operad-ios/T-0076-chat-bottom-followups";
const B = "operad-ios/T-0077-state-colors-followups";

function load(name: string) {
  return parseHistory(readFileSync(join(fixtures, `${name}.json`), "utf8"));
}

function line(what: string, step: string | null = null): HistoryLine {
  return { time: "2026-11-13T21:00:00.000Z", step, what, why: "" };
}

describe("scripts/tla-trace.ts", () => {
  test("a line becomes an event, narration becomes nothing", () => {
    expect(eventOf(line("run started"))).toBe("run:start");
    expect(eventOf(line("started work", "work"))).toBe("start:work");
    expect(eventOf(line("work done", "work"))).toBe("result:work:done");
    expect(eventOf(line("integrate fail", "integrate"))).toBe("result:integrate:fail");
    expect(eventOf(line("you chose rework", "wait"))).toBe("choose:rework");
    expect(eventOf(line("running work", "work"))).toBeUndefined();
    expect(eventOf(line("moving to verify", "work"))).toBeUndefined();
    expect(eventOf(line("waiting for you", "wait"))).toBeUndefined();
    expect(eventOf(line("event dev.waiting from operad"))).toBeUndefined();
    expect(eventOf(line("run cancelled"))).toBe("run:cancelled");
  });

  test("a failed run and a step re-run after a crash are events no model has", () => {
    expect(eventOf(line("run failed"))).toBe("run:failed");
    expect(eventOf(line("re-running work after a crash", "work"))).toBe("run:crashed");
    const trace = buildTrace([{ id: A, lines: [line("run started"), line("run failed")] }]);
    expect(trace.events.map((e) => e.event)).toEqual(["run:start", "run:failed"]);
    expect(trace.ignored).toEqual([]);
  });

  test("the fixture history reads as the events of its flow", () => {
    const trace = buildTrace([{ id: B, lines: load("T-0077-state-colors-followups") }]);
    const events = trace.events.map((e) => e.event);
    expect(events.slice(0, 8)).toEqual([
      "run:start",
      "start:worktree",
      "result:worktree:ready",
      "start:work",
      "result:work:done",
      "start:verify",
      "result:verify:pass",
      "start:review",
    ]);
    expect(events).toContain("result:integrate:merged");
    expect(events.at(-1)).toBe("run:done");
    expect(trace.repoOf[B]).toBe("operad-ios");
  });

  test("two histories are merged by time and keep each task's own order", () => {
    const trace = buildTrace([
      { id: A, lines: load("T-0076-chat-bottom-followups") },
      { id: B, lines: load("T-0077-state-colors-followups") },
    ]);
    const mine = (id: string) => trace.events.filter((e) => e.task === id).map((e) => e.event);
    expect(mine(A)).toEqual(buildTrace([{ id: A, lines: load("T-0076-chat-bottom-followups") }]).events.map((e) => e.event));
    // T-0077 started its work (22:33:20) before T-0076's rework did (22:33:31),
    // and T-0077 merged before T-0076's work failed (00:55).
    const at = (task: string, event: string, nth: number) =>
      trace.events.map((e, index) => ({ e, index })).filter(({ e }) => e.task === task && e.event === event)[nth]?.index ?? -1;
    expect(at(B, "start:work", 0)).toBeLessThan(at(A, "start:work", 1));
    expect(at(B, "result:integrate:merged", 0)).toBeLessThan(at(A, "result:work:failed", 0));
    expect(at(A, "result:work:failed", 0)).toBeLessThan(at(A, "result:reverify:ready", 0));
  });

  test("the module holds the tasks, repositories, events and the bounds the specs read", () => {
    const text = renderModule(
      buildTrace([
        { id: A, lines: load("T-0076-chat-bottom-followups") },
        { id: B, lines: load("T-0077-state-colors-followups") },
      ]),
    );
    expect(text).toContain("---- MODULE TraceData ----");
    expect(text).toContain(`TraceTasks == {"${A}", "${B}"}`);
    expect(text).toContain(`IF t = "${A}" THEN "operad-ios"`);
    expect(text).toContain(`<<"${A}", "result:reverify:ready">>`);
    expect(text).toContain("TraceMaxStarts == 2");
    expect(text).toContain("TraceMaxFails == 0");
    expect(text.trimEnd().endsWith("====")).toBe(true);
  });

  test("failed integrations are counted as the reworks the model must allow", () => {
    const lines: HistoryLine[] = [
      line("started integrate", "integrate"),
      line("integrate fail", "integrate"),
      line("started integrate", "integrate"),
      line("integrate conflict", "integrate"),
      line("started integrate", "integrate"),
      line("integrate merged", "integrate"),
    ];
    expect(renderModule(buildTrace([{ id: "r/T-1", lines }]))).toContain("TraceMaxFails == 2");
  });

  test("a task given twice, a bad time and a non-history are refused", () => {
    expect(() => buildTrace([{ id: "a", lines: [] }, { id: "a", lines: [] }])).toThrow("twice");
    expect(() => buildTrace([{ id: "a", lines: [{ time: "soon", step: null, what: "run started", why: "" }] }])).toThrow("not a time");
    expect(() => parseHistory("{}")).toThrow("array");
    expect(() => parseHistory('[{"what":"x"}]')).toThrow("line 1");
  });

  test("an empty history is a valid, empty trace", () => {
    const text = renderModule(buildTrace([]));
    expect(text).toContain("TraceEvents == <<>>");
    expect(text).toContain("TraceMaxStarts == 0");
  });

  describe("the verdict of TLC's output", () => {
    const progress = (k: number, n: number, task: string, event: string) =>
      `<<\n  "TRACE",\n  ${k},\n  ${n},\n  "${task}",\n  "${event}" >>\n`;

    test("an invariant violation is the accept", () => {
      const out = progress(0, 3, "a", "start:work") + progress(3, 3, "-", "-") + "Error: Invariant NotAllMatched is violated.\n";
      expect(verdictOf(out)).toEqual({ accepted: true, matched: 3, total: 3 });
    });

    test("a run that ends with no error stopped at the last position it reached", () => {
      const out =
        progress(0, 3, "a", "start:work") +
        progress(1, 3, "a", "result:work:done") +
        progress(2, 3, "b", "result:reverify:ready") +
        progress(1, 3, "a", "result:work:done") +
        "Model checking completed. No error has been found.\n";
      expect(verdictOf(out)).toEqual({
        accepted: false,
        matched: 2,
        total: 3,
        rejected: { task: "b", event: "result:reverify:ready" },
      });
    });

    test("a run TLC stopped for another reason is not a rejection", () => {
      const head = progress(0, 3, "a", "start:work") + progress(1, 3, "a", "result:work:done");
      expect(() => verdictOf(head + "Error: Invariant RepoLimit is violated.\n")).toThrow("RepoLimit is violated");
      expect(() => verdictOf(head + "Error: Deadlock reached.\n")).toThrow("Deadlock reached");
      expect(() => verdictOf(head)).toThrow("another reason");
    });

    test("output that is not a trace check is refused", () => {
      expect(() => verdictOf("Model checking completed. No error has been found.\n")).toThrow("no TRACE line");
    });
  });
});
