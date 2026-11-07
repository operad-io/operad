/**
 * Answers one question from its own process. Exit 0: the answer was taken;
 * 3: refused as already answered; 4: anything else.
 */
import {
  openConfigLog,
  readConfig,
  recordAnswer,
} from "../../src/index.ts";

const [home, runId, waitId, choice] = process.argv.slice(2);
if (home === undefined || runId === undefined || waitId === undefined || choice === undefined) {
  throw new Error("usage: answer-child <home> <run id> <wait id> <choice>");
}
const log = openConfigLog(await readConfig(home));
let code = 0;
try {
  await recordAnswer({
    log,
    runId,
    waitId,
    choice,
    actor: { via: "child", id: `answer-${process.pid}` },
  });
} catch (error) {
  code = /already answered/.test(String(error)) ? 3 : 4;
  if (code === 4) console.error(String(error));
}
await log.close();
process.exit(code);
