/** Starting a flow of the home once, by hand: the command line and HTTP both come here. */

import { basename } from "node:path";
import {
  HAND_START_FACT,
  HOME_FLOW_PREFIX,
  isRecord,
  messageOf,
  StartRefusedError,
  ViewError,
  type FlowStarter,
  type JsonValue,
  type Kernel,
  type StartResult,
} from "@operad-io/engine";

export function flowStarterFor(kernel: Kernel, onLog: (message: string) => void): FlowStarter {
  const { registry, log } = kernel;
  return {
    async start(flow, params, actor) {
      const found = registry.flow(flow);
      if (found === undefined) {
        const refused = registry
          .homeFlowProblems()
          .find((item) => `${HOME_FLOW_PREFIX}${basename(item.file, ".flow.ts")}` === flow);
        throw new ViewError(
          "not-found",
          `flow "${flow}" is not loaded${refused === undefined ? "" : `: ${refused.message}`}`,
        );
      }
      if (registry.homeFlowFile(flow) === undefined) {
        throw new ViewError(
          "refused",
          `flow "${flow}" belongs to plugin ${found.plugin}; only a flow of the home (home:<name>) starts by hand`,
        );
      }
      if (params !== undefined && !isRecord(params)) {
        throw new ViewError("args", "params must be a JSON object");
      }
      let result: StartResult;
      try {
        result = await kernel.start({
          flow,
          object: `flow:${flow}`,
          // Both callers parsed it from JSON.
          ...(params === undefined ? {} : { params: params as JsonValue }),
        });
      } catch (error) {
        if (error instanceof StartRefusedError) {
          throw new ViewError("refused", error.message, { cause: error });
        }
        throw error;
      }
      if (result.kind === "active") {
        throw new ViewError("unavailable", `flow "${flow}" is already running (${result.runId})`);
      }
      if (result.kind !== "started") {
        throw new ViewError("refused", `flow "${flow}" did not start`);
      }
      // The run exists, so a record that cannot be written does not undo the start.
      try {
        await log.appendGlobal({
          kind: HAND_START_FACT,
          payload: { flow, runId: result.runId, actor: { via: actor.via, id: actor.id } },
          cause: `run:${result.runId}`,
        });
      } catch (error) {
        onLog(`could not record who started ${result.runId}: ${messageOf(error)}`);
      }
      return { flow, runId: result.runId };
    },
  };
}
