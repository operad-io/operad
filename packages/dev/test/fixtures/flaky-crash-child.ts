/**
 * Counts a test that passed on rerun and kills itself after the decision to
 * propose a task and before the task exists. The parent proves a later call
 * proposes exactly one.
 */

import { FilePluginStore } from "@operad-io/engine";
import { flakyTestHooks, trackFlakyTests } from "../../src/flaky.ts";
import { repositoryData } from "../../src/model.ts";
import { findRepository } from "../../src/service.ts";

const [storeRoot, name, test, log] = process.argv.slice(2);
if (storeRoot === undefined || name === undefined || test === undefined || log === undefined) {
  throw new Error("usage: flaky-crash-child <store> <repository> <test> <log>");
}

const store = new FilePluginStore({ root: storeRoot });
const found = await findRepository(store, name);
if (found === undefined) throw new Error(`no repository ${name}`);
flakyTestHooks.beforePropose = () => {
  process.kill(process.pid, "SIGKILL");
};
await trackFlakyTests({
  store,
  repository: repositoryData(found.data),
  taskId: "T-0001-child",
  names: [test],
  log,
  threshold: 1,
});
