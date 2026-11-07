/**
 * Runs one task action in its own process, after the parent closes stdin, and
 * appends the answer it gave (if any) to a file. The parent starts two of these
 * on the same waiting task to prove exactly one action wins.
 */

import { appendFileSync } from "node:fs";
import { FilePluginStore, PluginRegistry } from "@operad-io/engine";
import { createDevPlugin } from "../../src/index.ts";

const [storeRoot, repository, taskKey, action, argsJson, answersPath] =
  process.argv.slice(2);
if (
  storeRoot === undefined ||
  repository === undefined ||
  taskKey === undefined ||
  action === undefined ||
  argsJson === undefined ||
  answersPath === undefined
) {
  throw new Error(
    "usage: lead-action-child <store> <repository> <task> <action> <args> <answers>",
  );
}

const store = new FilePluginStore({ root: storeRoot });
const registry = new PluginRegistry([createDevPlugin()], {
  home: storeRoot,
  cwd: repository,
  store,
  onAnswer: async (_runId, choice) => {
    appendFileSync(answersPath, `${action}:${choice}\n`);
  },
});

const object = await store.get("task", taskKey);
if (object === undefined) throw new Error(`no task ${taskKey}`);

// Both children start their action together: wait for the parent's go.
await Bun.stdin.text();

try {
  await registry.runAction(action, JSON.parse(argsJson), {
    object,
    runId: "run-1",
    actor: { via: "test", id: action },
  });
  console.log("won");
} catch (error) {
  console.log(`lost: ${error instanceof Error ? error.message : String(error)}`);
}
