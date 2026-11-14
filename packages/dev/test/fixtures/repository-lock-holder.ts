/** A child that holds a repository's dev lock until the test releases it. */

import { writeSync } from "node:fs";
import { withRepositoryLock } from "../../src/lock.ts";

const repository = process.argv[2];
if (repository === undefined) {
  console.error("usage: repository-lock-holder <repository>");
  process.exit(2);
}

await withRepositoryLock(repository, async () => {
  // The parent reads this pipe line instead of watching a file, so no start can
  // land between its check and its reader being ready.
  writeSync(1, `start ${process.pid}\n`);
  for await (const _line of console) break;
});
