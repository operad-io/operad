import { expect, test } from "bun:test";
import { ENGINE_VERSION } from "../src/index.ts";

test("the engine package loads", () => {
  expect(ENGINE_VERSION).toBe("0.0.0");
});
