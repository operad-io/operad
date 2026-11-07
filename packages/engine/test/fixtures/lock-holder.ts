/** A child that takes a lock file and holds it until the test acknowledges it. */

import { appendFileSync, writeSync } from "node:fs";
import { withLockFile } from "../../src/platform/index.ts";

const [lockPath, result] = process.argv.slice(2);
if (lockPath === undefined || result === undefined) {
  console.error("usage: lock-holder <lock path> <result>");
  process.exit(2);
}

/** The test writes a line on stdin after it has seen our `start` line. */
await withLockFile(lockPath, async () => {
  appendFileSync(result, `start ${process.pid}\n`);
  // The parent reads this pipe line instead of watching the result file, so a
  // write cannot land between its check and its watcher being ready.
  writeSync(1, `start ${process.pid}\n`);
  for await (const _line of console) break;
  appendFileSync(result, `end ${process.pid}\n`);
});
