import { describe, expect, test } from "bun:test";
import { createClaudeHarnessPlugin, CLAUDE_EFFORTS } from "../src/index.ts";
import { EFFORT_LEVELS } from "../src/protocol.ts";

describe("the efforts claude declares", () => {
  test("its effort levels, a default among them, and its own flag", () => {
    const { efforts } = createClaudeHarnessPlugin();
    expect(efforts.list).toEqual([...EFFORT_LEVELS]);
    expect(efforts.default).toBe("medium");
    expect(efforts.list).toContain(efforts.default);
    expect(efforts.flag).toBe("--effort");
    expect(efforts).toEqual(CLAUDE_EFFORTS);
  });
});
