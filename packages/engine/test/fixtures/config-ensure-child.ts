/**
 * Fills the missing plugins section of `config.json` and stops just before the
 * rename: the parent kills this process once it reads "ready" on stdout.
 * Usage: bun config-ensure-child.ts <home>
 */
import { defaultConfig, ensureConfig } from "../../src/index.ts";

const [home] = process.argv.slice(2);
if (home === undefined) {
  throw new Error("usage: config-ensure-child <home>");
}
await ensureConfig(home, defaultConfig(home), {
  beforeRename: async () => {
    process.stdout.write("ready\n");
    await new Promise<void>(() => undefined);
  },
});
process.stdout.write("done\n");
