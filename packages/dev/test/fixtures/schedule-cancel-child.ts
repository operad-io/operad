/**
 * Cancels a task from a second process while another process holds its claim.
 * The parent uses this to prove a running flow cannot write a cancelled task
 * back and that the queued start ends the run as cancelled.
 */

import { createShellPlugin } from "@operad-io/shell";
import { FilePluginStore, PluginRegistry } from "@operad-io/engine";
import { createPoolPlugin } from "@operad-io/pool";
import { createDevPlugin } from "../../src/index.ts";

const [storeRoot, repository, taskKey] = process.argv.slice(2);
if (storeRoot === undefined || repository === undefined || taskKey === undefined) {
  throw new Error("usage: schedule-cancel-child <store> <repository> <task>");
}

const store = new FilePluginStore({ root: storeRoot });
const registry = new PluginRegistry([createDevPlugin(), createPoolPlugin(), createShellPlugin()], {
  home: storeRoot,
  cwd: repository,
  store,
});

const object = await store.get("task", taskKey);
if (object === undefined) throw new Error(`no task ${taskKey}`);

await registry.runAction("dev/cancel", {}, {
  object,
  actor: { via: "test", id: "cancel-child" },
});
