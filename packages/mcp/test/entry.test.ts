import { expect, test } from "bun:test";
import * as mcp from "../src/index.ts";
import { homeFromArgs } from "../src/stdio.ts";
import { CHANNEL_NOTIFY_KINDS, DEFAULT_MCP_CHANNEL, defaultOperadHome } from "@operad-io/engine";

test("the package entry point loads and the engine exports the channel config it needs", () => {
  expect(typeof mcp.startClaudeChannel).toBe("function");
  expect(typeof mcp.runMcpServer).toBe("function");
  expect(CHANNEL_NOTIFY_KINDS).toEqual(["waiting", "ended", "loop", "changes"]);
  expect(DEFAULT_MCP_CHANNEL.notify).toEqual(["waiting", "ended", "loop"]);
});

test("the stdio program takes --home, and the configured home without it", () => {
  expect(homeFromArgs(["--home", "/tmp/some-home"])).toBe("/tmp/some-home");
  expect(homeFromArgs(["--other", "x"])).toBe(defaultOperadHome());
  expect(homeFromArgs(["--home"])).toBe(defaultOperadHome());
});

test("with no mcp config the policy allows no action; the configured lists decide", async () => {
  const { actionMayRun, mcpPolicy } = await import("../src/policy.ts");
  const none = mcpPolicy(undefined);
  expect(actionMayRun(none, { name: "chat:close", confirm: true })).toBe(false);
  expect(actionMayRun(none, { name: "dev:rework", confirm: false })).toBe(false);
  const policy = mcpPolicy({
    channel: DEFAULT_MCP_CHANNEL,
    actions: ["chat:close", "dev:merge"],
    confirmActions: ["chat:close"],
  });
  expect(actionMayRun(policy, { name: "chat:close", confirm: true })).toBe(true);
  expect(actionMayRun(policy, { name: "dev:merge", confirm: true })).toBe(false);
  expect(actionMayRun(policy, { name: "dev:rework", confirm: false })).toBe(false);
});
