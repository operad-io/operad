import { expect, test } from "bun:test";
import { keepKeyOf } from "../src/keep.ts";
import { agentData, type AgentWorkerResult } from "../src/step.ts";

test("what a reply asks for in compact does not change which kept worker serves it", () => {
  const base = { cwd: "/w", model: "p/m", compact: { at: 0.75, flush: "write" } };
  expect(keepKeyOf({ ...base, compact: { at: 0.75, flush: "write", only: true } })).toBe(keepKeyOf(base));
  expect(keepKeyOf({ ...base, cwd: "/other" })).not.toBe(keepKeyOf(base));
});

const OUTCOME = { exitCode: 0, signal: null, stderrTail: [] } as never;
const WORKER: AgentWorkerResult = {
  type: "result",
  result: "done",
  sessionId: "s",
  usage: {},
  cost: null,
  finalMessage: "x",
};

test("a worker's compaction becomes the result's compacted flag and compaction note", () => {
  const data = agentData({ harness: "pi", model: null }, OUTCOME, { ...WORKER, compaction: { reason: "manual", before: 9, after: 3, flushed: true } }, "log", 1);
  expect(data.compacted).toBe(true);
  expect(data.compaction).toEqual({ reason: "manual", before: 9, after: 3, flushed: true });
  const plain = agentData({ harness: "pi", model: null }, OUTCOME, WORKER, "log", 1);
  expect("compacted" in plain).toBe(false);
});
