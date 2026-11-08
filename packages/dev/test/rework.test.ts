import { describe, expect, test } from "bun:test";
import {
  addedLinesOf,
  fixedCount,
  intersect,
  movesAsPreExisting,
  previousReview,
  restrictPatch,
  type PreviousFinding,
} from "../src/rework.ts";

const id = (path: string): string => path;

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

describe("increment", () => {
  test("a pure deletion marks the lines on either side of the cut", () => {
    const map = addedLinesOf("+++ b/f\n@@ -7,1 +6,0 @@\n");
    expect([...(map.get("f") ?? [])]).toEqual([6, 7]);
  });
  test("only a review of an earlier attempt is followed", () => {
    const entry = { attempt: 1, round: 1, sha: "a", blocking: [] };
    expect(previousReview([entry], "b", 1)).toBeUndefined();
    expect(previousReview([entry], "b", 2)).toBe(entry);
    expect(previousReview([entry], "a", 2)).toBeUndefined();
  });
  test("restrictPatch keeps only hunks that hold a wanted line", () => {
    const patch = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,3 @@",
      " a",
      "+b",
      " c",
      "@@ -20,2 +21,3 @@",
      " x",
      "+y",
      " z",
      "",
    ].join("\n");
    const kept = restrictPatch(patch, new Set([22]));
    expect(kept).toContain("+y");
    expect(kept).not.toContain("+b");
    expect(kept).toContain("+++ b/f");
    expect(restrictPatch(patch, new Set([99]))).toBe("");
  });
  test("intersect keeps lines both sides hold", () => {
    const left = addedLinesOf("+++ b/f\n@@ -0,0 +1,3 @@\n");
    const right = addedLinesOf("+++ b/f\n@@ -0,0 +2,3 @@\n");
    expect([...(intersect(left, right).get("f") ?? [])]).toEqual([2, 3]);
  });
});
