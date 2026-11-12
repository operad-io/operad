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
