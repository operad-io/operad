import { join } from "node:path";
import {
  SqlitePluginStore,
  Runner,
  loadPluginRegistry,
  openConfigLog,
  parseObjectKey,
  readConfig,
  storeRootOf,
  type LogBackend,
} from "../../src/index.ts";

const home = process.argv[2];
const runId = process.argv[3];
if (home === undefined || runId === undefined) {
  throw new Error("usage: crash-child <home> <run id>");
}

const config = await readConfig(home);
const storeRoot = storeRootOf(config);
const registry = await loadPluginRegistry({
  home,
  cwd: home,
  store: new SqlitePluginStore({ root: storeRoot }),
});
const log = openConfigLog(config);
const runs = await log.runs();
const run = runs.find((candidate) => candidate.runId === runId);
if (run === undefined) throw new Error(`no run ${runId}`);
const found = registry.flow(run.flow);
if (found === undefined) throw new Error(`no flow ${run.flow}`);

/** The real log, except that the first append kills the process. */
let crash = true;
const crashing: LogBackend = {
  startRun: (flow, object, inputId) => log.startRun(flow, object, inputId),
  endRun: (id) => log.endRun(id),
  recordInput: (id, source, key, payload) =>
    log.recordInput(id, source, key, payload),
  append: (id, seq, facts) => {
    if (crash) {
      crash = false;
      process.kill(process.pid, "SIGKILL");
      process.exit(137);
    }
    return log.append(id, seq, facts);
  },
  read: (id) => log.read(id),
  runs: (options) => log.runs(options),
  appendGlobal: (fact, uniqueKey) => log.appendGlobal(fact, uniqueKey),
  readGlobal: () => log.readGlobal(),
  readInputs: () => log.readInputs(),
  recordOutcome: (inputId, kind, payload) =>
    log.recordOutcome(inputId, kind, payload),
  readOutcomes: () => log.readOutcomes(),
  readInputsAfter: (position) => log.readInputsAfter(position),
  findInput: (inputId) => log.findInput(inputId),
  readOutcome: (inputId, kind) => log.readOutcome(inputId, kind),
  readOutcomesAfter: (seq) => log.readOutcomesAfter(seq),
  close: () => log.close(),
};

const object = parseObjectKey(run.object);
const runner = new Runner({
  log: crashing,
  flow: found.flow,
  runId,
  registry,
  lockRoot: storeRoot,
  ...(object === undefined ? {} : { object }),
});
await runner.run();
