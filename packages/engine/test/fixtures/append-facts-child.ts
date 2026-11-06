/**
 * A writer for the concurrent-append test: it opens a JSONL store, tells the
 * test it is ready, waits for the go file, then appends facts as fast as it can.
 */

import { existsSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FilePluginStore } from "../../src/index.ts";

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

const root = process.argv[2] ?? "";
const name = process.argv[3] ?? "a";
const count = Number(process.argv[4] ?? "20");
const store = new FilePluginStore({ root });

writeFileSync(join(root, `ready-${name}`), "");
await waitForFile(join(root, "go"));

for (let index = 0; index < count; index += 1) {
  store.append({
    type: "test.appended",
    cause: `child-${name}`,
    data: { name, index },
  });
}
