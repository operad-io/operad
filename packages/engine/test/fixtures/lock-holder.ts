/** A child that takes a lock file and holds it briefly. */

import { appendFileSync } from "node:fs";
import { withLockFile } from "../../src/platform/index.ts";

const [lockPath, result] = process.argv.slice(2);
if (lockPath === undefined || result === undefined) {
  console.error("usage: lock-holder <lock path> <result>");
  process.exit(2);
}

await withLockFile(lockPath, async () => {
  appendFileSync(result, `start ${process.pid}\n`);
  await Bun.sleep(25);
  appendFileSync(result, `end ${process.pid}\n`);
});
