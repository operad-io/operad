/** A child that holds a repository's dev lock until the test releases it. */

import { writeSync } from "node:fs";
import { withRepositoryLock } from "../../src/lock.ts";

const repository = process.argv[2];
const home = process.argv[3];
if (repository === undefined || home === undefined) {
  console.error("usage: repository-lock-holder <repository> <home>");
  process.exit(2);
}

await withRepositoryLock(
  repository,
  async () => {
    // The parent reads this pipe line instead of watching a file, so no start can
    // land between its check and its reader being ready.
    writeSync(1, `start ${process.pid}\n`);
    // A parent that dies before releasing us must not hold the lock until the
    // whole suite times out; this is the backstop, not the normal way to end.
    const backstop = setTimeout(() => process.exit(3), 15_000);
    try {
      for await (const _line of console) break;
    } finally {
      clearTimeout(backstop);
    }
  },
  { home },
);
