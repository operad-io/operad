/**
 * `@operad-io/engine/testing`: run a plugin's flows in the test's own process.
 * It wires the engine's runner and kernel to a scratch log and a memory store;
 * it has no logic of its own to drift from them.
 */

import type { FlowDefinition } from "../flow/types.ts";
import type { JsonValue } from "../log/types.ts";
import type { PluginDefinition } from "../plugin/types.ts";
import {
  answerWait,
  cleanup,
  createWorld,
  execute,
  flowNamed,
  memoryStore,
  snapshot,
  worldFor,
} from "./world.ts";
import type { EmitOptions, EmitResult, FlowRun, RunFlowOptions } from "./types.ts";

export { fakeClock } from "./clock.ts";
export { cleanup, memoryStore };
export type {
  EmitOptions,
  EmitResult,
  FakeClock,
  FlowEnd,
  FlowRun,
  FlowRunStatus,
  FlowWait,
  RunFlowOptions,
} from "./types.ts";

/**
 * Starts `flow` and runs it to its end or its first wait. The run is about
 * `options.object`, or `<first object type>:1`; a plugin with no object type
 * gets a run of its own flow.
 */
export async function runFlow(
  plugin: PluginDefinition,
  flow: string | FlowDefinition,
  options: RunFlowOptions = {},
): Promise<FlowRun> {
  const world = await createWorld(plugin, options);
  const definition = flowNamed(world, flow);
  const first = plugin.objects?.[0];
  const object =
    options.object !== undefined
      ? `${options.object.type}:${options.object.id}`
      : first !== undefined
        ? `${first.name}:1`
        : `flow:${plugin.name}/${definition.name}`;
  const started = await world.kernel.start({
    flow: definition.name,
    object,
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.access === undefined ? {} : { access: options.access }),
  });
  if (started.kind !== "started") {
    throw new Error(`the flow "${definition.name}" did not start (${started.kind})`);
  }
  await execute(world, started.runId);
  return snapshot(world, started.runId);
}

/**
 * Answers the person wait `run` is in and runs on to the next end or wait.
 * `waitId` must be the id of the wait the run is in now.
 */
export function answer(
  run: FlowRun,
  waitId: string,
  choice: string,
  note?: string,
): Promise<FlowRun> {
  return answerWait(run, waitId, choice, note);
}

/** Runs a run on, for example after the clock passed a time wait. */
export async function resume(run: FlowRun): Promise<FlowRun> {
  const world = worldFor(run);
  await execute(world, run.runId);
  return snapshot(world, run.runId);
}

let eventCount = 0;

/**
 * Sends an event through the plugin's trigger rules as a source plugin would.
 * A rule that matches starts its flow, and the run goes to its end or first
 * wait; an event no rule matches starts nothing.
 */
export async function emit(
  plugin: PluginDefinition,
  source: string,
  type: string,
  data?: JsonValue,
  options: EmitOptions = {},
): Promise<EmitResult> {
  const world = await createWorld(plugin, options);
  eventCount += 1;
  const result = await world.kernel.receive({
    source,
    type,
    key: options.key ?? `testing-${eventCount}`,
    hops: 0,
    ...(options.object === undefined ? {} : { object: options.object }),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(data === undefined ? {} : { data }),
  });
  if (result.kind !== "started" || result.runId === undefined) {
    return { started: false, result, run: undefined };
  }
  await execute(world, result.runId);
  return { started: true, result, run: await snapshot(world, result.runId) };
}
