import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_LEAD_ACTIONS, INSTALL_ON_ENABLE } from "../src/defaults.ts";

test("the mcp command gets the same install-on-enable list as the other commands", () => {
  // A missing package is only reported as "not installed; run `operad plugin enable`" outside a
  // workspace checkout, so the wiring is checked where the command calls the server.
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const call = /await runMcpServer\(\{[\s\S]*?\}\);/.exec(source)?.[0] ?? "";
  expect(call).toContain("installOnEnable: INSTALL_ON_ENABLE");
  expect(INSTALL_ON_ENABLE).toContain("claude");
});

test("the actions `operad init` writes never include the owner's pause and resume", () => {
  expect(DEFAULT_LEAD_ACTIONS).not.toContain("dev:pause");
  expect(DEFAULT_LEAD_ACTIONS).not.toContain("dev:resume");
});
