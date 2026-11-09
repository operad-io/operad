import { describe, expect, test } from "bun:test";
import {
  addedLinesOf,
  filePatches,
  fixedCount,
  incrementOf,
  movesAsPreExisting,
  movesIn,
  type ReviewKind,
  previousReview,
  reviewSettingsOf,
  type PreviousFinding,
} from "../src/rework.ts";

const id = (path: string): string => path;

describe("lines the task's change touched", () => {
  test("a pure deletion marks the lines either side of the cut", () => {
    const map = addedLinesOf("+++ b/f\n@@ -7 +6,0 @@\n-gone\n");
    expect([...(map.get("f") ?? [])]).toEqual([6, 7]);
    expect(
      movesAsPreExisting({ severity: "major", file: "f", line: 7 }, map, [], id),
    ).toBe(false);
    expect(
      movesAsPreExisting({ severity: "major", file: "f", line: 11 }, map, [], id),
    ).toBe(true);
  });
});

describe("pre-existing by kind of review", () => {
  const own = addedLinesOf(
    ["+++ b/a.ts", "@@ -0,0 +50,2 @@", "+x", "+y"].join("\n"),
  );
  const rows: readonly {
    readonly name: string;
    readonly finding: { severity: string; file?: string; line?: number };
    readonly moved: Record<ReviewKind, boolean>;
  }[] = [
    { name: "near the change", finding: { severity: "major", file: "a.ts", line: 52 }, moved: { first: false, reverify: false, rework: false } },
    { name: "far, in a touched file", finding: { severity: "major", file: "a.ts", line: 200 }, moved: { first: false, reverify: false, rework: true } },
    { name: "in an untouched file", finding: { severity: "major", file: "b.ts", line: 3 }, moved: { first: true, reverify: false, rework: true } },
    { name: "critical, far", finding: { severity: "critical", file: "b.ts", line: 3 }, moved: { first: false, reverify: false, rework: false } },
    { name: "no line", finding: { severity: "major", file: "b.ts" }, moved: { first: false, reverify: false, rework: false } },
  ];
  for (const row of rows) {
    for (const kind of ["first", "reverify", "rework"] as const) {
      test(`${kind}: ${row.name}`, () => {
        expect(
          movesIn(
            kind,
            { severity: row.finding.severity, file: row.finding.file, line: row.finding.line },
            own,
            [],
            id,
          ),
        ).toBe(row.moved[kind]);
      });
    }
  }
});

describe("pre-existing rules", () => {
  const own = addedLinesOf(
    ["+++ b/a.ts", "@@ -0,0 +50,2 @@", "+x", "+y"].join("\n"),
  );
  const previous: PreviousFinding[] = [
    { severity: "major", file: "a.ts", line: 200, summary: "old" },
  ];
  const cases: readonly {
    readonly name: string;
    readonly finding: { severity: string; file?: string; line?: number };
    readonly moved: boolean;
  }[] = [
    { name: "(a) within 3 lines after a changed line", finding: { severity: "major", file: "a.ts", line: 54 }, moved: false },
    { name: "(a) within 3 lines before a changed line", finding: { severity: "minor", file: "a.ts", line: 47 }, moved: false },
    { name: "(a) 4 lines away is moved", finding: { severity: "major", file: "a.ts", line: 55 }, moved: true },
    { name: "(a) another file is moved", finding: { severity: "major", file: "b.ts", line: 50 }, moved: true },
    { name: "(b) within 10 lines of a previous finding", finding: { severity: "major", file: "a.ts", line: 190 }, moved: false },
    { name: "(b) 11 lines away is moved", finding: { severity: "major", file: "a.ts", line: 189 }, moved: true },
    { name: "(b) the same line in another file is moved", finding: { severity: "major", file: "b.ts", line: 200 }, moved: true },
    { name: "(c) critical far away stays", finding: { severity: "critical", file: "z.ts", line: 9 }, moved: false },
    { name: "(d) no line stays", finding: { severity: "major", file: "a.ts" }, moved: false },
    { name: "(d) no file stays", finding: { severity: "major", line: 3 }, moved: false },
  ];
  for (const item of cases) {
    test(item.name, () => {
      expect(
        movesAsPreExisting(
          { severity: item.finding.severity, file: item.finding.file, line: item.finding.line },
          own,
          previous,
          id,
        ),
      ).toBe(item.moved);
    });
  }
  test("a first review has no previous findings, so rule (b) never applies", () => {
    expect(
      movesAsPreExisting({ severity: "major", file: "a.ts", line: 190 }, own, [], id),
    ).toBe(true);
  });
  test("fixedCount counts previous findings with no blocking finding near them", () => {
    expect(fixedCount(previous, [{ severity: "major", file: "a.ts", line: 195 }], id)).toBe(0);
    expect(fixedCount(previous, [{ severity: "major", file: "a.ts", line: 10 }], id)).toBe(1);
  });
});

/** A one-file diff whose hunks are given as `[old start, [lines]]`. */
function patch(file: string, hunks: readonly (readonly string[])[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    ...hunks.map((hunk, index) => [`@@ -${index * 20 + 1},3 +${index * 20 + 1},3 @@`, ...hunk].join("\n")),
    "",
  ].join("\n");
}

describe("increment", () => {
  test("a hunk that is a subset of a previous hunk is new", () => {
    const previous = patch("f", [["+five", "+six", " ctx"]]);
    const current = patch("f", [["+five", " ctx"]]);
    const result = incrementOf(filePatches(previous), filePatches(current));
    expect(result.added).toContain("+five");
    expect(result.removed).toContain("+six");
  });
  const one = ["+added one", " ctx"];
  const two = ["-old two", "+new two", " ctx"];
  const cases: readonly {
    readonly name: string;
    readonly previous: string;
    readonly current: string;
    readonly added: string[];
    readonly removed: string[];
  }[] = [
    { name: "no change since the previous review", previous: patch("f", [one]), current: patch("f", [one]), added: [], removed: [] },
    { name: "a hunk added", previous: patch("f", [one]), current: patch("f", [one, two]), added: ["-old two", "+new two"], removed: [] },
    { name: "a line changed inside a hunk", previous: patch("f", [one]), current: patch("f", [["+changed one", " ctx"]]), added: ["+changed one"], removed: ["+added one"] },
    { name: "a delete-only rework changes its hunk", previous: patch("f", [one]), current: patch("f", [["+added one", "-gone", " ctx"]]), added: ["+added one", "-gone"], removed: ["+added one"] },
    { name: "a reverted hunk is listed as removed", previous: patch("f", [one, two]), current: patch("f", [one]), added: [], removed: ["-old two", "+new two"] },
    { name: "a whole file reverted", previous: patch("f", [one]), current: "", added: [], removed: ["+added one"] },
    {
      name: "main changes the same file near the change: only context differs",
      previous: patch("f", [["+added one", " ctx old from main"]]),
      current: patch("f", [["+added one", " ctx new from main"]]),
      added: [],
      removed: [],
    },
    {
      name: "a main-only merge: the own diff is the same",
      previous: patch("f", [one]),
      current: patch("f", [one]),
      added: [],
      removed: [],
    },
    { name: "a hunk in a new file", previous: patch("f", [one]), current: patch("f", [one]) + patch("g", [two]), added: ["-old two", "+new two"], removed: [] },
  ];
  for (const item of cases) {
    test(item.name, () => {
      const result = incrementOf(filePatches(item.previous), filePatches(item.current));
      const lines = (text: string) =>
        text.split("\n").filter((line) => /^[+-][^+-]/.test(line) || line === "-gone");
      expect(lines(result.added)).toEqual(item.added);
      expect(lines(result.removed)).toEqual(item.removed);
    });
  }
});

describe("review settings by round", () => {
  const reviewer = {
    use: "h/agent",
    args: ["big"],
    timeoutSecs: 600,
    first: { args: ["small"], timeoutSecs: 900 },
  };
  test("only a first review reads the first block, value by value", () => {
    const first = reviewSettingsOf("first", reviewer, true);
    expect(first).toEqual({
      round: "first",
      use: "h/agent",
      args: ["small"],
      timeoutSecs: 900,
      sources: { use: "default", args: "first", timeoutSecs: "first", stallSecs: "default" },
    });
    for (const kind of ["rework", "reverify"] as const) {
      const later = reviewSettingsOf(kind, reviewer, false);
      expect(later.round).toBe("rework");
      expect(later.args).toEqual(["big"]);
      expect(later.timeoutSecs).toBe(600);
      expect(later.sources.args).toBe("default");
    }
  });
  test("without a first block every value is the default's", () => {
    const used = reviewSettingsOf("first", { use: "h/agent", args: [], timeoutSecs: 600 }, true);
    expect(used.sources).toEqual({ use: "default", args: "default", timeoutSecs: "default", stallSecs: "default" });
  });
});
