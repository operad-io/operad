/**
 * The MCP server as a program a harness starts: `bun stdio.ts [--home <dir>]`.
 * It is `operad mcp` without the `operad` command, for a harness that is given
 * the tools as a server to start (the home is `OPERAD_HOME` when no `--home`).
 */

import { defaultOperadHome } from "@operad-io/engine";
import { runMcpServer } from "./server.ts";

/** The home `--home` names, or the configured default. */
export function homeFromArgs(args: readonly string[]): string {
  const at = args.indexOf("--home");
  if (at < 0) return defaultOperadHome();
  return args[at + 1] ?? defaultOperadHome();
}

if (import.meta.main) {
  await runMcpServer({
    home: homeFromArgs(process.argv.slice(2)),
    cwd: process.cwd(),
  });
}
