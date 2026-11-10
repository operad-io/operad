/**
 * The dev plugin's scheduler. The kernel calls `onTick`; this module decides
 * which ready tasks start, which reviewed task auto merge answers, and when a
 * plan is finished. Scheduling lives here, not in the kernel (operad decision 12).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActiveRunError,
  StateError,
  type ObjectStore,
  type StoredObject,
  type TickContext,
} from "@operad-io/engine";
import {
  bareId,
  changeClock,
  listAll,
  planData,
  priorityIndex,
  storeKey,
  taskData,
  type PlanData,
  type RepositoryData,
  type TaskData,
} from "./model.ts";
import {
  claimTaskStart,
  getPlan,
  setAreaHold,
  setDependencyHold,
  clearOldestPlanSlot,
  listRepositories,
  recordAutoMerge,
  recordMergeReported,
  recordPlanStart,
  refreshPlanCounts,
  reopenTask,
  releaseTaskClaim,
  setTaskPhase,
} from "./service.ts";
import { collectFollowups } from "./followups.ts";
import { missingPlugins } from "./standing.ts";
import {
  DEV_SETTINGS_FILE,
  readDevSettings,
  runningTaskCap,
  settingsProblem,
  type DevSettings,
} from "./settings.ts";

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

/**
 * Whether a task waits for a merge answer the scheduler gives at auto merge:
 * its review passed, its integrate has not run and it was not answered for
 * this attempt yet. Whether the plan is at auto merge is the caller's check.
 */
function autoMergeWaits(task: TaskData): boolean {
  const attempt = task.attempt;
  if (task.phase !== "waiting" || task.run === null) return false;
  if (attempt === undefined) return false;
  const review = attempt.review;
  const passed =
    review?.decision === "passed" ||
    review?.result === "pass" ||
    review?.result === "passed";
  if (!passed) return false;
  // An integrate that failed is a person wait, never a second answer.
  if (attempt.integration !== undefined && attempt.integration !== null) {
    return false;
  }
  return task.autoMergeAttempt !== attempt.number;
}

/**
 * Whether a task's wait is one the scheduler is about to answer: the task's
 * plan is confirmed at auto merge and the wait is a merge wait. It reads the
 * plan now, so a changed auto level or a refused answer ends the mark.
 */
export async function taskWaitAnsweredAutomatically(
  data: Record<string, unknown>,
  ctx: { readonly store: ObjectStore },
): Promise<boolean> {
  const task = taskData(data);
  if (!autoMergeWaits(task)) return false;
  const plan = await ctx.store.get("plan", storeKey(task.repository, planOf(task)));
  if (plan === undefined) return false;
  const found = planData(plan.data);
  if (found.status !== "confirmed" || found.auto !== "merge") return false;
  // The scheduler returns early for a repository whose settings are invalid,
  // so it answers nothing there: the wait stays visible to a person.
  const repository = (await listRepositories(ctx.store)).find(
    (item) => item.name === task.repository,
  );
  if (repository === undefined) return false;
  try {
    await readDevSettings(repository.path);
  } catch {
    return false;
  }
  return true;
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
  const value: unknown = runningTaskCap(settings);
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

async function startOne(
  ctx: TickContext,
  object: StoredObject,
  params?: Readonly<Record<string, string>>,
  oldestPlanSlot = false,
): Promise<boolean> {
  // A start that only parks the task for a person (a cancelled dependency)
  // runs no work, so it is not held by an area.
  const claimed = await claimTaskStart(ctx.store, object.id, {
    checkArea: params?.blockedBy === undefined,
    oldestPlanSlot,
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
  canStartWork: boolean,
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
    // A recovered run starts the dev flow again; without the plugins it
    // runs through, the task waits where it is.
    if (!canStartWork) continue;
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

/** What the scheduler last said about each repository's settings file. */
const reportedProblems = new Map<string, string>();

/**
 * Says once per change of the settings file that it is not valid, and says
 * nothing while it stays the same or is valid. The last valid settings stay
 * in force either way.
 */
function reportSettingsProblem(repository: RepositoryData): void {
  const problem = settingsProblem(repository.path);
  if (problem === undefined) {
    reportedProblems.delete(repository.path);
    return;
  }
  // The file's text counts, not only the message: two different edits can
  // fail with the same message.
  let text = "";
  try {
    text = readFileSync(join(repository.path, DEV_SETTINGS_FILE), "utf8");
  } catch {
    // The problem is the missing or unreadable file itself.
  }
  const state = `${problem}\n${text}`;
  if (reportedProblems.get(repository.path) === state) return;
  reportedProblems.set(repository.path, state);
  console.error(`dev: repository "${repository.name}": ${problem}`);
}

async function scheduleRepository(
  ctx: TickContext,
  repository: RepositoryData,
  initialTasks: readonly StoredObject[],
  initialPlans: readonly StoredObject[],
): Promise<void> {
  reportSettingsProblem(repository);
  let settings: DevSettings;
  try {
    settings = await readDevSettings(repository.path);
  } catch {
    // Never valid: the problem is reported and shown as pending. Nothing
    // here may touch the repository's running steps.
    return;
  }
  // Work needs the plugins dev runs its steps through; without them a task
  // stays ready instead of failing.
  const canStartWork = missingPlugins(ctx.loaded).length === 0;

  // Repair a run that ended without an edge, or one whose phase was left
  // behind, before the scheduler reads phases and starts anything else.
  await reconcileTaskRuns(ctx, repository.name, initialTasks, canStartWork);

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

  // Findings that did not fail a review become one follow-up task once the
  // plan has no open task; this runs before a plan can be reported finished.
  await collectFollowups(ctx.store, repository.name, settings);

  // A recovered claim changes the store; read the phases again before counting.
  const current = tasksOf(await listAll(ctx.store, "task"), repository.name);
  const plans = orderPlans(plansOf(initialPlans, repository.name));
  const tasksById = new Map(
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

  /** Tasks started in this tick into the slot kept for the oldest plan. */
  const oldestPlanHeld = new Set<string>();
  const lastStarted = new Map<string, number>(
    plans.map((object) => [
      bareId(object.id),
      planData(object.data).lastStartedAt ?? 0,
    ]),
  );
  const turnOf = (object: StoredObject): number =>
    lastStarted.get(bareId(object.id)) ?? 0;
  const byUrgency = (left: StoredObject, right: StoredObject): number =>
    priorityIndex(planData(left.data).priority) -
    priorityIndex(planData(right.data).priority);
  const byId = (left: StoredObject, right: StoredObject): number =>
    bareId(left.id).localeCompare(bareId(right.id));
  /** Priority first; within one priority the plan that started longest ago. */
  const turnOrder = (): readonly StoredObject[] =>
    [...plans].sort(
      (left, right) =>
        byUrgency(left, right) || turnOf(left) - turnOf(right) || byId(left, right),
    );
  /** The last free slot: longest without a start first, then most urgent. */
  const oldestPlanOrder = (): readonly StoredObject[] =>
    [...plans].sort(
      (left, right) =>
        turnOf(left) - turnOf(right) || byUrgency(left, right) || byId(left, right),
    );

  /**
   * One slot is kept for the plan that has gone longest without starting a
   * task: the last free slot goes by turn only while no running task already
   * holds that slot.
   */
  const keptSlotNext = (): boolean =>
    repositoryConcurrency(settings) > 1 &&
    repositoryConcurrency(settings) - repositoryActive === 1 &&
    !current.some((object) => {
      const task = taskData(object.data);
      return task.oldestPlanSlot === true && isActive(task);
    }) &&
    !oldestPlanHeld.size;

  /** Whether a ready task's dependencies and all three limits allow a start now. */
  const canStart = (
    object: StoredObject,
    plan: PlanData,
    planId: string,
  ): boolean => {
    if (started.has(object.id)) return false;
    const task = taskData(object.data);
    if (task.phase !== "ready") return false;
    if (!dependencyState(task, tasksById).ready) return false;
    if (!canStartWork) return false;
    if (task.area !== undefined && areaActive.has(task.area)) return false;
    if (planConcurrency(plan) - (planActive.get(planId) ?? 0) <= 0) return false;
    return repositoryActive < repositoryConcurrency(settings);
  };

  /**
   * Starts ready tasks one at a time. Each start changes whose turn it is, so
   * plans of one priority alternate; while the repository has more than one
   * slot, the last free slot goes by turn alone, whatever the priority.
   */
  const startReady = async (
    inScope: (task: TaskData, plan: PlanData) => boolean,
  ): Promise<void> => {
    const scoped = (planObject: StoredObject): readonly StoredObject[] => {
      const plan = planData(planObject.data);
      if (plan.status !== "confirmed") return [];
      return planTasks(current, bareId(planObject.id))
        .filter((object) => {
          const task = taskData(object.data);
          return task.phase === "ready" && inScope(task, plan);
        })
        .sort(byId);
    };
    // A cancelled dependency parks the task for a person; it takes no slot.
    for (const planObject of plans) {
      for (const object of scoped(planObject)) {
        const task = taskData(object.data);
        const dependencies = dependencyState(task, tasksById);
        if (dependencies.cancelled === undefined || started.has(object.id)) {
          continue;
        }
        if (
          await startOne(ctx, object, { blockedBy: dependencies.cancelled })
        ) {
          writeSchedulerLine(`${bareId(object.id)} ready -> waiting`);
          started.add(object.id);
        }
      }
    }
    const failed = new Set<string>();
    for (;;) {
      const useOldestPlan = keptSlotNext();
      const order = useOldestPlan ? oldestPlanOrder() : turnOrder();
      let progress = false;
      for (const planObject of order) {
        const plan = planData(planObject.data);
        const planId = bareId(planObject.id);
        const pick = scoped(planObject).find(
          (object) =>
            !failed.has(object.id) && canStart(object, plan, planId),
        );
        if (pick === undefined) continue;
        progress = true;
        if (!(await startOne(ctx, pick, undefined, useOldestPlan))) {
          failed.add(pick.id);
          break;
        }
        const task = taskData(pick.data);
        writeSchedulerLine(`${bareId(pick.id)} ready -> running`);
        planActive.set(planId, (planActive.get(planId) ?? 0) + 1);
        repositoryActive += 1;
        if (task.area !== undefined) areaActive.set(task.area, bareId(pick.id));
        started.add(pick.id);
        if (useOldestPlan) oldestPlanHeld.add(pick.id);
        const at = changeClock.now();
        lastStarted.set(planId, at);
        await recordPlanStart(ctx.store, planObject.id, at);
        break;
      }
      if (!progress) return;
    }
  };

  for (const planObject of plans) {
    const plan = planData(planObject.data);
    if (plan.status !== "confirmed" || plan.auto !== "merge") continue;

    for (const object of planTasks(current, bareId(planObject.id))) {
      const task = taskData(object.data);
      const attempt = task.attempt;
      if (!autoMergeWaits(task) || attempt === undefined || task.run === null) {
        continue;
      }
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

  // A task that left running while it held the kept slot no longer holds it.
  for (const object of current) {
    const task = taskData(object.data);
    if (task.oldestPlanSlot === true && !isActive(task)) {
      await clearOldestPlanSlot(ctx.store, object.id);
    }
  }

  // The owner's manual start is exempt from the auto level, not from the
  // dependencies or the limits that keep two runs off one repository.
  await startReady((task) => task.startRequested === true);
  await startReady(
    (task, plan) => plan.auto !== "off" && task.startRequested !== true,
  );

  // The queue of each area: ready tasks in the order the scheduler considers
  // them, manual starts first, so a waiting task can say how many are ahead.
  const queued: StoredObject[] = [];
  const queuedIds = new Set<string>();
  const enqueue = (inScope: (task: TaskData, plan: PlanData) => boolean) => {
    // The next start follows the order the loop above would use.
    for (const planObject of keptSlotNext() ? oldestPlanOrder() : turnOrder()) {
      const plan = planData(planObject.data);
      if (plan.status !== "confirmed") continue;
      for (const object of [...planTasks(current, bareId(planObject.id))].sort(byId)) {
        const task = taskData(object.data);
        if (task.phase !== "ready" || started.has(object.id)) continue;
        if (queuedIds.has(object.id) || !inScope(task, plan)) continue;
        if (!dependencyState(task, tasksById).ready) continue;
        queued.push(object);
        queuedIds.add(object.id);
      }
    }
  };
  enqueue((task) => task.startRequested === true);
  enqueue((task, plan) => plan.auto !== "off");
  const aheadOf = (object: StoredObject): number => {
    const area = taskData(object.data).area;
    let ahead = 0;
    for (const other of queued) {
      if (other.id === object.id) return ahead;
      if (taskData(other.data).area === area) ahead += 1;
    }
    return 0;
  };

  // Say why a ready task whose dependencies are met is not starting: its area
  // is held. The record is cleared once the area is free or the task started.
  for (const object of current) {
    const task = taskData(object.data);
    if (task.phase !== "ready" || started.has(object.id)) continue;
    const holder =
      task.area !== undefined && dependencyState(task, tasksById).ready
        ? areaActive.get(task.area)
        : undefined;
    await setAreaHold(ctx.store, object.id, holder, aheadOf(object));
    const dependencies = dependencyState(task, tasksById);
    await setDependencyHold(
      ctx.store,
      object.id,
      !dependencies.ready && dependencies.cancelled === undefined,
    );
  }

  // Keep each plan's cached counts, and with them its row's mark, current.
  for (const planObject of plans) {
    await refreshPlanCounts(ctx.store, await getPlan(ctx.store, planObject.id));
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
