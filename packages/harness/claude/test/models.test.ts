import { describe, expect, test } from "bun:test";
import { createClaudeHarnessPlugin } from "../src/index.ts";

describe("the models claude declares", () => {
  test("a list a chat may pick from, with the default among them", () => {
    const { models } = createClaudeHarnessPlugin();
    expect(models.list.length).toBeGreaterThan(0);
    expect(models.list).toContain(models.default);
  });
});
