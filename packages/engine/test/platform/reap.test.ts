import { expect, test } from "bun:test";
import {
  enterStep,
  reapStep,
  type MarkedProcess,
  type ProcessRow,
  type StepMarker,
} from "../../src/platform/index.ts";

/**
 * The table and the environment listing are what a sweep costs. A step that
 * started no marked process cannot have left one, so ending it must not read
 * either: this is what keeps a flow of cheap steps cheap.
 */
test("a step that started no process reads no process table", async () => {
  const marker: StepMarker = {
    runId: "run-no-process",
    step: "test/step",
    home: "/operad-reap-test",
  };
  const leave = enterStep(marker);
  expect(leave()).toBe(true);

  let tabled = 0;
  let listed = 0;
  const table = async (): Promise<readonly ProcessRow[]> => {
    tabled += 1;
    return [];
  };
  const list = async (): Promise<readonly MarkedProcess[]> => {
    listed += 1;
    return [];
  };

  const found = await reapStep(marker, undefined, { table, list });

  expect(found).toEqual([]);
  expect(tabled).toBe(0);
  expect(listed).toBe(0);
});
