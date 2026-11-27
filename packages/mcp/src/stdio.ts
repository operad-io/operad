/**
 * The MCP server as a program a harness starts:
 * `bun stdio.ts [--home <dir>] [--optional <json>] [--stand-ins <json>]`.
 * It is `operad mcp` without the `operad` command, for a harness that is given
 * the tools as a server to start (the home is `OPERAD_HOME` when no `--home`).
 */

import { defaultOperadHome, parseOptionalPlugins } from "@operad-io/engine";
import { runMcpServer } from "./server.ts";

/** The home `--home` names, or the configured default. */
export function homeFromArgs(args: readonly string[]): string {
  const at = args.indexOf("--home");
  if (at < 0) return defaultOperadHome();
  return args[at + 1] ?? defaultOperadHome();
}

/** The offered plugins `--optional <json>` lists; undefined without it. */
export function optionalFromArgs(args: readonly string[]): Readonly<Record<string, string>> | undefined {
  const at = args.indexOf("--optional");
  return at < 0 ? undefined : parseOptionalPlugins(args[at + 1]);
}

/** The stand-ins `--stand-ins <json>` lists; undefined without it. */
export function standInsFromArgs(args: readonly string[]): Readonly<Record<string, string>> | undefined {
  const at = args.indexOf("--stand-ins");
  return at < 0 ? undefined : parseOptionalPlugins(args[at + 1]);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  await runMcpServer({
    home: homeFromArgs(args),
    cwd: process.cwd(),
    optional: optionalFromArgs(args),
    standIns: standInsFromArgs(args),
  });
}
