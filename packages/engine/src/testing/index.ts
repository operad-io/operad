/**
 * `@operad-io/engine/testing`: run a plugin's flows in the test's own process
 * tree. It wires the engine's runner, kernel and `serve` pass to a scratch log
 * and store; it has no logic of its own to drift from them.
 */

import type { FlowDefinition } from "../flow/types.ts";
import type { JsonValue } from "../log/types.ts";
import { answerRunWait, cleanup, memoryStore, resumeRun, testWorld } from "./world.ts";
import type {
  EmitOptions,
  EmitResult,
  FlowRun,
  PluginUnderTest,
  RunFlowOptions,
} from "./types.ts";

export { fakeClock } from "./clock.ts";
export { cleanup, memoryStore, testWorld };
export type {
  EmitOptions,
  EmitResult,
  FakeClock,
  FlowEnd,
  FlowRun,
  FlowRunStatus,
  FlowWait,
  PluginUnderTest,
  RunFlowOptions,
  TestWorld,
  WorldOptions,
} from "./types.ts";

/**
 * Starts `flow` in a world of its own and runs it to its end or first wait.
 * The run is about `options.object`, or `<first object type>:1`. Give the
 * plugin's module path and its steps run in a worker, as under `serve`.
 */
export async function runFlow(
  plugin: PluginUnderTest,
  flow: string | FlowDefinition,
  options: RunFlowOptions = {},
): Promise<FlowRun> {
  const { object, params, access, ...worldOptions } = options;
  const world = await testWorld(plugin, worldOptions);
  return world.runFlow(flow, {
    ...(object === undefined ? {} : { object }),
    ...(params === undefined ? {} : { params }),
    ...(access === undefined ? {} : { access }),
  });
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
  return answerRunWait(run, waitId, choice, note);
}

/** Lets a run go on, for example after the clock passed a time wait. */
export function resume(run: FlowRun): Promise<FlowRun> {
  return resumeRun(run);
}

/**
 * Sends one event through the plugin's trigger rules in a world of its own, as
 * a source plugin would. To send several (a repeated key, a chain of runs), use
 * `testWorld(plugin).emit`.
 */
export async function emit(
  plugin: PluginUnderTest,
  source: string,
  type: string,
  data?: JsonValue,
  options: EmitOptions & Parameters<typeof testWorld>[1] = {},
): Promise<EmitResult> {
  const { key, object, summary, ...worldOptions } = options;
  const world = await testWorld(plugin, worldOptions);
  return world.emit(source, type, data, {
    ...(key === undefined ? {} : { key }),
    ...(object === undefined ? {} : { object }),
    ...(summary === undefined ? {} : { summary }),
  });
}
