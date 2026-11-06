import {
  MemoryPluginStore,
  Runner,
  loadPluginRegistry,
  openConfigLog,
  parseObjectKey,
  readConfig,
  storeRootOf,
} from "../../src/index.ts";

const home = process.argv[2];
const runId = process.argv[3];
if (home === undefined || runId === undefined) {
  throw new Error("usage: run-child <home> <run id> [--recover]");
}

const config = await readConfig(home);
const storeRoot = storeRootOf(config);
const registry = await loadPluginRegistry({
  home,
  cwd: home,
  store: new MemoryPluginStore({ root: storeRoot }),
});
const log = openConfigLog(config);
const runs = await log.runs();
const run = runs.find((candidate) => candidate.runId === runId);
if (run === undefined) throw new Error(`no run ${runId}`);
const found = registry.flow(run.flow);
if (found === undefined) throw new Error(`no flow ${run.flow}`);

const object = parseObjectKey(run.object);
const runner = new Runner({
  log,
  flow: found.flow,
  runId,
  registry,
  lockRoot: storeRoot,
  recover: process.argv.includes("--recover"),
  ...(object === undefined ? {} : { object }),
});
await runner.run();
await log.close();
