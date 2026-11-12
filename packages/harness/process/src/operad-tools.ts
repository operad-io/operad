/**
 * Operad's own tools for a harness: the `operadTools` param of an `agent` step
 * names the home whose tools the agent may call. A harness that starts MCP
 * servers starts `operad`'s as a program (`serverCommand`); one that takes
 * tools in its own process opens them (`@operad-io/mcp`, `openMcpTools`). The
 * agent never runs the `operad` command.
 */

import { fileURLToPath } from "node:url";
import { isRecord } from "@operad-io/engine";

/** The name the tools go by in a harness: the server's name, and the prefix claude gives its tools. */
export const OPERAD_SERVER = "operad";

/** The prefix of an MCP tool's name in claude. */
export const OPERAD_TOOL_PREFIX = `mcp__${OPERAD_SERVER}__`;

/** What the `operadTools` param holds. */
export interface OperadTools {
  /** The operad home the tools read and write. */
  readonly home: string;
}

/** The tools a step's params ask for, or undefined when they ask for none. */
export function operadToolsOf(value: unknown): OperadTools | undefined {
  if (!isRecord(value)) return undefined;
  const home = value.home;
  return typeof home === "string" && home.length > 0 ? { home } : undefined;
}

/** The program that serves the tools on stdio, and its arguments. */
export function serverCommand(tools: OperadTools): { readonly command: string; readonly args: readonly string[] } {
  const script = fileURLToPath(import.meta.resolve("@operad-io/mcp/stdio"));
  return { command: process.execPath, args: [script, "--home", tools.home] };
}

/** A server a bot's settings list, started as this command; its name is the one its tools go by. */
export interface MountedServer {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The `mcpServers` param of an `agent` step: other MCP servers to start for
 * the agent, by name. The name of operad's own server is not available.
 */
export function mountedServersOf(value: unknown): Readonly<Record<string, MountedServer>> | undefined {
  if (!isRecord(value)) return undefined;
  const found: Record<string, MountedServer> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (name === OPERAD_SERVER || name.length === 0 || name.includes("__")) continue;
    if (!isRecord(entry) || typeof entry.command !== "string" || entry.command.length === 0) continue;
    const args = Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === "string") : [];
    found[name] = { command: entry.command, args };
  }
  return Object.keys(found).length === 0 ? undefined : found;
}
