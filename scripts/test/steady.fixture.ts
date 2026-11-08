// Fixture for stress.test.ts, not a test of its own: always passes.
import { expect, test } from "bun:test";

test("steady fixture", () => {
  expect(1 + 1).toBe(2);
});
