/**
 * Records one person answer as another process would, without applying it.
 * `serve` is the only process that may decide what the answer means.
 */

import { openConfigLog, recordAnswer, readConfig } from "../../src/index.ts";

const home = process.argv[2];
const runId = process.argv[3];
const choice = process.argv[4];
if (home === undefined || runId === undefined || choice === undefined) {
  throw new Error("usage: record-answer-child <home> <run id> <choice>");
}

const config = await readConfig(home);
const log = openConfigLog(config);
try {
  await recordAnswer({
    log,
    runId,
    choice,
    ...(process.argv[5] === undefined ? {} : { note: process.argv[5] }),
    actor: { via: "test", id: "child" },
  });
} finally {
  await log.close();
}
