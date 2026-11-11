/**
 * The task's own word while its step waits for a check place: the attempt
 * records which place group it waits for and how many waiters are ahead, and
 * the row's note and mark read it. The step clears it when the place is taken.
 */

import type { StepContext } from "@operad-io/engine";
import { listAll, taskData, type TaskData } from "./model.ts";
import { saveTaskGuarded } from "./steps.ts";

/** A task's wait for a check place, as the attempt records it. */
export interface PlaceWait {
  readonly key: string;
  /** When this wait began; waiters of one group are served in this order. */
  readonly since: number;
  readonly ahead: number;
}

/** What the row says while a step waits for a check place. */
export function placeWaitNote(task: TaskData): string | undefined {
  const wait = task.attempt?.placeWait;
  if (wait === undefined || wait === null) return undefined;
  return `waiting for a ${wait.key}${wait.ahead > 0 ? `, ${wait.ahead} ahead` : ""}`;
}

/**
 * Records on the task that its step waits for `key` (with the waiters ahead of
 * it), or clears the record when `key` is null. Writes only when the record
 * changes, and only while the step still owns its claim.
 */
export async function taskPlaceWait(
  ctx: StepContext,
  taskKey: string,
  key: string | null,
): Promise<void> {
  const object = await ctx.store.get("task", taskKey);
  if (object === undefined) return;
  const task = taskData(object.data);
  const attempt = task.attempt;
  // A step with no attempt has no row to mark.
  if (attempt === undefined) return;
  const current = attempt.placeWait ?? null;
  if (key === null) {
    if (current === null) return;
    await saveTaskGuarded(
      ctx,
      taskKey,
      { ...task, attempt: { ...attempt, placeWait: null } },
      "dev:place-wait",
    );
    return;
  }
  const since = current?.key === key ? current.since : Date.now();
  let ahead = 0;
  for (const other of await listAll(ctx.store, "task")) {
    if (other.id === object.id) continue;
    const wait = taskData(other.data).attempt?.placeWait;
    if (wait === undefined || wait === null || wait.key !== key) continue;
    if (wait.since < since || (wait.since === since && other.id < object.id)) ahead += 1;
  }
  if (current?.key === key && current.ahead === ahead) return;
  await saveTaskGuarded(
    ctx,
    taskKey,
    { ...task, attempt: { ...attempt, placeWait: { key, since, ahead } } },
    "dev:place-wait",
  );
}
