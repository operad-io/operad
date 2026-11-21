import { describe, expect, test } from "bun:test";
import { compareVersions, strictVersionCompare, versionAtLeast } from "../src/index.ts";

describe("compareVersions", () => {
  test("the lenient form reads claude's dotted version", () => {
    expect(compareVersions("2.1.319", "2.1.319")).toBe(0);
    expect(compareVersions("2.1.320", "2.1.319")).toBeGreaterThan(0);
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
  });

  test("the strict form orders prereleases and refuses a version it cannot read", () => {
    const strict = strictVersionCompare((version) => new Error(`bad ${version}`));
    expect(strict("1.5.0-rc.1", "1.5.0")).toBeLessThan(0);
    expect(strict("1.5.0-rc.2", "1.5.0-rc.10")).toBeLessThan(0);
    expect(() => strict("1.5", "1.5.0")).toThrow("bad 1.5");
    expect(() => strict("1.5.0", "one")).toThrow("bad one");
  });

  test("the lenient form does not order a prerelease as semver does", () => {
    // The old split reads "0-rc" as a number, so this is NaN, not an order.
    expect(Number.isNaN(compareVersions("1.5.0-rc.1", "1.5.0"))).toBe(true);
  });
});

describe("versionAtLeast", () => {
  test("compares the first three numbers", () => {
    expect(versionAtLeast("0.166.0", "0.166.0")).toBe(true);
    expect(versionAtLeast("0.167.1", "0.166.0")).toBe(true);
    expect(versionAtLeast("0.165.9", "0.166.0")).toBe(false);
    expect(versionAtLeast("9.9.9", "0.166.0")).toBe(true);
  });

  test("does not compare a version it cannot read", () => {
    expect(versionAtLeast("development", "0.166.0")).toBe(true);
  });
});
