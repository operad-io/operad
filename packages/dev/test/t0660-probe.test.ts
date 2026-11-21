import { expect, test } from "bun:test";

test("T-0660 rerun probe fails on purpose", () => {
  expect(1).toBe(2);
});
