/** A child that takes a lock file and holds it until the test acknowledges it. */

import { appendFileSync, existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { withLockFile } from "../../src/platform/index.ts";

const [lockPath, result] = process.argv.slice(2);
if (lockPath === undefined || result === undefined) {
  console.error("usage: lock-holder <lock path> <result>");
  process.exit(2);
}

/** Resolved by a file event, so the test decides when the section ends. */
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

/** The test writes this after it has seen our `start` line. */
const release = join(dirname(result), `go-${process.pid}`);

await withLockFile(lockPath, async () => {
  appendFileSync(result, `start ${process.pid}\n`);
  await waitForFile(release);
  appendFileSync(result, `end ${process.pid}\n`);
});
