import { describe, expect, test } from "bun:test";
import { createRadianHarnessPlugin } from "../src/index.ts";

describe("the efforts radian declares", () => {
  test("none: it cannot honour an effort a chat picks", () => {
    expect(createRadianHarnessPlugin().efforts).toEqual({ list: [], default: null });
  });
});
