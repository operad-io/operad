/** Cancelling a run on behalf of a plugin, from any process that holds the log. */

import type { FlowDefinition } from "../flow/types.ts";
import type { LogBackend } from "../log/types.ts";
import { StateError } from "./errors.ts";
import { applyInput, endRunDirectly, readState } from "./service.ts";

export interface CancelRunOptions {
  readonly log: LogBackend;
  /** Finds a flow by name; undefined when it is not loaded. */
  readonly flow: (name: string) => FlowDefinition | undefined;
  readonly runId: string;
  /** The run's own graph, for a flow no loaded plugin declares. */
  readonly graph?: FlowDefinition | undefined;
  /** Who asked: recorded with the cancel input, as the person's client names itself. */
  readonly source: string;
  readonly clock?: (() => number) | undefined;
}

/**
 * Ends a run as cancelled; an unknown or ended run is left alone. True when
 * this ended an active run, so a caller can tell that from one that had ended.
 */
export async function cancelRun(options: CancelRunOptions): Promise<boolean> {
  const { log, runId } = options;
  const run = await log.run(runId);
  if (run === undefined) return false;
  const state = await readState(log, runId);
  if (state.status === "ended") return false;
  // A run that never took its first step has no flow to answer through; its
  // cancel still ends it, so it leaves the running view.
  if (state.status === "idle") {
    await endRunDirectly(log, runId, "cancelled", "cancel");
    return true;
  }
  const flow =
    options.graph !== undefined && options.graph.name === run.flow
      ? options.graph
      : options.flow(run.flow);
  if (flow === undefined) {
    throw new StateError(`run "${runId}": flow "${run.flow}" is not loaded`);
  }
  await applyInput(
    log,
    flow,
    runId,
    state,
    { kind: "cancel" },
    (options.clock ?? Date.now)(),
    options.source,
    `cancel:${runId}`,
  );
  return true;
}
