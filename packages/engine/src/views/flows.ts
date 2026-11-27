/** The loaded flows, as `operad flows --json` and `GET /v1/flows` give them. */

import type { EndStatus, Step, StepKind } from "../flow/types.ts";
import type { PluginRegistry } from "../plugin/registry.ts";

/** One step of a loaded flow, in the form a client draws. */
export interface LoadedFlowStep {
  readonly id: string;
  readonly kind: StepKind;
  /** The plugin step it calls, `<plugin>/<step>`: a call, or the check a wait asks. */
  readonly use?: string;
  /** How the flow ends here; only an end has it. */
  readonly status?: EndStatus;
  /** Where each result or choice goes; the id `end` finishes the flow. */
  readonly next?: Readonly<Record<string, string>>;
}

/** One loaded flow. */
export interface LoadedFlow {
  readonly name: string;
  /** The plugin it belongs to, `home` for a file of the home. */
  readonly plugin: string;
  readonly source: string | null;
  readonly startable: boolean;
  /** Why it cannot start. */
  readonly problem?: string;
  /** The file of a flow of the home. */
  readonly path?: string;
  /** The id of the first step. */
  readonly entry: string;
  readonly steps: readonly LoadedFlowStep[];
}

function useOf(step: Step): string | undefined {
  if (step.kind === "plugin") return step.params.use;
  if (step.kind === "wait" && "check" in step.params) return step.params.check;
  return undefined;
}

function stepOf(step: Step): LoadedFlowStep {
  const use = useOf(step);
  return {
    id: step.id,
    kind: step.kind,
    ...(use === undefined ? {} : { use }),
    ...(step.kind === "end" ? { status: step.params.status } : { next: step.next }),
  };
}

/** Every loaded flow, in the registry's order. */
export function listFlows(registry: PluginRegistry): readonly LoadedFlow[] {
  return registry.flows().map(({ plugin, flow, source }) => {
    const problem = registry.startProblem(flow.name);
    const path = registry.homeFlowFile(flow.name);
    return {
      name: flow.name,
      plugin,
      source: source ?? null,
      startable: problem === undefined,
      ...(problem === undefined ? {} : { problem }),
      ...(path === undefined ? {} : { path }),
      entry: flow.entry,
      steps: (flow.steps as readonly Step[]).map(stepOf),
    };
  });
}
