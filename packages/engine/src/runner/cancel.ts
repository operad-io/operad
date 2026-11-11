/** Cancelling a run on behalf of a plugin, from any process that holds the log. */

import type { FlowDefinition } from "../flow/types.ts";
import type { LogBackend } from "../log/types.ts";
import { StateError } from "./errors.ts";
import { applyInput, readState } from "./service.ts";

export interface CancelRunOptions {
  readonly log: LogBackend;
  /** Finds a flow by name; undefined when it is not loaded. */
  readonly flow: (name: string) => FlowDefinition | undefined;
  readonly runId: string;
  /** The run's own graph, for a flow no loaded plugin declares. */
  readonly graph?: FlowDefinition | undefined;
  readonly clock?: (() => number) | undefined;
}

/** Ends a run as cancelled; an unknown, ended or idle run is left alone. */
export async function cancelRun(options: CancelRunOptions): Promise<void> {
  const { log, runId } = options;
  const runs = await log.runs();
  const run = runs.find((candidate) => candidate.runId === runId);
  if (run === undefined) return;
  const flow =
    options.graph !== undefined && options.graph.name === run.flow
      ? options.graph
      : options.flow(run.flow);
  if (flow === undefined) {
    throw new StateError(`run "${runId}": flow "${run.flow}" is not loaded`);
  }
  const state = await readState(log, runId);
  if (state.status === "ended" || state.status === "idle") return;
  await applyInput(
    log,
    flow,
    runId,
    state,
    { kind: "cancel" },
    (options.clock ?? Date.now)(),
    "dev",
    `cancel:${runId}`,
  );
}
