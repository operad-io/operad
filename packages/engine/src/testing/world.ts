/**
 * One isolated world for a test: a log, a store, a registry holding the plugin
 * under test, and the kernel. It is made of the engine's own parts; the only
 * thing here is the wiring a test would otherwise copy.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowDefinition } from "../flow/types.ts";
import { openLog } from "../log/open-log.ts";
import type { LogBackend } from "../log/types.ts";
import { FileSecretStore } from "../plugin/secrets.ts";
import { MemoryPluginStore } from "../plugin/store.ts";
import { PluginRegistry } from "../plugin/registry.ts";
import type { PluginDefinition, PluginStore } from "../plugin/types.ts";
import { answerRun } from "../runner/answer.ts";
import { Runner } from "../runner/runner.ts";
import { parseObjectKey, readState } from "../runner/service.ts";
import { Kernel } from "../trigger/kernel.ts";
import { loadTriggerRules } from "../trigger/rules.ts";
import { readStoredStart, readStoredTrigger } from "../trigger/store.ts";
import { formatHistoryEntry, historyEntries } from "../views/history.ts";
import type { Fact } from "../log/types.ts";
import type { FakeClock, FlowRun, FlowRunStatus, RunFlowOptions } from "./types.ts";

export interface World {
  readonly root: string;
  readonly storeRoot: string;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly kernel: Kernel;
  readonly store: PluginStore;
  readonly clock: FakeClock | undefined;
  readonly now: () => number;
  /** Lines the registry and kernel logged, such as a plugin's own errors. */
  readonly logs: string[];
}

const worlds = new Set<World>();
const worldOf = new WeakMap<FlowRun, World>();

/** An empty in-memory object store. */
export function memoryStore(): PluginStore {
  return new MemoryPluginStore({ root: join(tmpdir(), "operad-testing-memory") });
}

export async function createWorld(
  plugin: PluginDefinition,
  options: Omit<RunFlowOptions, "object" | "params" | "access">,
): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "operad-testing-"));
  const home = join(root, "home");
  const storeRoot = join(root, "store");
  const clock = options.clock;
  const now = clock === undefined ? () => Date.now() : () => clock.now();
  const logs: string[] = [];
  const store = options.store ?? memoryStore();
  let log: LogBackend | undefined;
  try {
    for (const [name, value] of Object.entries(options.secrets ?? {})) {
      await new FileSecretStore({ home, plugin: plugin.name }).set(name, value);
    }
    log = openLog({ backend: "jsonl", path: storeRoot });
    const registry = new PluginRegistry([plugin], {
      home,
      cwd: home,
      storeRoot,
      store,
      clock: now,
      settings: options.settings === undefined ? {} : { [plugin.name]: options.settings },
      onLog: (message) => logs.push(message),
    });
    const refusal = registry.refusals().find((item) => item.plugin === plugin.name);
    if (refusal !== undefined) throw new Error(refusal.message);
    const rules = await loadTriggerRules({ home, registry, onLog: (m) => logs.push(m) });
    const kernel = new Kernel({
      log,
      registry,
      home,
      storeRoot,
      rules,
      clock: now,
      onLog: (message) => logs.push(message),
    });
    const world: World = { root, storeRoot, log, registry, kernel, store, clock, now, logs };
    worlds.add(world);
    return world;
  } catch (error) {
    await log?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Closes every world made so far and removes its scratch directory. */
export async function cleanup(): Promise<void> {
  for (const world of [...worlds]) {
    worlds.delete(world);
    await world.log.close();
    await rm(world.root, { recursive: true, force: true });
  }
}

export function flowNamed(world: World, flow: string | FlowDefinition): FlowDefinition {
  const name = typeof flow === "string" ? flow : flow.name;
  const found = world.registry.flow(name);
  if (found === undefined) throw new Error(`the plugin has no flow "${name}"`);
  return found.flow;
}

/** Runs a run the way `serve` hands it to a child: to its end or first wait. */
export async function execute(world: World, runId: string): Promise<void> {
  const run = (await world.log.runs()).find((item) => item.runId === runId);
  if (run === undefined) throw new Error(`no run "${runId}"`);
  const found = world.registry.flow(run.flow);
  if (found === undefined) throw new Error(`flow "${run.flow}" is not loaded`);
  const object = parseObjectKey(run.object);
  world.kernel.adoptStart(run);
  const startInput = readStoredStart(world.storeRoot, runId);
  const trigger = readStoredTrigger(world.storeRoot, runId);
  const runner = new Runner({
    log: world.log,
    flow: found.flow,
    runId,
    registry: world.registry,
    lockRoot: world.storeRoot,
    clock: world.now,
    ...(world.clock === undefined ? {} : { timers: world.clock }),
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

export async function snapshot(world: World, runId: string): Promise<FlowRun> {
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

export function worldFor(run: FlowRun): World {
  const world = worldOf.get(run);
  if (world === undefined) throw new Error("this run was not made by the testing package");
  return world;
}

/** Answers the wait the run is in, then runs on to the next end or wait. */
export async function answerWait(
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
    throw new Error(`run ${run.runId}: the wait "${waitId}" is not the one it is in ("${state.wait.id}")`);
  }
  const flow = flowNamed(world, run.flow);
  const after = await answerRun({
    log: world.log,
    flow,
    runId: run.runId,
    choice,
    ...(note === undefined ? {} : { note }),
    actor: { via: "testing", id: "test" },
    clock: world.now,
    onEnded: async (endedRunId, ended) => {
      await world.kernel.emitRunEnd(endedRunId, ended);
    },
  });
  if (after.status !== "ended") await execute(world, run.runId);
  return snapshot(world, run.runId);
}
