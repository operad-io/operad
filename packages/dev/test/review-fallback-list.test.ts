import { describe, expect, test } from "bun:test";
import { nextReviewAction } from "../src/gate.ts";
import type { ReviewRunRecord } from "../src/model.ts";
import { validateDevSettings } from "../src/settings.ts";

const entry = (model: string) => ({ use: "x/agent", args: ["--model", model] });
const run = (
  role: "primary" | "fallback",
  outcome: ReviewRunRecord["outcome"],
  fallbackIndex?: number,
): ReviewRunRecord =>
  ({ role, outcome, model: "m", reason: "initial", ...(fallbackIndex === undefined ? {} : { fallbackIndex }) }) as ReviewRunRecord;

describe("the next review run with a list of fallbacks", () => {
  test("the second fallback is retried after the first failed twice", () => {
    const runs = [run("primary", "unavailable"), run("fallback", "invalid", 0), run("fallback", "invalid", 0), run("fallback", "invalid", 1)];
    expect(nextReviewAction(runs, [entry("a"), entry("b")])).toMatchObject({ role: "fallback", reason: "retry", fallbackIndex: 1 });
  });

  test("a recorded fallback index past the end of a shortened list ends the round", () => {
    const runs = [run("primary", "unavailable"), run("fallback", "timed_out", 1)];
    expect(nextReviewAction(runs, [entry("a")])).toBe("failed");
  });

  test("a failed fallback passes to the next entry", () => {
    const runs = [run("primary", "unavailable"), run("fallback", "failed", 0)];
    expect(nextReviewAction(runs, [entry("a"), entry("b")])).toMatchObject({ role: "fallback", fallbackIndex: 1 });
  });
});

describe("reviewer.fallback as a list", () => {
  test("an empty list is refused and an entry's fields are named by index", () => {
    expect(() => validateDevSettings({ name: "x", reviewer: { fallback: [] } })).toThrow(/reviewer\.fallback: must not be an empty list/);
    expect(() => validateDevSettings({ name: "x", reviewer: { fallback: [entry("a"), { use: "" }] } })).toThrow(/reviewer\.fallback\[1\]\.use/);
    expect(() => validateDevSettings({ name: "x", reviewer: { fallback: [{ use: "a", args: "no" }] } })).toThrow(/reviewer\.fallback\[0\]\.args/);
  });
});
