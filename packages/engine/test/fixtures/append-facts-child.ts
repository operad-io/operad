/**
 * A writer for the concurrent-append test: it opens the plugin store, tells the
 * test it is ready, waits for the go file, then appends facts as fast as it can.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqlitePluginStore } from "../../src/index.ts";
import { waitForFile } from "../wait-for-file.ts";

const root = process.argv[2] ?? "";
const name = process.argv[3] ?? "a";
const count = Number(process.argv[4] ?? "20");
const store = new SqlitePluginStore({ root });

writeFileSync(join(root, `ready-${name}`), "");
await waitForFile(join(root, "go"));

for (let index = 0; index < count; index += 1) {
  store.append({
    type: "test.appended",
    cause: `child-${name}`,
    data: { name, index },
  });
}
