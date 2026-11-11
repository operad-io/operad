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

/**
 * Ends a run no flow can drive, with its own ending fact so history says why.
 * An ended run is only marked ended; a run the log does not know is left alone.
 */
export async function endRunDirectly(
  log: LogBackend,
  runId: string,
  status: "failed" | "cancelled",
  reason: string | null,
): Promise<KernelState | undefined> {
  const run = (await log.runs()).find((candidate) => candidate.runId === runId);
  if (run === undefined) return undefined;
  let state = await readState(log, runId);
  if (state.status !== "ended") {
    const appended = await log.append(runId, state.lastSeq, [
      {
        kind: "run_ended",
        payload: { status, reason },
        cause: `${status}:${runId}`,
      },
    ]);
    for (const fact of appended.facts) state = evolve(state, fact);
  }
  await log.endRun(runId);
  return state;
}

export function objectKey(object: ObjectRef | undefined): string {
  return object === undefined
    ? "flow"
    : `${object.type}:${object.id}`;
}

/**
 * The object a run belongs to, when its key names one. A run started without
 * an object is keyed `flow:<plugin>/<flow>`, so that one active run per flow
 * holds; `flow` is therefore not an object type and that key names no object.
 */
export function parseObjectKey(
  key: string,
): { readonly type: string; readonly id: string } | undefined {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return undefined;
  if (key.slice(0, colon) === "flow") return undefined;
  return { type: key.slice(0, colon), id: key.slice(colon + 1) };
}

export interface ApplyResult {
  readonly state: KernelState;
  readonly decision: Decision;
  readonly duplicate: boolean;
}

/** True when a fact of the run already names the input as its cause. */
async function inputApplied(
  log: LogBackend,
  runId: string,
  inputId: string,
): Promise<boolean> {
  for await (const fact of log.read(runId)) {
    if (fact.cause === inputId) return true;
  }
  return false;
}

/**
 * Records one input, asks `decide` for its facts and appends them as one
 * batch. A repeated (source, key) appends nothing.
 *
 * A crash can leave the input's record behind without its facts. Such a
 * record is not an applied input: the run has no fact caused by it, so its
 * decision still has to be taken and appended.
 */
export interface ApplyHooks {
  /**
   * Runs after the ending facts are written, before the run is marked ended.
   * Recording the end event here keeps it recoverable: a crash before the
   * run is ended leaves the run active, so the next pass finishes it again.
   */
  readonly beforeEnd?:
    | ((runId: string, state: KernelState) => void | Promise<void>)
    | undefined;
}

/**
 * Asks `decide` for one input's facts and appends them as one batch, without
 * recording an input. The caller supplies the input id as the cause.
 */
/**
 * Asks `decide` for one input's facts and appends them as one batch, without
 * recording an input. The caller supplies the input id as the cause.
 */
export async function appendInput(
  log: LogBackend,
  flow: FlowDefinition,
  runId: string,
  state: KernelState,
  input: Input,
  now: number,
): Promise<{ readonly state: KernelState; readonly decision: Decision }> {
  const decision = decide(flow, state, input, now);
  const facts = decision.facts;
  let next = state;
  if (facts.length > 0) {
    await log.append(runId, state.lastSeq, facts);
    for (const fact of facts) next = evolve(next, fact);
  }
  return { state: next, decision };
}

/**
 * Records one input, asks `decide` for its facts and appends them as one
 * batch. A repeated (source, key) appends nothing.
 *
 * A crash can leave the input's record behind without its facts. Such a
 * record is not an applied input: the run has no fact caused by it, so its
 * decision still has to be taken and appended.
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
  hooks: ApplyHooks = {},
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
    if (await inputApplied(log, runId, recorded.inputId)) {
      return {
        state,
        decision: { facts: [], effects: [] },
        duplicate: true,
      };
    }
    // The record outlived the crash, the facts did not: decide again with the
    // recorded input id so the batch is attributed to the same input.
  }

  const withId: Input = { ...input, inputId: recorded.inputId };
  const { state: next, decision } = await appendInput(
    log,
    flow,
    runId,
    state,
    withId,
    now,
  );
  if (next.status === "ended") {
    await hooks.beforeEnd?.(runId, next);
    await log.endRun(runId);
  }
  return { state: next, decision, duplicate: false };
}
