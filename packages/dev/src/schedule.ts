/**
 * The dev plugin's scheduler. The kernel calls `onTick`; this module decides
 * which ready tasks start, which reviewed task auto merge answers, and when a
 * plan is finished. Scheduling lives here, not in the kernel (operad decision 12).
 */

import {
  StateError,
  type ObjectStore,
  type StoredObject,
  type TickContext,
} from "@operad-io/engine";
import {
  bareId,
  listAll,
  planData,
  priorityIndex,
  taskData,
  type PlanData,
  type RepositoryData,
  type TaskData,
} from "./model.ts";
import {
  claimTaskStart,
  listRepositories,
  recordAutoMerge,
  waitTaskForDependency,
} from "./service.ts";
import { readDevSettings, type DevSettings } from "./settings.ts";

/** Where a scheduler change goes: the kernel loop's output. */
export const schedulerTestHooks: {
  write?: ((line: string) => void) | undefined;
} = {};

export function writeSchedulerLine(line: string): void {
  const write = schedulerTestHooks.write ?? ((text: string) => console.log(text));
  write(line);
}

function isActive(task: TaskData): boolean {
  return task.phase === "running" || task.phase === "review";
}

function planOf(task: TaskData): string {
  return task.plan;
}

function tasksOf(
  tasks: readonly StoredObject[],
  repository: string,
): readonly StoredObject[] {
  return tasks.filter(
    (object) => taskData(object.data).repository === repository,
  );
}

function plansOf(
  plans: readonly StoredObject[],
  repository: string,
): readonly StoredObject[] {
  return plans.filter(
    (object) => planData(object.data).repository === repository,
  );
}

function planTasks(
  tasks: readonly StoredObject[],
  plan: string,
): readonly StoredObject[] {
  return tasks.filter((object) => planOf(taskData(object.data)) === plan);
}

/** Plans in the order the scheduler considers them: most urgent first. */
function orderPlans(plans: readonly StoredObject[]): readonly StoredObject[] {
  return [...plans].sort((left, right) => {
    const leftPlan = planData(left.data);
    const rightPlan = planData(right.data);
    const byPriority =
      priorityIndex(leftPlan.priority) - priorityIndex(rightPlan.priority);
    if (byPriority !== 0) return byPriority;
    return bareId(left.id).localeCompare(bareId(right.id));
  });
}

interface DependencyState {
  readonly ready: boolean;
  readonly cancelled?: string | undefined;
}

/** A task starts once every task it follows is merged. */
function dependencyState(
  task: TaskData,
  byId: ReadonlyMap<string, TaskData>,
): DependencyState {
  for (const id of task.after) {
    const dependency = byId.get(id);
    if (dependency === undefined) return { ready: false };
    if (dependency.phase === "cancelled") {
      return { ready: false, cancelled: id };
    }
    if (dependency.phase !== "merged") return { ready: false };
  }
  return { ready: true };
}

function planConcurrency(plan: PlanData): number {
  const value: unknown = plan.concurrency;
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

function repositoryConcurrency(settings: DevSettings): number {
  const value: unknown = settings.concurrency;
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

async function startOne(
  ctx: TickContext,
  object: StoredObject,
): Promise<boolean> {
  const claimed = await claimTaskStart(ctx.store, object.id);
  if (claimed === undefined) return false;
  await ctx.start({
    flow: "dev",
    object: { type: "task", id: object.id },
  });
  writeSchedulerLine(`${bareId(object.id)} ready -> running`);
  return true;
}

/** Marks a plan finished once, when every task has merged or been cancelled. */
async function reportFinishedPlans(
  store: ObjectStore,
  plans: readonly StoredObject[],
  tasks: readonly StoredObject[],
): Promise<void> {
  for (const object of plans) {
    const plan = planData(object.data);
    if (plan.status !== "confirmed" || plan.finishedReported === true) {
      continue;
    }
    const mine = planTasks(tasks, bareId(object.id));
    if (mine.length === 0) continue;
    const finished = mine.every((task) => {
      const phase = taskData(task.data).phase;
      return phase === "merged" || phase === "cancelled";
    });
    if (!finished) continue;
    await store.put(
      "plan",
      object.id,
      { ...plan, finishedReported: true },
      "dev:plan-finished",
    );
    writeSchedulerLine(`${bareId(object.id)} confirmed -> finished`);
  }
}

async function scheduleRepository(
  ctx: TickContext,
  repository: RepositoryData,
  initialTasks: readonly StoredObject[],
  initialPlans: readonly StoredObject[],
): Promise<void> {
  const settings = await readDevSettings(repository.path);
  const tasks = tasksOf(initialTasks, repository.name);
  const plans = orderPlans(plansOf(initialPlans, repository.name));
  const planById = new Map(
    plans.map((object) => [bareId(object.id), planData(object.data)]),
  );

  // The owner's manual start comes first, regardless of auto and concurrency.
  for (const object of [...tasks].sort((left, right) =>
    bareId(left.id).localeCompare(bareId(right.id)),
  )) {
    const task = taskData(object.data);
    if (task.startRequested !== true) continue;
    const plan = planById.get(task.plan);
    if (plan === undefined || plan.status === "cancelled") continue;
    await startOne(ctx, object);
  }

  // A manual start changes the store; read the phases again before counting.
  const current = tasksOf(await listAll(ctx.store, "task"), repository.name);
  const byId = new Map(
    current.map((object) => [bareId(object.id), taskData(object.data)]),
  );

  await reportFinishedPlans(ctx.store, plans, current);

  let repositoryActive = current.filter((object) =>
    isActive(taskData(object.data)),
  ).length;

  for (const planObject of plans) {
    const plan = planData(planObject.data);
    if (plan.status !== "confirmed") continue;

    const mine = planTasks(current, bareId(planObject.id));

    if (plan.auto === "merge") {
      for (const object of mine) {
        const task = taskData(object.data);
        const attempt = task.attempt;
        if (task.phase !== "waiting" || task.run === null) continue;
        if (attempt === undefined || attempt.review?.result !== "pass") {
          continue;
        }
        // An integrate that failed is a person wait, never a second answer.
        if (attempt.integration !== undefined && attempt.integration !== null) {
          continue;
        }
        if (task.autoMergeAttempt === attempt.number) continue;
        try {
          await ctx.answer(task.run, "merge");
        } catch (error) {
          // Another client answered first; the run is no longer waiting.
          if (!(error instanceof StateError)) throw error;
          continue;
        }
        await recordAutoMerge(ctx.store, object.id, attempt.number);
        writeSchedulerLine(`${bareId(object.id)} waiting -> merged`);
      }
    }

    if (plan.auto === "off") continue;

    let planActive = mine.filter((object) =>
      isActive(taskData(object.data)),
    ).length;
    let slots = Math.min(
      planConcurrency(plan) - planActive,
      repositoryConcurrency(settings) - repositoryActive,
    );

    const ready = mine
      .filter((object) => taskData(object.data).phase === "ready")
      .sort((left, right) => bareId(left.id).localeCompare(bareId(right.id)));

    for (const object of ready) {
      const task = taskData(object.data);
      const dependencies = dependencyState(task, byId);
      if (dependencies.cancelled !== undefined) {
        const blocked = await waitTaskForDependency(
          ctx.store,
          object.id,
          dependencies.cancelled,
        );
        if (blocked !== undefined) {
          writeSchedulerLine(`${bareId(object.id)} ready -> waiting`);
        }
        continue;
      }
      if (!dependencies.ready) continue;
      if (slots <= 0) break;
      const started = await startOne(ctx, object);
      if (!started) continue;
      slots -= 1;
      planActive += 1;
      repositoryActive += 1;
    }
  }
}

/**
 * One scheduler tick. Each registered repository is scheduled on its own, so a
 * slow or broken repository cannot stop another one.
 */
export async function runScheduler(ctx: TickContext): Promise<void> {
  const repositories = await listRepositories(ctx.store);
  if (repositories.length === 0) return;
  const tasks = await listAll(ctx.store, "task");
  const plans = await listAll(ctx.store, "plan");
  for (const repository of repositories) {
    try {
      await scheduleRepository(ctx, repository, tasks, plans);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`dev: repository "${repository.name}": ${message}`);
    }
  }
}
