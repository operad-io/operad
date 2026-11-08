/**
 * The dev plugin's scheduler. The kernel calls `onTick`; this module decides
 * which ready tasks start, which reviewed task auto merge answers, and when a
 * plan is finished. Scheduling lives here, not in the kernel (operad decision 12).
 */

import {
  ActiveRunError,
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
  setAreaHold,
  listRepositories,
  recordAutoMerge,
  recordMergeReported,
  reopenTask,
  releaseTaskClaim,
  setTaskPhase,
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
  params?: Readonly<Record<string, string>>,
): Promise<boolean> {
  // A start that only parks the task for a person (a cancelled dependency)
  // runs no work, so it is not held by an area.
  const claimed = await claimTaskStart(ctx.store, object.id, {
    checkArea: params?.blockedBy === undefined,
  });
  if (claimed === undefined) return false;
  const token = claimed.claim?.token;
  const startParams: Readonly<Record<string, string>> | undefined =
    token === undefined
      ? params
      : { ...(params ?? {}), token };
  await ctx.start({
    flow: "dev",
    object: { type: "task", id: object.id },
    ...(startParams === undefined ? {} : { params: startParams }),
  });
  return true;
}

/**
 * Reports what the integrate step did to a task whose merge the scheduler
 * answered. The task's phase is the real one when this runs, so a failure and
 * a conflict each print their own transition; only a landed merge prints
 * `merged`. Each attempt is reported once.
 */
async function reportIntegrationResults(
  store: ObjectStore,
  tasks: readonly StoredObject[],
): Promise<void> {
  for (const object of tasks) {
    const task = taskData(object.data);
    const attempt = task.attempt;
    if (attempt === undefined || task.autoMergeAttempt !== attempt.number) {
      continue;
    }
    if (task.mergeReportedAttempt === attempt.number) continue;
    const result = attempt.integration?.result;
    let phase: string | undefined;
    if (result === "merged") phase = "merged";
    else if (result === "failed") phase = "waiting";
    else if (result === "conflict" || result === "fail") phase = "running";
    if (phase === undefined) continue;
    await recordMergeReported(store, object.id, attempt.number);
    writeSchedulerLine(`${bareId(object.id)} integrating -> ${phase}`);
  }
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

/**
 * Makes every task's phase follow its run. A task whose run paused for a
 * person says `waiting`; a task whose run is gone is repaired to a waiting
 * task with a pending item, never left as `running` or `waiting` with nothing
 * to act on. The check needs the kernel's run lookup, which only `serve`
 * supplies.
 */
async function reconcileTaskRuns(
  ctx: TickContext,
  repository: string,
  tasks: readonly StoredObject[],
): Promise<void> {
  const runs = ctx.runLookup;
  if (runs === undefined) return;
  for (const object of tasksOf(tasks, repository)) {
    const task = taskData(object.data);
    if (task.phase !== "waiting" && task.phase !== "running") continue;
    const active = await runs.active(`task:${object.id}`);
    const run = active[0];
    if (run !== undefined) {
      // A run paused for a person is the truth: the task is waiting.
      const state = await runs.state(run.runId);
      if (state?.status === "waiting_person" && task.phase === "running") {
        await setTaskPhase(ctx.store, object.id, "waiting", { run: run.runId });
        writeSchedulerLine(`${bareId(object.id)} running -> waiting`);
      }
      continue;
    }
    // A running task with no run id is a start that never landed; the claim
    // release below gives it back to ready.
    if (task.phase === "running" && task.run === null) continue;
    const step = task.run === null ? null : await runs.lastStep(task.run);
    if ((await reopenTask(ctx.store, object.id)) === undefined) continue;
    try {
      if (await startOne(ctx, object, { runStoppedAt: step ?? "the run" })) {
        writeSchedulerLine(
          `${bareId(object.id)} ${task.phase} -> waiting (run stopped during ${step ?? "the run"})`,
        );
      }
    } catch (error) {
      if (!(error instanceof ActiveRunError)) throw error;
    }
  }
}

async function scheduleRepository(
  ctx: TickContext,
  repository: RepositoryData,
  initialTasks: readonly StoredObject[],
  initialPlans: readonly StoredObject[],
): Promise<void> {
  const settings = await readDevSettings(repository.path);

  // Repair a run that ended without an edge, or one whose phase was left
  // behind, before the scheduler reads phases and starts anything else.
  await reconcileTaskRuns(ctx, repository.name, initialTasks);

  // A claim is not durable until the kernel records the run. A task left
  // running with no run is a start that never landed (a crash or a kernel
  // failure between the two writes): give it back to ready, and this tick
  // starts it again. A run that already exists is never duplicated, because
  // the kernel refuses a second run for an object.
  // A claim whose run the kernel already holds is a start still landing: the
  // run's first step records its id moments later. Releasing it would cancel
  // that run and start another one on the next tick, forever.
  for (const object of tasksOf(initialTasks, repository.name)) {
    const task = taskData(object.data);
    if (task.phase !== "running" || task.run !== null) continue;
    if (
      ctx.runLookup !== undefined &&
      (await ctx.runLookup.active(`task:${object.id}`)).length > 0
    ) {
      continue;
    }
    if ((await releaseTaskClaim(ctx.store, object.id)) === undefined) continue;
    writeSchedulerLine(`${bareId(object.id)} running -> ready`);
  }

  // A recovered claim changes the store; read the phases again before counting.
  const current = tasksOf(await listAll(ctx.store, "task"), repository.name);
  const plans = orderPlans(plansOf(initialPlans, repository.name));
  const byId = new Map(
    current.map((object) => [bareId(object.id), taskData(object.data)]),
  );

  await reportIntegrationResults(ctx.store, current);
  await reportFinishedPlans(ctx.store, plans, current);

  const planActive = new Map<string, number>();
  for (const planObject of plans) {
    const id = bareId(planObject.id);
    planActive.set(
      id,
      planTasks(current, id).filter((object) =>
        isActive(taskData(object.data)),
      ).length,
    );
  }
  let repositoryActive = current.filter((object) =>
    isActive(taskData(object.data)),
  ).length;
  const started = new Set<string>();
  // Which running or reviewing task holds each area in this repository.
  const areaActive = new Map<string, string>();
  for (const object of current) {
    const task = taskData(object.data);
    if (task.area !== undefined && isActive(task) && !areaActive.has(task.area)) {
      areaActive.set(task.area, bareId(object.id));
    }
  }

  /** Starts one ready task when its dependencies and both limits allow it. */
  const startEligible = async (
    object: StoredObject,
    plan: PlanData,
    planId: string,
  ): Promise<void> => {
    if (started.has(object.id)) return;
    const task = taskData(object.data);
    if (task.phase !== "ready") return;
    const dependencies = dependencyState(task, byId);
    if (dependencies.cancelled !== undefined) {
      // A cancelled dependency makes the task a person wait. The run starts at
      // the worktree step, which recognises the parameter and logs a real
      // `waiting_person` run instead of preparing a worktree.
      if (!(await startOne(ctx, object, { blockedBy: dependencies.cancelled }))) {
        return;
      }
      writeSchedulerLine(`${bareId(object.id)} ready -> waiting`);
      started.add(object.id);
      return;
    }
    if (!dependencies.ready) return;
    if (task.area !== undefined && areaActive.has(task.area)) return;
    if (planConcurrency(plan) - (planActive.get(planId) ?? 0) <= 0) return;
    if (repositoryActive >= repositoryConcurrency(settings)) return;
    if (!(await startOne(ctx, object))) return;
    writeSchedulerLine(`${bareId(object.id)} ready -> running`);
    planActive.set(planId, (planActive.get(planId) ?? 0) + 1);
    repositoryActive += 1;
    if (task.area !== undefined) areaActive.set(task.area, bareId(object.id));
    started.add(object.id);
  };

  for (const planObject of plans) {
    const plan = planData(planObject.data);
    if (plan.status !== "confirmed" || plan.auto !== "merge") continue;

    for (const object of planTasks(current, bareId(planObject.id))) {
      const task = taskData(object.data);
      const attempt = task.attempt;
      if (task.phase !== "waiting" || task.run === null) continue;
      if (attempt === undefined) continue;
      const review = attempt.review;
      const passed =
        review?.decision === "passed" ||
        review?.result === "pass" ||
        review?.result === "passed";
      if (!passed) continue;
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
      writeSchedulerLine(`${bareId(object.id)} waiting -> integrating`);
    }
  }

  // The owner's manual start is exempt from the auto level, not from the
  // dependencies or the limits that keep two runs off one repository.
  for (const planObject of plans) {
    const plan = planData(planObject.data);
    if (plan.status !== "confirmed") continue;
    const planId = bareId(planObject.id);
    const requested = planTasks(current, planId)
      .filter((object) => {
        const task = taskData(object.data);
        return task.phase === "ready" && task.startRequested === true;
      })
      .sort((left, right) => bareId(left.id).localeCompare(bareId(right.id)));
    for (const object of requested) {
      await startEligible(object, plan, planId);
    }
  }

  for (const planObject of plans) {
    const plan = planData(planObject.data);
    if (plan.status !== "confirmed" || plan.auto === "off") continue;
    const planId = bareId(planObject.id);
    const ready = planTasks(current, planId)
      .filter((object) => {
        const task = taskData(object.data);
        return task.phase === "ready" && task.startRequested !== true;
      })
      .sort((left, right) => bareId(left.id).localeCompare(bareId(right.id)));
    for (const object of ready) {
      await startEligible(object, plan, planId);
    }
  }

  // Say why a ready task whose dependencies are met is not starting: its area
  // is held. The record is cleared once the area is free or the task started.
  for (const object of current) {
    const task = taskData(object.data);
    if (task.phase !== "ready" || started.has(object.id)) continue;
    const holder =
      task.area !== undefined && dependencyState(task, byId).ready
        ? areaActive.get(task.area)
        : undefined;
    await setAreaHold(ctx.store, object.id, holder);
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
