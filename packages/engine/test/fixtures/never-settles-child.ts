#!/usr/bin/env bun
/**
 * A child process for the runner tests. It runs a step that never settles on a
 * runner with no worker (an in-memory registry) and a short step timeout. If
 * nothing keeps the process alive until the timeout, it exits silently.
 */
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  defineFlow,
  definePlugin,
  openLog,
  readState,
} from "../../src/index.ts";

const root = process.argv[2];
if (root === undefined) throw new Error("usage: never-settles-child <dir>");

const flow = defineFlow({
  name: "stuck",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/stuck", params: {} },
      replay: "safe",
      next: { ok: "done", failed: "done", interrupted: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});
const plugin = definePlugin({
  name: "test",
  kind: "domain",
  version: "0.0.1",
  flows: [flow],
  steps: [
    {
      name: "stuck",
      results: ["ok", "failed", "interrupted"],
      run: () => new Promise(() => undefined),
    },
  ],
});

const storeRoot = join(root, "store");
const log = openLog({ backend: "jsonl", path: storeRoot });
const registry = new PluginRegistry([plugin], {
  home: root,
  storeRoot,
  store: new MemoryPluginStore({ root: storeRoot }),
  onLog: () => undefined,
});
const info = await log.startRun("stuck", "job:1");
const runner = new Runner({
  log,
  flow,
  runId: info.runId,
  registry,
  lockRoot: storeRoot,
  stepTimeoutMs: 100,
});
await runner.run();
const state = await readState(log, info.runId);
process.stdout.write(`${JSON.stringify({ results: Object.values(state.results).map((r) => r.result) })}\n`);
await log.close();
