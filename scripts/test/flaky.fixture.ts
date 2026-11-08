// Fixture for stress.test.ts, not a test of its own: fails on every third run.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

test("flaky fixture", () => {
  const path = process.env.STRESS_COUNTER;
  if (path === undefined) throw new Error("STRESS_COUNTER is not set");
  const n = Number(readFileSync(path, "utf8")) + 1;
  writeFileSync(path, String(n));
  expect(n % 3).not.toBe(0);
});
