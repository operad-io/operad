/**
 * The MCP server as a program a harness starts: `bun stdio.ts [--home <dir>]`.
 * It is `operad mcp` without the `operad` command, for a harness that is given
 * the tools as a server to start (the home is `OPERAD_HOME` when no `--home`).
 */

import { defaultOperadHome } from "@operad-io/engine";
import { runMcpServer } from "./server.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--home");
const home = at >= 0 ? args[at + 1] : undefined;

await runMcpServer({ home: home ?? defaultOperadHome(), cwd: process.cwd() });
