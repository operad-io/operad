/**
 * Enables a plugin in `config.json` and stops just before the rename: the
 * parent kills this process once it reads "ready" on stdout. When the write
 * never reaches the atomic helper's hook the process prints "done" and ends,
 * so the parent can tell a direct write from an atomic one.
 * Usage: bun config-enable-child.ts <home> <plugin>
 */
import { setPluginEnabled } from "../../src/index.ts";

const [home, name] = process.argv.slice(2);
if (home === undefined || name === undefined) {
  throw new Error("usage: config-enable-child <home> <plugin>");
}
await setPluginEnabled(home, name, false, { optional: {} }, {
  beforeRename: async () => {
    process.stdout.write("ready\n");
    await new Promise<void>(() => undefined);
  },
});
process.stdout.write("done\n");
