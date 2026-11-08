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
    let state = initialState();
    let stepStartedAt: number | null = null;
    for await (const fact of log.read(run.runId)) {
      state = evolve(state, fact);
      // A new step, or a new request for the step (a retry or a recovery),
      // starts the attempt over.
      if (fact.kind === "step_entered" || fact.kind === "effect_requested") {
        stepStartedAt = fact.time;
      }
    }
    if (state.status === "waiting_person" || state.status === "ended") continue;
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
