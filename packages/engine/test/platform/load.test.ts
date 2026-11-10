import { describe, expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import { machineLoad } from "@operad-io/engine/platform";

describe("machineLoad", () => {
  test("reports the 1-minute load and the core count", () => {
    const load = machineLoad();
    expect(load.cores).toBe(availableParallelism());
    expect(load.load1).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(load.load1)).toBe(true);
  });
});
