import { describe, expect, test } from "bun:test";
import { createPiHarnessPlugin } from "../src/index.ts";

describe("the models pi declares", () => {
  test("a list a chat may pick from, with the default among them", () => {
    const { models } = createPiHarnessPlugin();
    expect(models.list.length).toBeGreaterThan(0);
    expect(models.list).toContain(models.default);
  });
});
