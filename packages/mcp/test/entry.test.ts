import { expect, test } from "bun:test";
import * as mcp from "../src/index.ts";
import { CHANNEL_NOTIFY_KINDS, DEFAULT_MCP_CHANNEL } from "@operad-io/engine";

test("the package entry point loads and the engine exports the channel config it needs", () => {
  expect(typeof mcp.startClaudeChannel).toBe("function");
  expect(typeof mcp.runMcpServer).toBe("function");
  expect(CHANNEL_NOTIFY_KINDS).toEqual(["waiting", "ended", "loop", "changes"]);
  expect(DEFAULT_MCP_CHANNEL.notify).toEqual(["waiting", "ended", "loop"]);
});
