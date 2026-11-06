/** Receives one event or resolves one candidate in a child process. */

import { join } from "node:path";
import {
  Kernel,
  MemoryPluginStore,
  PluginRegistry,
  openLog,
  type TriggerMode,
} from "../../src/index.ts";
import plugin from "./plugins/trigger.ts";

const [storeRoot, mode, keyOrId, actionArg, backendArg] = process.argv.slice(2);
if (storeRoot === undefined || mode === undefined || keyOrId === undefined) {
  throw new Error("usage: trigger-child <store root> <mode> <key> [action] [backend]");
}
const action = actionArg ?? "receive";
const backend = backendArg === "sqlite" ? "sqlite" : "jsonl";

const log = openLog({
  backend,
  path: backend === "sqlite" ? join(storeRoot, "log.sqlite") : storeRoot,
});
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

try {
  const result =
    action === "start"
      ? await kernel.startCandidate(keyOrId)
      : action === "dismiss"
        ? await kernel.dismiss(keyOrId)
        : await kernel.receive({
            source: "cron",
            key: keyOrId,
            type: "tick",
            hops: 0,
          });
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
await log.close();
