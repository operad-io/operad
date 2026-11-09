import { describe, expect, test } from "bun:test";
import {
  approvedWordsOf,
  newWordsOf,
  unapprovedWords,
  wordsReason,
} from "../src/words.ts";

describe("new words", () => {
  test("the New words line names words, and none names nothing", () => {
    expect(newWordsOf("Done.\nNew words: none")).toEqual([]);
    expect(newWordsOf("Done.")).toEqual([]);
    expect(newWordsOf("Done.\nNew words: alpha, `beta`,  alpha")).toEqual(["alpha", "beta"]);
  });

  test("Approved words lines of a brief add up", () => {
    expect(approvedWordsOf("Do it.\nApproved words: a, b\nApproved words: c")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("a word is unapproved unless a brief or the docs have it", () => {
    expect(unapprovedWords(["A", "b", "c"], ["a"], "text with b inside")).toEqual(["c"]);
    expect(wordsReason(["x", "y"])).toBe("new words need approval: x, y");
  });
});
