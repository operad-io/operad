/**
 * Takes the first turn of a repository's integration queue in a real child
 * process, says so, and holds it until it is killed. The parent proves a
 * killed holder gives its turn back.
 */

import { IntegrationQueue } from "../../src/integration-queue.ts";

const [home, name, path, task] = process.argv.slice(2);
if (home === undefined || name === undefined || path === undefined || task === undefined) {
  throw new Error("usage: queue-child <home> <repository> <path> <task>");
}

const queue = new IntegrationQueue({
  home,
  repository: { name, path },
  task,
  run: "child-run",
  verified: "0".repeat(40),
  message: `Merge work/${task}`,
  say: () => {},
});
await queue.join();
const turn = await queue.turn();
if (turn.kind !== "turn") throw new Error("the child did not get the first turn");
process.stdout.write("held\n");
await new Promise<void>(() => {});
