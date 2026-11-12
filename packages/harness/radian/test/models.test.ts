import { describe, expect, test } from "bun:test";
import { createRadianHarnessPlugin } from "../src/index.ts";

describe("the models radian declares", () => {
  test("none: it cannot honour a model a chat picks", () => {
    expect(createRadianHarnessPlugin().models).toEqual({ list: [], default: null });
  });
});
