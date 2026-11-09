/**
 * Runs `dev/integrate` or `dev/cleanup` in a real child process and kills it at
 * a named point, so the parent can prove a rerun of the step is the same as a
 * first run.
 *
 * The point is `push` (right after the push) or one of the points in
 * `integrateTestHooks.at`. For `hook-ran` the child dies after the Nth hook, `N`
 * being the fifth argument.
 */

import { FilePluginStore, PluginRegistry } from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import { createDevPlugin, integrateTestHooks } from "../../src/index.ts";

const [storeRoot, repository, taskKey, runId, point = "push", step = "dev/integrate", nth = "1"] =
  process.argv.slice(2);
if (
  storeRoot === undefined ||
  repository === undefined ||
  taskKey === undefined ||
  runId === undefined
) {
  throw new Error("usage: integrate-child <store> <repository> <task> <run> [point] [step] [n]");
}

const die = (): void => {
  process.kill(process.pid, "SIGKILL");
};
if (point === "push") {
  integrateTestHooks.afterPush = die;
} else {
  let seen = 0;
  integrateTestHooks.at = (reached) => {
    if (reached !== point) return;
    seen += 1;
    if (seen >= Number(nth)) die();
  };
}

const store = new FilePluginStore({ root: storeRoot });
const registry = new PluginRegistry([createDevPlugin(), createShellPlugin()], {
  home: storeRoot,
  cwd: repository,
  store,
});

await registry.runStep(step, {}, {
  runId,
  object: { type: "task", id: taskKey, data: {} },
});
