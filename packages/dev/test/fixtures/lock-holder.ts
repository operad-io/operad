/** A child that takes the repository lock and holds it briefly. */

import { appendFileSync } from "node:fs";
import { withRepositoryLock } from "../../src/lock.ts";

const [repository, result] = process.argv.slice(2);
if (repository === undefined || result === undefined) {
  console.error("usage: lock-holder <repository> <result>");
  process.exit(2);
}

await withRepositoryLock(repository, async () => {
  appendFileSync(result, `start ${process.pid}\n`);
  await Bun.sleep(25);
  appendFileSync(result, `end ${process.pid}\n`);
});
