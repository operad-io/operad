/**
 * Runs `bot mcp` the way the CLI does: no input is handed to the command, so it
 * reads what is piped to this process. `bun run-mcp-command.ts <home> <bot> <name>`.
 */
import { MemoryPluginStore, type CommandContext } from "@operad-io/engine";
import { runMcpCommand } from "../src/index.ts";

const [home = "", bot = "", name = ""] = process.argv.slice(2);
const store = new MemoryPluginStore({ root: `${home}/store` });
const ctx = { store, home, cwd: home } as unknown as CommandContext;
process.stdout.write(await runMcpCommand(ctx, [bot, name]));
process.exit(0);
