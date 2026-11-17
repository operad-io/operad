import { describe, expect, test } from "bun:test";
import { CLAUDE_MODELS, createClaudeHarnessPlugin } from "../src/index.ts";

describe("the models claude declares", () => {
  test("a list a chat may pick from, with the default among them", () => {
    const { models } = createClaudeHarnessPlugin();
    expect(models.list.length).toBeGreaterThan(0);
    expect(models.list).toContain(models.default);
  });

  test("each model's context window is declared, including the 1M variants", () => {
    expect(CLAUDE_MODELS.windows.sonnet).toBe(200_000);
    expect(CLAUDE_MODELS.windows.opus).toBe(200_000);
    expect(CLAUDE_MODELS.windows.haiku).toBe(200_000);
    expect(CLAUDE_MODELS.windows["sonnet[1m]"]).toBe(1_000_000);
    expect(CLAUDE_MODELS.windows["opus[1m]"]).toBe(1_000_000);
  });
});
