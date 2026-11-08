import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewGradingError, readReviewGrading } from "../src/index.ts";

const roots: string[] = [];
function repo(content?: string): string {
  const root = mkdtempSync(join(tmpdir(), "review-grading-"));
  roots.push(root);
  if (content !== undefined) {
    mkdirSync(join(root, ".operad"));
    writeFileSync(join(root, ".operad", "review.json"), content);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readReviewGrading", () => {
  test("a missing file gives an empty grading", () => {
    expect(readReviewGrading(repo(), "dev")).toEqual({});
  });

  test("the default alone applies to a flow with no entry", () => {
    const root = repo(
      JSON.stringify({
        default: { levels: { major: "M" }, rules: ["r"], fixLevel: "minor" },
      }),
    );
    expect(readReviewGrading(root, "dev")).toEqual({
      levels: { major: "M" },
      rules: ["r"],
      fixLevel: "minor",
    });
  });

  test("a flow entry overrides the default field by field", () => {
    const root = repo(
      JSON.stringify({
        default: {
          levels: { critical: "C0", major: "M0" },
          rules: ["r0"],
          fixLevel: "minor",
        },
        flows: {
          dev: { levels: { major: "M1" }, fixLevel: "critical" },
          other: { rules: ["x"] },
        },
      }),
    );
    expect(readReviewGrading(root, "dev")).toEqual({
      levels: { critical: "C0", major: "M1" },
      rules: ["r0"],
      fixLevel: "critical",
    });
    expect(readReviewGrading(root, "other")).toEqual({
      levels: { critical: "C0", major: "M0" },
      rules: ["x"],
      fixLevel: "minor",
    });
  });

  test("a flow entry alone works without a default", () => {
    const root = repo(JSON.stringify({ flows: { dev: { rules: ["a", "b"] } } }));
    expect(readReviewGrading(root, "dev")).toEqual({ rules: ["a", "b"] });
    expect(readReviewGrading(root, "x")).toEqual({});
  });

  test.each([
    ["not json", "{", "invalid JSON"],
    ["not an object", "[]", "must be a JSON object"],
    ["unknown top field", '{"x":1}', "$.x"],
    ["bad fixLevel", '{"default":{"fixLevel":"huge"}}', "default.fixLevel"],
    ["bad level text", '{"flows":{"dev":{"levels":{"major":1}}}}', "flows.dev.levels.major"],
    ["unknown level", '{"default":{"levels":{"blocker":"x"}}}', "default.levels.blocker"],
    ["bad rules", '{"default":{"rules":["a",2]}}', "default.rules[1]"],
  ])("an invalid file fails naming the file: %s", (_name, content, detail) => {
    const root = repo(content);
    let caught: unknown;
    try {
      readReviewGrading(root, "dev");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewGradingError);
    const message = (caught as Error).message;
    expect(message).toContain("review.json");
    expect(message).toContain(detail);
  });
});
