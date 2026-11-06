/**
 * Runs `dev/integrate` in a real child process and kills it right after the
 * push, so the parent can prove a recovery does not push the candidate again.
 */

import { FilePluginStore, PluginRegistry } from "@operad-io/engine";
import { createDevPlugin, integrateTestHooks } from "../../src/index.ts";

const [storeRoot, repository, taskKey, runId] = process.argv.slice(2);
if (
  storeRoot === undefined ||
  repository === undefined ||
  taskKey === undefined ||
  runId === undefined
) {
  throw new Error("usage: integrate-child <store> <repository> <task> <run>");
}

integrateTestHooks.afterPush = () => {
  process.kill(process.pid, "SIGKILL");
};

const store = new FilePluginStore({ root: storeRoot });
const registry = new PluginRegistry([createDevPlugin()], {
  home: storeRoot,
  cwd: repository,
  store,
});

await registry.runStep("dev/integrate", {}, {
  runId,
  object: { type: "task", id: taskKey, data: {} },
});
