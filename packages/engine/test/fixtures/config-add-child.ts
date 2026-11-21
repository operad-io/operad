/**
 * Adds a plugin entry to `config.json` and stops just before the rename: the
 * parent kills this process once it reads "ready" on stdout.
 * Usage: bun config-add-child.ts <home> <plugin> <module>
 */
import { addPluginEntry } from "../../src/index.ts";

const [home, name, module] = process.argv.slice(2);
if (home === undefined || name === undefined || module === undefined) {
  throw new Error("usage: config-add-child <home> <plugin> <module>");
}
await addPluginEntry(home, name, module, {
  beforeRename: async () => {
    process.stdout.write("ready\n");
    await new Promise<void>(() => undefined);
  },
});
process.stdout.write("done\n");
