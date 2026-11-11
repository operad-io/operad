/**
 * Runs one run of the ask fixture and kills itself, with SIGKILL, at the point
 * named by <crash>: `opened` (right after the log accepts ask_opened),
 * `timed-out` (right after ask_timed_out), `answer-read` (just before a read
 * would hand over ask_answered), `grant-used` (right after grant_used) or `none`.
 */
import { join } from "node:path";
import {
  FilePluginStore,
  Runner,
  loadPluginRegistry,
  openConfigLog,
  parseObjectKey,
  readConfig,
  storeRootOf,
  type LogBackend,
} from "../../src/index.ts";

const [home, runId, paramsJson, crash, recover] = process.argv.slice(2);
if (home === undefined || runId === undefined || paramsJson === undefined || crash === undefined) {
  throw new Error("usage: ask-child <home> <run id> <params json> <crash> [recover]");
}

const config = await readConfig(home);
const storeRoot = storeRootOf(config);
const registry = await loadPluginRegistry({
  home,
  cwd: home,
  store: new FilePluginStore({ root: join(storeRoot, "plugins") }),
});
const log = openConfigLog(config);
const run = (await log.runs()).find((candidate) => candidate.runId === runId);
if (run === undefined) throw new Error(`no run ${runId}`);
const found = registry.flow(run.flow);
if (found === undefined) throw new Error(`no flow ${run.flow}`);

function die(): never {
  process.kill(process.pid, "SIGKILL");
  process.exit(137);
}

const afterAppend: Record<string, string> = {
  opened: "ask_opened",
  "timed-out": "ask_timed_out",
  "grant-used": "grant_used",
};
const target = afterAppend[crash];

const dying: LogBackend = {
  startRun: (flow, object, inputId) => log.startRun(flow, object, inputId),
  endRun: (id) => log.endRun(id),
  recordInput: (id, source, key, payload) => log.recordInput(id, source, key, payload),
  append: async (id, seq, facts) => {
    const result = await log.append(id, seq, facts);
    if (target !== undefined && id === runId && facts.some((fact) => fact.kind === target)) {
      die();
    }
    return result;
  },
  read: (id) =>
    crash === "answer-read" && id === runId
      ? (async function* () {
          for await (const fact of log.read(id)) {
            if (fact.kind === "ask_answered") die();
            yield fact;
          }
        })()
      : log.read(id),
  runs: (options) => log.runs(options),
  appendGlobal: (fact, uniqueKey) => log.appendGlobal(fact, uniqueKey),
  readGlobal: () => log.readGlobal(),
  readInputs: () => log.readInputs(),
  recordOutcome: (inputId, kind, payload) => log.recordOutcome(inputId, kind, payload),
  readOutcomes: () => log.readOutcomes(),
  readInputsAfter: (position) => log.readInputsAfter(position),
  findInput: (inputId) => log.findInput(inputId),
  readOutcome: (inputId, kind) => log.readOutcome(inputId, kind),
  readOutcomesAfter: (seq) => log.readOutcomesAfter(seq),
  subscribe: (listener) => log.subscribe?.(listener) ?? (() => undefined),
  close: () => log.close(),
};

const object = parseObjectKey(run.object);
const runner = new Runner({
  log: dying,
  flow: found.flow,
  runId,
  registry,
  lockRoot: storeRoot,
  params: JSON.parse(paramsJson),
  recover: recover === "recover",
  ...(object === undefined ? {} : { object }),
});
await runner.run();
await log.close();
