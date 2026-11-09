/** The running view: active runs, their current step and how long they took. */

import type { RowMark } from "../plugin/types.ts";
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
  /** The object's row note (a plugin's word on what it waits for); null for none. */
  readonly note?: string | null;
  /** The object's row mark; omitted when the row has none. */
  readonly mark?: RowMark;
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

/** One stretch of a run: a step, or a wait for a person, with when it began and ended. */
export interface RunSegment {
  readonly step: string;
  /** True while the run waited for a person in this step. */
  readonly person: boolean;
  readonly from: number;
  /** Null while the stretch is still open (the run is active). */
  readonly to: number | null;
}

/** A run's own times, read from its facts and nothing else. */
export interface RunTimes {
  readonly startedAt: number;
  /** When the run ended (its end fact, else the log's end); null while it is active. */
  readonly endedAt: number | null;
  /** The stretches in order: each is a step, or a wait for a person in a step. */
  readonly segments: readonly RunSegment[];
}

/**
 * A run's start, its end and the stretches between: a step runs from its
 * `step_entered` until it hands over or the run ends; a wait for a person is
 * a stretch of its own. A stretch of no time is left out. Undefined for a run the log does not know.
 */
export async function runTimes(
  log: LogBackend,
  runId: string,
): Promise<RunTimes | undefined> {
  const info = (await log.runs()).find((run) => run.runId === runId);
  if (info === undefined) return undefined;
  let state = initialState();
  let startedAt = info.startedAt;
  let endedAt: number | null = null;
  const segments: { step: string; person: boolean; from: number; to: number | null }[] = [];
  for await (const fact of log.read(runId)) {
    if (fact.kind === "run_started") startedAt = fact.time;
    state = evolve(state, fact);
    const wanted =
      state.status === "ended" || state.step === null
        ? undefined
        : { step: state.step, person: state.status === "waiting_person" };
    const open = segments[segments.length - 1];
    const same =
      wanted !== undefined &&
      open?.to === null &&
      open.step === wanted.step &&
      open.person === wanted.person;
    if (open?.to === null && !same) {
      // A stretch that began and ended in the same instant carries no time.
      if (open.from === fact.time) segments.pop();
      else open.to = fact.time;
    }
    if (wanted !== undefined && !same) segments.push({ ...wanted, from: fact.time, to: null });
    if (fact.kind === "run_ended") endedAt = fact.time;
  }
  if (endedAt === null && !info.active) endedAt = info.endedAt ?? startedAt;
  if (endedAt !== null) {
    for (const segment of segments) if (segment.to === null) segment.to = endedAt;
  }
  return { startedAt, endedAt, segments };
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
      note: named?.note ?? null,
      ...(named?.mark === undefined ? {} : { mark: named.mark }),
      stepStartedAt,
      stepElapsedMs: stepStartedAt === null ? null : Math.max(0, now - stepStartedAt),
    });
  }

  return items;
}

interface Named {
  readonly object: string;
  readonly title: string | null;
  readonly note?: string | null;
  readonly mark?: RowMark;
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
      note: row.error === undefined ? (row.note ?? null) : null,
      ...(row.error === undefined && row.mark !== undefined ? { mark: row.mark } : {}),
    });
  }
  return named;
}
