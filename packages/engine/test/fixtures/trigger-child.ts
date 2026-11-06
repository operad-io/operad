/** Receives one event in a child process, for the concurrent-receive test. */

import {
  Kernel,
  MemoryPluginStore,
  PluginRegistry,
  openLog,
  type TriggerMode,
} from "../../src/index.ts";
import plugin from "./plugins/trigger.ts";

const [storeRoot, mode, key] = process.argv.slice(2);
if (storeRoot === undefined || mode === undefined || key === undefined) {
  throw new Error("usage: trigger-child <store root> <mode> <key>");
}

const log = openLog({ backend: "jsonl", path: storeRoot });
const registry = new PluginRegistry([plugin], {
  home: storeRoot,
  storeRoot,
  store: new MemoryPluginStore({ root: storeRoot }),
});
const kernel = new Kernel({
  log,
  registry,
  home: storeRoot,
  storeRoot,
  rules: [
    {
      source: "cron",
      type: "tick",
      start: { flow: "one" },
      object: "job:1",
      mode: mode as TriggerMode,
    },
  ],
  onLog: () => undefined,
});

const result = await kernel.receive({
  source: "cron",
  key,
  type: "tick",
  hops: 0,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
await log.close();
