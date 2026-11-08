import { describe, expect, test } from "bun:test";
import type { RunningItem } from "@operad-io/engine";
import { runningLine } from "../src/main.ts";

const base: RunningItem = {
  runId: "196b344b",
  flow: "dev",
  step: "review",
  startedAt: 0,
  elapsedMs: (4 * 3600 + 9 * 60) * 1000,
  object: "operad/T-0048-type-filters",
  title: "Object type filters",
  stepStartedAt: 0,
  stepElapsedMs: (3 * 60 + 10) * 1000,
  queued: null,
  stepLabel: "review",
};

describe("operad running line", () => {
  test("object, step, step time, title, then the run age", () => {
    expect(runningLine(base)).toBe(
      "operad/T-0048-type-filters  review  3m 10s  Object type filters  run 4h 09m",
    );
  });

  test("the run id stands in for a missing object, and no title leaves no gap", () => {
    expect(runningLine({ ...base, object: null, title: null })).toBe(
      "196b344b  review  3m 10s  run 4h 09m",
    );
  });
});
