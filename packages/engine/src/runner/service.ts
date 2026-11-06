/** Reading a run's state and appending one input's facts as one batch. */

import type { FlowDefinition } from "../flow/types.ts";
import { decide, evolve, initialState } from "../kernel/index.ts";
import type { Decision, Input, KernelState } from "../kernel/types.ts";
import type { LogBackend } from "../log/types.ts";
import type { ObjectRef } from "../plugin/types.ts";

/** Rebuild a run's state by streaming its log, without holding the facts. */
export async function readState(
  log: LogBackend,
  runId: string,
): Promise<KernelState> {
  let state = initialState();
  for await (const fact of log.read(runId)) {
    state = evolve(state, fact);
  }
  return state;
}

export function objectKey(object: ObjectRef | undefined): string {
  return object === undefined
    ? "flow"
    : `${object.type}:${object.id}`;
}

/** The object a run belongs to, when its key names one. */
export function parseObjectKey(
  key: string,
): { readonly type: string; readonly id: string } | undefined {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return undefined;
  return { type: key.slice(0, colon), id: key.slice(colon + 1) };
}

export interface ApplyResult {
  readonly state: KernelState;
  readonly decision: Decision;
  readonly duplicate: boolean;
}

/**
 * Records one input, asks `decide` for its facts and appends them as one
 * batch. A repeated (source, key) appends nothing.
 */
export async function applyInput(
  log: LogBackend,
  flow: FlowDefinition,
  runId: string,
  state: KernelState,
  input: Input,
  now: number,
  source: string,
  sourceKey: string,
): Promise<ApplyResult> {
  const recorded = await log.recordInput(
    runId,
    source,
    `${runId}:${sourceKey}`,
    {
      kind: input.kind,
    },
  );
  if (recorded.duplicate) {
    return {
      state,
      decision: { facts: [], effects: [] },
      duplicate: true,
    };
  }

  const withId: Input = { ...input, inputId: recorded.inputId };
  const decision = decide(flow, state, withId, now);
  let next = state;
  if (decision.facts.length > 0) {
    await log.append(runId, state.lastSeq, decision.facts);
    for (const fact of decision.facts) next = evolve(next, fact);
  }
  if (next.status === "ended") {
    await log.endRun(runId);
  }
  return { state: next, decision, duplicate: false };
}
