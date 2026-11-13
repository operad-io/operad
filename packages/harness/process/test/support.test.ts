import { describe, expect, test } from "bun:test";
import { pidValue } from "./support.ts";

describe("test support", () => {
  test("a pid must be a finite integer above 1", () => {
    expect(pidValue("")).toBeUndefined();
    expect(pidValue("0")).toBeUndefined();
    expect(pidValue("1")).toBeUndefined();
    expect(pidValue("-5")).toBeUndefined();
    expect(pidValue("2.5")).toBeUndefined();
    expect(pidValue(" 4242\n")).toBe(4242);
  });
});
