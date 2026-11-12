import { describe, expect, test } from "bun:test";
import { anchoredPattern, rerunCommand } from "../src/rerun.ts";

describe("rerun command", () => {
  test("the pattern is anchored and joins describe names with a space, as bun test -t does", () => {
    expect(anchoredPattern("a > b (c)")).toBe("^a b \\(c\\)$");
    expect(rerunCommand("bun test -t {pattern}", "it's")).toBe("bun test -t '^it'\\''s$'");
    expect(rerunCommand("run {name} {name}", "$x")).toBe("run '$x' '$x'");
  });
});
