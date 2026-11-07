/**
 * One isolated world for a test: a log, a store, a registry holding the plugin
 * under test, and the kernel. It is made of the engine's own parts, and it is
 * driven by the same pass `serve` makes: tick, apply recorded answers, start
 * runs, give every run a runner. A test's calls record what a person or a
 * source would and then let that pass run until nothing changes.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowDefinition } from "../flow/types.ts";
import { openLog } from "../log/open-log.ts";
import type { Fact, JsonValue, LogBackend } from "../log/types.ts";
import { FilePluginStore } from "../plugin/file-store.ts";
import { loadPlugin } from "../plugin/load.ts";
import { PluginRegistry } from "../plugin/registry.ts";
import { FileSecretStore } from "../plugin/secrets.ts";
import { MemoryPluginStore } from "../plugin/store.ts";
import type { PluginDefinition, PluginStore } from "../plugin/types.ts";
import { serveOnce } from "../loop/serve.ts";
import { recordAnswer } from "../runner/answer.ts";
import { Runner } from "../runner/runner.ts";
import { parseObjectKey, readState } from "../runner/service.ts";
import { Kernel } from "../trigger/kernel.ts";
import { loadTriggerRules } from "../trigger/rules.ts";
import { readStoredStart, readStoredTrigger } from "../trigger/store.ts";
import { formatHistoryEntry, historyEntries } from "../views/history.ts";
import type {
  EmitOptions,
  EmitResult,
  FlowRun,
  FlowRunStatus,
  PluginUnderTest,
  RunFlowOptions,
  TestWorld,
  WorldOptions,
} from "./types.ts";

/** A pass that keeps changing the log this many times is a loop, not a test. */
const MAX_PASSES = 200;

interface World {
  readonly root: string;
  readonly storeRoot: string;
  readonly home: string;
  readonly plugin: PluginDefinition;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly kernel: Kernel;
  readonly store: PluginStore;
  readonly options: WorldOptions;
  readonly now: () => number;
  events: number;
}

const worlds = new Set<World>();
const worldOf = new WeakMap<FlowRun, World>();

/** An empty in-memory object store. */
export function memoryStore(): PluginStore {
  return new MemoryPluginStore({ root: join(tmpdir(), "operad-testing-memory") });
}

function isDefinition(plugin: PluginUnderTest): plugin is PluginDefinition {
  return typeof plugin !== "string";
}

async function createWorld(
  plugin: PluginUnderTest,
  options: WorldOptions,
): Promise<World> {
  if (isDefinition(plugin) && options.inProcess !== true) {
    throw new Error(
      "a plugin given as a definition can only run in this process: pass its module path " +
        "to run its steps in a worker as `serve` does, or set inProcess: true",
    );
  }
  if (options.store !== undefined && options.inProcess !== true) {
    throw new Error("a store of your own needs inProcess: true; a worker opens its own");
  }
  const root = await mkdtemp(join(tmpdir(), "operad-testing-"));
  const home = join(root, "home");
  const storeRoot = join(root, "store");
  const clock = options.clock;
  const now = clock === undefined ? () => Date.now() : () => clock.now();
  let log: LogBackend | undefined;
  try {
    const definition = isDefinition(plugin)
      ? plugin
      : ((await loadPlugin(plugin, home)) as PluginDefinition);
    const store: PluginStore =
      options.inProcess === true
        ? (options.store ?? memoryStore())
        : new FilePluginStore({ root: storeRoot });
    for (const [name, value] of Object.entries(options.secrets ?? {})) {
      await new FileSecretStore({ home, plugin: definition.name }).set(name, value);
    }
    log = openLog({ backend: "jsonl", path: storeRoot });
    const onLog = (message: string): void => {
      console.error(message);
    };
    const registry = new PluginRegistry([definition], {
      home,
      cwd: home,
      storeRoot,
      store,
      clock: now,
      settings:
        options.settings === undefined ? {} : { [definition.name]: options.settings },
      ...(options.inProcess === true || isDefinition(plugin) ? {} : { sources: [plugin] }),
      onLog,
    });
    const refusal = registry.refusals().find((item) => item.plugin === definition.name);
    if (refusal !== undefined) throw new Error(refusal.message);
    const rules = await loadTriggerRules({ home, registry, onLog });
    const kernel = new Kernel({ log, registry, home, storeRoot, rules, clock: now, onLog });
    const world: World = {
      root,
      storeRoot,
      home,
      plugin: definition,
      log,
      registry,
      kernel,
      store,
      options,
      now,
      events: 0,
    };
    worlds.add(world);
    return world;
  } catch (error) {
    await log?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeWorld(world: World): Promise<void> {
  if (!worlds.delete(world)) return;
  await world.log.close();
  await rm(world.root, { recursive: true, force: true });
}

/** Closes every world made so far and removes its scratch directory. */
export async function cleanup(): Promise<void> {
  for (const world of [...worlds]) await closeWorld(world);
}

function flowNamed(world: World, flow: string | FlowDefinition): FlowDefinition {
  const name = typeof flow === "string" ? flow : flow.name;
  const found = world.registry.flow(name);
  if (found === undefined) throw new Error(`the plugin has no flow "${name}"`);
  return found.flow;
}

/** What a run is doing, as one string: it changes whenever the run moves. */
async function signature(world: World): Promise<string> {
  const runs = await world.log.runs();
  return JSON.stringify(runs.map((run) => [run.runId, run.lastSeq, run.active]));
}

/** Gives one run a runner, as the process `serve` starts for it would. */
async function runnerFor(world: World, runId: string, recover: boolean): Promise<void> {
  const run = (await world.log.runs()).find((item) => item.runId === runId);
  if (run === undefined) throw new Error(`no run "${runId}"`);
  const found = world.registry.flow(run.flow);
  if (found === undefined) throw new Error(`flow "${run.flow}" is not loaded`);
  const object = parseObjectKey(run.object);
  world.kernel.adoptStart(run);
  const startInput = readStoredStart(world.storeRoot, runId);
  const trigger = readStoredTrigger(world.storeRoot, runId);
  const clock = world.options.clock;
  const runner = new Runner({
    log: world.log,
    flow: found.flow,
    runId,
    registry: world.registry,
    lockRoot: world.storeRoot,
    clock: world.now,
    recover,
    ...(clock === undefined ? {} : { timers: clock }),
    ...(run.access === undefined ? {} : { access: run.access }),
    ...(object === undefined ? {} : { object }),
    ...(startInput === undefined ? {} : { startInput }),
    ...(trigger === undefined ? {} : { trigger }),
    onEnded: async (endedRunId, state) => {
      await world.kernel.emitRunEnd(endedRunId, state);
    },
    emit: async (pluginName, event) => {
      await world.kernel.emitStep(runId, pluginName, event, run.object);
    },
  });
  await runner.run();
}

/**
 * Makes the passes `serve` makes until one changes nothing: answers recorded
 * since the last pass are applied, every run that can move gets a runner, and
 * a run that ends can start the next through the rules.
 */
async function settle(world: World): Promise<void> {
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const before = await signature(world);
    const runners: Promise<void>[] = [];
    await serveOnce({
      log: world.log,
      registry: world.registry,
      kernel: world.kernel,
      lockRoot: world.storeRoot,
      storeRoot: world.storeRoot,
      home: world.home,
      clock: world.now,
      spawnRun: (runId, options) => {
        runners.push(runnerFor(world, runId, options.recover));
      },
    });
    await Promise.all(runners);
    if ((await signature(world)) === before) return;
  }
  throw new Error(`the runs were still changing after ${MAX_PASSES} passes`);
}

async function snapshot(world: World, runId: string): Promise<FlowRun> {
  const facts: Fact[] = [];
  for await (const fact of world.log.read(runId)) facts.push(fact);
  const state = await readState(world.log, runId);
  const history: string[] = [];
  for await (const entry of historyEntries(world.log.read(runId))) {
    history.push(formatHistoryEntry(entry));
  }
  const info = (await world.log.runs()).find((item) => item.runId === runId);
  const status: FlowRunStatus =
    state.status === "ended"
      ? "ended"
      : state.status === "waiting_person"
        ? "waiting_person"
        : "blocked";
  const run: FlowRun = {
    runId,
    flow: info?.flow ?? "",
    status,
    end: state.endedStatus ?? undefined,
    wait:
      state.wait === null || status !== "waiting_person"
        ? undefined
        : { id: state.wait.id, prompt: state.wait.prompt, choices: state.wait.choices },
    facts,
    history,
    store: world.store,
  };
  worldOf.set(run, world);
  return run;
}

function worldFor(run: FlowRun): World {
  const world = worldOf.get(run);
  if (world === undefined) throw new Error("this run was not made by the testing package");
  return world;
}

async function runFlowIn(
  world: World,
  flow: string | FlowDefinition,
  options: Pick<RunFlowOptions, "object" | "params" | "access">,
): Promise<FlowRun> {
  const definition = flowNamed(world, flow);
  const first = world.plugin.objects?.[0];
  const object =
    options.object !== undefined
      ? `${options.object.type}:${options.object.id}`
      : first !== undefined
        ? `${first.name}:1`
        : `flow:${world.plugin.name}/${definition.name}`;
  const started = await world.kernel.start({
    flow: definition.name,
    object,
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.access === undefined ? {} : { access: options.access }),
  });
  if (started.kind !== "started") {
    throw new Error(`the flow "${definition.name}" did not start (${started.kind})`);
  }
  await settle(world);
  return snapshot(world, started.runId);
}

async function emitIn(
  world: World,
  source: string,
  type: string,
  data: JsonValue | undefined,
  options: EmitOptions,
): Promise<EmitResult> {
  world.events += 1;
  const result = await world.kernel.receive({
    source,
    type,
    key: options.key ?? `testing-${world.events}`,
    hops: 0,
    ...(options.object === undefined ? {} : { object: options.object }),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(data === undefined ? {} : { data }),
  });
  await settle(world);
  const run =
    result.runId === undefined ? undefined : await snapshot(world, result.runId);
  return { started: result.kind === "started" && !result.duplicate, result, run };
}

/** Answers the wait the run is in, then lets the world run on. */
export async function answerRunWait(
  run: FlowRun,
  waitId: string,
  choice: string,
  note: string | undefined,
): Promise<FlowRun> {
  const world = worldFor(run);
  const state = await readState(world.log, run.runId);
  if (state.status !== "waiting_person" || state.wait === null) {
    throw new Error(`run ${run.runId} is not waiting for a person`);
  }
  if (state.wait.id !== waitId) {
    throw new Error(
      `run ${run.runId}: the wait "${waitId}" is not the one it is in ("${state.wait.id}")`,
    );
  }
  // What the CLI and a plugin action do: record the answer. The pass applies it.
  await recordAnswer({
    log: world.log,
    runId: run.runId,
    choice,
    ...(note === undefined ? {} : { note }),
    actor: { via: "testing", id: "test" },
  });
  await settle(world);
  return snapshot(world, run.runId);
}

/** Lets the world run on, for example after the clock passed a time wait. */
export async function resumeRun(run: FlowRun): Promise<FlowRun> {
  const world = worldFor(run);
  await settle(world);
  return snapshot(world, run.runId);
}

export async function testWorld(
  plugin: PluginUnderTest,
  options: WorldOptions = {},
): Promise<TestWorld> {
  const world = await createWorld(plugin, options);
  return {
    store: world.store,
    runFlow: (flow, runOptions = {}) => runFlowIn(world, flow, runOptions),
    emit: (source, type, data, emitOptions = {}) =>
      emitIn(world, source, type, data, emitOptions),
    async runs() {
      const runs = await world.log.runs();
      return Promise.all(
        [...runs]
          .sort((left, right) => left.startedAt - right.startedAt)
          .map((run) => snapshot(world, run.runId)),
      );
    },
    close: () => closeWorld(world),
  };
}
