import { expect, test } from "bun:test";
import { ENGINE_VERSION } from "../src/index.ts";
import pkg from "../package.json" with { type: "json" };

test("the engine package loads", () => {
  expect(ENGINE_VERSION).toBe(pkg.version);
});
