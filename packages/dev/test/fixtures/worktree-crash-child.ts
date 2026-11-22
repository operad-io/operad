/**
 * Runs `dev/worktree` for a repository that works in its main clone in a real
 * child process and kills it at one point of the step, so the parent can prove
 * the same run goes on from the state the clone was left in.
 */

import { SqlitePluginStore, PluginRegistry } from "@operad-io/engine";
import { createChatPlugin } from "@operad-io/chat";
import { createDevPlugin, stepTestHooks } from "../../src/index.ts";

const [storeRoot, repository, taskKey, runId, crash] = process.argv.slice(2);
if (
  storeRoot === undefined ||
  repository === undefined ||
  taskKey === undefined ||
  runId === undefined ||
  crash === undefined
) {
  throw new Error(
    "usage: worktree-crash-child <store> <repository> <task> <run> <crash point>",
  );
}

stepTestHooks.branchStep = (point) => {
  if (point === crash) process.kill(process.pid, "SIGKILL");
};

const store = new SqlitePluginStore({ root: storeRoot });
const registry = new PluginRegistry([createChatPlugin(), createDevPlugin()], {
  home: storeRoot,
  cwd: repository,
  store,
});

await registry.runStep("dev/worktree", {}, {
  runId,
  object: { type: "task", id: taskKey, data: {} },
});
