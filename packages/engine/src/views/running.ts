/** The running view: active runs, their current step and how long they took. */

import type { LogBackend } from "../log/types.ts";
import { readState } from "../runner/service.ts";

export interface RunningItem {
  readonly runId: string;
  readonly flow: string;
  readonly step: string | null;
  readonly startedAt: number;
  readonly elapsedMs: number;
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

  for (const run of runs) {
    const state = await readState(log, run.runId);
    if (state.status === "waiting_person" || state.status === "ended") continue;
    items.push({
      runId: run.runId,
      flow: run.flow,
      step: state.step,
      startedAt: run.startedAt,
      elapsedMs: Math.max(0, now - run.startedAt),
    });
  }

  return items;
}
