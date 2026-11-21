import { describe, expect, test } from "bun:test";
import { compareVersionText, readVersionText } from "../../src/index.ts";

function compare(left: string, right: string): number {
  const a = readVersionText(left);
  const b = readVersionText(right);
  if (a === undefined || b === undefined) throw new Error("the test names a version that could not be read");
  return compareVersionText(a, b);
}

describe("readVersionText", () => {
  test("reads a full version, with or without a leading v", () => {
    expect(readVersionText("1.5.0")).toEqual({ major: 1, minor: 5, patch: 0, prerelease: [] });
    expect(readVersionText("v1.5.0")).toEqual({ major: 1, minor: 5, patch: 0, prerelease: [] });
    expect(readVersionText("1.5.0-rc.2+build")).toEqual({
      major: 1,
      minor: 5,
      patch: 0,
      prerelease: ["rc", "2"],
    });
  });

  test("refuses a version that is not three parts", () => {
    for (const value of ["1.5", "1", "one.two.three", "", "1.5.0.1"]) {
      expect(readVersionText(value)).toBeUndefined();
    }
  });
});

describe("compareVersionText", () => {
  test("orders the core parts", () => {
    expect(compare("1.5.0", "1.5.0")).toBe(0);
    expect(compare("1.6.0", "1.5.9")).toBeGreaterThan(0);
    expect(compare("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  test("puts a prerelease below its release", () => {
    expect(compare("1.5.0-rc.1", "1.5.0")).toBeLessThan(0);
    expect(compare("1.5.0", "1.5.0-rc.1")).toBeGreaterThan(0);
  });

  test("orders prerelease parts as semver does", () => {
    expect(compare("1.5.0-rc.2", "1.5.0-rc.10")).toBeLessThan(0);
    expect(compare("1.5.0-alpha", "1.5.0-1")).toBeGreaterThan(0);
    expect(compare("1.5.0-alpha", "1.5.0-alpha.1")).toBeLessThan(0);
  });
});
