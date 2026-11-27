import { describe, expect, test } from "bun:test";
import { MAX_HELD_CHARACTERS, splitUnfinished } from "../src/index.ts";

describe("where output may be cut", () => {
  test("whole output passes as it is", () => {
    for (const text of [
      "",
      "plain",
      "\u001b[31mred\u001b[0m",
      "\u001b]0;title\u0007after",
      "\u001b]0;title\u001b\\after",
      "\u001bPdata\u001b\\",
      "\u001b(Bx",
      "\u001b7\u001b8",
      "\u001b[12\u0018x",
    ]) {
      expect(splitUnfinished(text)).toEqual([text, ""]);
    }
  });

  test("an unfinished sequence at the end is held", () => {
    for (const held of [
      "\u001b",
      "\u001b[",
      "\u001b[38;5;",
      "\u001b]0;half a title",
      "\u001b]0;title\u001b",
      "\u001bPdata",
      "\u001b(",
    ]) {
      expect(splitUnfinished(`before\u001b[0m${held}`)).toEqual(["before\u001b[0m", held]);
    }
  });

  test("a new escape ends the one before it", () => {
    expect(splitUnfinished("\u001b[1\u001b[2mok")).toEqual(["\u001b[1\u001b[2mok", ""]);
    expect(splitUnfinished("\u001b\u001b[")).toEqual(["\u001b", "\u001b["]);
  });

  test("a sequence longer than the limit is passed on", () => {
    const long = `\u001b]52;c;${"a".repeat(MAX_HELD_CHARACTERS)}`;
    expect(splitUnfinished(long)).toEqual([long, ""]);
  });
});
