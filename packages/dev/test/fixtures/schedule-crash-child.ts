/**
 * Runs one scheduler tick in a real child process and kills it in the kernel's
 * start handler, after `claimTaskStart` wrote the claim and before the queued
 * start became a run. The parent proves the next tick recovers the claim.
 */

import { FilePluginStore, PluginRegistry } from "@operad-io/engine";
import { createDevPlugin } from "../../src/index.ts";

const [storeRoot, repository] = process.argv.slice(2);
if (storeRoot === undefined || repository === undefined) {
  throw new Error("usage: schedule-crash-child <store> <repository>");
}

const store = new FilePluginStore({ root: storeRoot });
const registry = new PluginRegistry([createDevPlugin()], {
  home: storeRoot,
  cwd: repository,
  store,
  // The kernel records a queued start here. Killing before it returns leaves
  // the claim on disk with no run, exactly the crash window under test.
  onStartRun: () => {
    process.kill(process.pid, "SIGKILL");
  },
});

await registry.tick();
