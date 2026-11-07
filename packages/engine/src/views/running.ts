/** The running view: active runs, their current step and how long they took. */

import type { LogBackend } from "../log/types.ts";
import { queuedSteps } from "../runner/limits.ts";
import { readState } from "../runner/service.ts";

export interface RunningItem {
  readonly runId: string;
  readonly flow: string;
  readonly step: string | null;
  readonly startedAt: number;
  readonly elapsedMs: number;
  /** Set while the step waits for a place under a limit key. */
  readonly queued: { readonly key: string; readonly ahead: number } | null;
  /** The step in words: `queued (<key>, <n> ahead)` while it waits. */
  readonly stepLabel: string | null;
}

export async function listRunning(
  log: LogBackend,
  clock: () => number = () => Date.now(),
): Promise<readonly RunningItem[]> {
  const now = clock();
  const runs = (await log.runs({ active: true })).sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  const items: RunningItem[] = [];
  const queued = await queuedSteps(log);

  for (const run of runs) {
    const state = await readState(log, run.runId);
    if (state.status === "waiting_person" || state.status === "ended") continue;
    const waiting = queued.get(run.runId) ?? null;
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
    });
  }

  return items;
}
