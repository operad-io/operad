/**
 * Enables or disables one plugin and stops just before the rename until the
 * parent releases both writers. The temporary path is written to `ready` so
 * the parent can see whether two writers shared one temporary file.
 * Usage: bun config-two-writers-child.ts <home> <plugin> <ready> <go>
 */
import { writeFileSync } from "node:fs";
import { waitForFile } from "@operad-io/engine/testing";
import { setPluginEnabled } from "../../src/index.ts";

const [home, name, ready, go] = process.argv.slice(2);
if (home === undefined || name === undefined || ready === undefined || go === undefined) {
  throw new Error("usage: config-two-writers-child <home> <plugin> <ready> <go>");
}
await setPluginEnabled(home, name, false, { optional: {} }, {
  beforeRename: async (temporary) => {
    writeFileSync(ready, temporary);
    await waitForFile(go);
  },
});
