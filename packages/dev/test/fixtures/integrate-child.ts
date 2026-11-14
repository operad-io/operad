/**
 * Runs `dev/integrate` or `dev/cleanup` in a real child process and kills it at
 * a named point, so the parent can prove a rerun of the step is the same as a
 * first run.
 *
 * The point is `push` (right after the push), `prepare` (after the main clone
 * moved, before a prepare line ends) or one of the points in
 * `integrateTestHooks.at`. For `hook-ran` the child dies after the Nth hook, `N`
 * being the fifth argument.
 */

import { SqlitePluginStore, PluginRegistry } from "@operad-io/engine";
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

// With OPERAD_TEST_HOLD the child holds its turn after it is taken, says so, and
// goes on when the parent writes a line: the parent queues other tasks behind it
// first, so the child merges them in one batch. OPERAD_TEST_HOME names the
// home the parent's queue lives in.
if (process.env.OPERAD_TEST_HOLD !== undefined) {
  integrateTestHooks.turnTaken = async () => {
    process.stdout.write("held\n");
    for await (const _line of console) break;
  };
}

const die = (): void => {
  process.kill(process.pid, "SIGKILL");
};
if (point === "push") {
  integrateTestHooks.afterPush = die;
} else if (point === "prepare") {
  // Die after the clone fast-forwarded and before the first prepare line ends.
  integrateTestHooks.runCommand = async () => {
    die();
    return { ok: true, out: "" };
  };
} else {
  let seen = 0;
  integrateTestHooks.at = (reached) => {
    if (reached !== point) return;
    seen += 1;
    if (seen >= Number(nth)) die();
  };
}

const store = new SqlitePluginStore({ root: storeRoot });
const registry = new PluginRegistry([createDevPlugin(), createShellPlugin()], {
  home: process.env.OPERAD_TEST_HOME ?? storeRoot,
  cwd: repository,
  store,
});

await registry.runStep(step, {}, {
  runId,
  object: { type: "task", id: taskKey, data: {} },
});
