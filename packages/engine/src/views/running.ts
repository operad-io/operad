/** The running view: active runs, their current step and how long they took. */

import type { LogBackend } from "../log/types.ts";
import { evolve, initialState } from "../kernel/state.ts";
import type { KernelState } from "../kernel/types.ts";
import { queuedSteps } from "../runner/limits.ts";
import { parseObjectKey } from "../runner/service.ts";
import type { Views } from "./presentation.ts";

export interface RunningItem {
  readonly runId: string;
  readonly flow: string;
  readonly step: string | null;
  readonly startedAt: number;
  /** The run's age. */
  readonly elapsedMs: number;
  /** The object the run belongs to, as rows and `operad show` name it; null for none. */
  readonly object: string | null;
  /** The object's row title; null when there is no object or the lookup failed. */
  readonly title: string | null;
  /** When the current step's current attempt started; null before any step. */
  readonly stepStartedAt: number | null;
  /** How long that attempt has run; null when `stepStartedAt` is. */
  readonly stepElapsedMs: number | null;
  /** Set while the step waits for a place under a limit key. */
  readonly queued: { readonly key: string; readonly ahead: number } | null;
  /** The step in words: `queued (<key>, <n> ahead)` while it waits. */
  readonly stepLabel: string | null;
}

/** Reads a run's state and when its current step's current attempt started. */
async function readRun(
  log: LogBackend,
  runId: string,
): Promise<{ state: KernelState; stepStartedAt: number | null }> {
  let state = initialState();
  let stepStartedAt: number | null = null;
  for await (const fact of log.read(runId)) {
    state = evolve(state, fact);
    // A new step, or a new request for the step (a retry or a recovery),
    // starts the attempt over.
    if (fact.kind === "step_entered" || fact.kind === "effect_requested") {
      stepStartedAt = fact.time;
    }
  }
  return { state, stepStartedAt };
}

/** A run that waits for a person or has ended is not running. */
function isRunning(state: KernelState): boolean {
  return state.status !== "waiting_person" && state.status !== "ended";
}

/** The step a run is in now and when that step's current attempt started. */
export interface RunStep {
  readonly step: string;
  readonly startedAt: number;
}

/**
 * What `operad running` reports for one run: its current step and the start
 * of that step's current attempt. Undefined when the run is not active (it
 * has ended, waits for a person, is unknown, or has not entered a step), so a
 * reader never shows a step as running that the run is not in.
 */
export async function currentRunStep(
  log: LogBackend,
  runId: string,
): Promise<RunStep | undefined> {
  const active = await log.runs({ active: true });
  if (!active.some((run) => run.runId === runId)) return undefined;
  const { state, stepStartedAt } = await readRun(log, runId);
  if (!isRunning(state) || state.step === null || stepStartedAt === null) return undefined;
  return { step: state.step, startedAt: stepStartedAt };
}

/** How an ended run stopped: the step it was in, if a step was in flight. */
export interface RunEnd {
  /** The step in flight when the run ended; null when it ended from a person wait or before any step. */
  readonly step: string | null;
  /** When that step's current attempt started; null with no step. */
  readonly startedAt: number | null;
  readonly endedAt: number;
}

/**
 * Where an ended run stopped, from its own facts: the step it was in and when
 * that attempt started, unless it was waiting for a person, which is not a
 * step in flight. Undefined for a run that is unknown or still active.
 */
export async function endedRunStep(
  log: LogBackend,
  runId: string,
): Promise<RunEnd | undefined> {
  const info = (await log.runs()).find((run) => run.runId === runId);
  if (info === undefined || info.active) return undefined;
  let state = initialState();
  let before: KernelState | undefined;
  let stepStartedAt: number | null = null;
  let endedAt = info.endedAt ?? info.startedAt;
  for await (const fact of log.read(runId)) {
    if (fact.kind === "run_ended") {
      before = state;
      endedAt = fact.time;
    }
    state = evolve(state, fact);
    if (fact.kind === "step_entered" || fact.kind === "effect_requested") {
      stepStartedAt = fact.time;
    }
  }
  const last = before ?? state;
  const inFlight = isRunning(last) && last.step !== null && stepStartedAt !== null;
  return {
    step: inFlight ? last.step : null,
    startedAt: inFlight ? stepStartedAt : null,
    endedAt,
  };
}

export async function listRunning(
  log: LogBackend,
  clock: () => number = () => Date.now(),
  views?: Views,
): Promise<readonly RunningItem[]> {
  const now = clock();
  const runs = (await log.runs({ active: true })).sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  const queued = await queuedSteps(log);
  const live: {
    run: (typeof runs)[number];
    state: KernelState;
    stepStartedAt: number | null;
  }[] = [];

  for (const run of runs) {
    const { state, stepStartedAt } = await readRun(log, run.runId);
    if (!isRunning(state)) continue;
    live.push({ run, state, stepStartedAt });
  }

  const rows = await rowsFor(views, live.map((item) => item.run.object));
  const items: RunningItem[] = [];
  for (const { run, state, stepStartedAt } of live) {
    const waiting = queued.get(run.runId) ?? null;
    const named = rows.get(run.object);
    items.push({
      runId: run.runId,
      flow: run.flow,
      step: state.step,
      queued: waiting,
      stepLabel:
        waiting === null
          ? state.step
          : `${state.step ?? "-"} queued (${waiting.key}, ${waiting.ahead} ahead)`,
      startedAt: run.startedAt,
      elapsedMs: Math.max(0, now - run.startedAt),
      object: named === undefined ? null : named.object,
      title: named === undefined ? null : named.title,
      stepStartedAt,
      stepElapsedMs: stepStartedAt === null ? null : Math.max(0, now - stepStartedAt),
    });
  }

  return items;
}

interface Named {
  readonly object: string;
  readonly title: string | null;
}

/**
 * The object name and row title of each run's object, from one `rowsOf` call
 * (one store read per object, the plugin's `row` once per object). A failed
 * lookup leaves the title null; it never fails the view.
 */
async function rowsFor(
  views: Views | undefined,
  keys: readonly string[],
): Promise<ReadonlyMap<string, Named>> {
  const named = new Map<string, Named>();
  const refs = new Map<string, { type: string; id: string }>();
  for (const key of keys) {
    const parsed = parseObjectKey(key);
    if (parsed !== undefined) refs.set(key, parsed);
  }
  let rows: Awaited<ReturnType<Views["rowsOf"]>> | undefined;
  if (views !== undefined && refs.size > 0) {
    try {
      rows = await views.rowsOf([...refs.values()]);
    } catch {
      rows = undefined;
    }
  }
  for (const [key, ref] of refs) {
    const row = rows?.get(key);
    if (row === undefined) {
      named.set(key, { object: ref.id, title: null });
      continue;
    }
    named.set(key, {
      object: row.scope === undefined ? row.id : `${row.scope}/${row.id}`,
      title: row.error === undefined ? row.title : null,
    });
  }
  return named;
}
