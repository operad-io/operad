import { describe, expect, test } from "bun:test";
import type { RunningItem } from "@operad-io/engine";
import { runningMarkdown } from "../src/format.ts";

const item = (extra: Partial<RunningItem>): RunningItem => ({
  runId: "run-1",
  flow: "dev",
  step: "verify",
  startedAt: 0,
  elapsedMs: 600_000,
  object: "ops/T-0061-x",
  title: "Check it",
  stepStartedAt: 0,
  stepElapsedMs: 5_000,
  queued: null,
  stepLabel: "verify",
  ...extra,
});

describe("the running list", () => {
  test("a step queued for a check place shows queued, and its queued time once it runs", () => {
    const load = { load1: 0, cores: 1 };
    const waiting = runningMarkdown(
      [
        item({
          stepLabel: "verify queued (check place, 1 ahead)",
          queued: { key: "check place", ahead: 1 },
          stepStartedAt: null,
          stepElapsedMs: 0,
          queuedMs: 540_000,
        }),
      ],
      load,
    );
    expect(waiting).toContain("verify queued (check place, 1 ahead)");
    expect(waiting).toContain("(queued 9m 0s)");
    const taken = runningMarkdown([item({ queuedMs: 540_000 })], load);
    expect(taken).toContain("| verify | 5.0s (queued 9m 0s) |");
    expect(taken).not.toContain("queued (");
  });
});
