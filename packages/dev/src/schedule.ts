/**
 * The dev plugin's scheduler. The kernel calls `onTick`; this module decides
 * which ready tasks start, which reviewed task auto merge answers, and when a
 * plan is finished. Scheduling lives here, not in the kernel (ADR 0002 D1).
 */

import { isRecord, messageOf } from "@operad-io/engine";
import { DEFAULT_POOL } from "@operad-io/pool";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActiveRunError,
  StateError,
  type FlowDefinition,
  type ObjectStore,
  type StoredObject,
  type TickContext,
} from "@operad-io/engine";
import {
  bareId,
  changeClock,
  dependencyKey,
  dependencyLabel,
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
  setFlowNote,
  setSlotHold,
  clearOldestPlanSlot,
  listRepositories,
  recordAutoMerge,
  recordMergeReported,
  moveTaskPhase,
  recordPlanStart,
  recordPlanFinishedReported,
  refreshPlanCounts,
  reopenTask,
  releaseTaskClaim,
} from "./service.ts";
import { loadProjectFlows, PROJECT_FLOWS_DIR } from "./project-flows.ts";
import { collectFollowups } from "./followups.ts";
import { missingPlugins } from "./standing.ts";
import { checkHostWarning } from "./check-host.ts";
import {
  compileDevFlow,
  DEFAULT_FLOW_NAME,
  flowNameFor,
} from "./flow-compiler.ts";
import {
  DEV_SETTINGS_FILE,
  readDevSettings,
  flowPool,
  repositoryTaskCap,
  runningTaskCap,
  settingsProblem,
  type DevSettings,
} from "./settings.ts";

/** Where a scheduler change goes: the kernel loop's output. */
export const schedulerTestHooks: {
  write?: ((line: string) => void) | undefined;
  /** Called before a generated flow is handed to the kernel; a test counts them. */
  declare?: ((flow: FlowDefinition) => void) | undefined;
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

/** The flow a ready task starts when it has no flow recorded yet. */
interface StartFlow {
  readonly name: string;
  readonly graph?: FlowDefinition | undefined;
}

/** Every flow a repository declares, by name, and the one `default` means. */
interface RepositoryFlows {
  readonly named: ReadonlyMap<string, StartFlow>;
  readonly fallback: StartFlow;
  /** Names dev refused, each with the reason. */
  readonly refused: ReadonlyMap<string, string>;
}

/** The compiled settings flows of one repository, keyed by the settings' content. */
interface CompiledFlows {
  readonly starts: ReadonlyMap<string, StartFlow>;
}

/** The compiled settings flows of each store's repositories, by repository name. */
const compiledFlows = new WeakMap<ObjectStore, Map<string, { readonly key: string; readonly value: CompiledFlows }>>();

/** The content-addressed flow names this process already declared in a store. */
const declaredFlowNames = new WeakMap<ObjectStore, Set<string>>();

function settingsKey(settings: DevSettings): string {
  return JSON.stringify(settings);
}

/** Compiles a repository's settings flows once for each settings text. */
function compiledSettingsFlows(
  store: ObjectStore,
  repository: RepositoryData,
  settings: DevSettings,
): CompiledFlows {
  let byRepository = compiledFlows.get(store);
  if (byRepository === undefined) {
    byRepository = new Map();
    compiledFlows.set(store, byRepository);
  }
  const key = `${repository.name}\n${settingsKey(settings)}`;
  const kept = byRepository.get(repository.name);
  if (kept !== undefined && kept.key === key) return kept.value;
  const starts = new Map<string, StartFlow>();
  for (const [flowName, spec] of Object.entries(settings.flows)) {
    const name = flowNameFor(repository.name, flowName, spec);
    starts.set(flowName, {
      name,
      graph: compileDevFlow(name, spec.stages, { gradingName: flowName }),
    });
  }
  const value = { starts };
  byRepository.set(repository.name, { key, value });
  return value;
}

/** A generated name carries a hash of its graph; the built-in `dev` does not. */
function contentAddressed(name: string): boolean {
  return /^dev\/[^/]+\/[^/]+\/[0-9a-f]{12}$/.test(name);
}

/**
 * Declares a content-addressed flow once per store in this process. The set
 * lives beside the store object, so it serves an in-memory store as well as a
 * file store; a later process starts its own set.
 */
function declareFlowOnce(ctx: TickContext, graph: FlowDefinition): void {
  const name = graph.name;
  if (contentAddressed(name)) {
    let declared = declaredFlowNames.get(ctx.store);
    if (declared?.has(name)) return;
    schedulerTestHooks.declare?.(graph);
    ctx.declareFlow(graph);
    if (declared === undefined) {
      declared = new Set();
      declaredFlowNames.set(ctx.store, declared);
    }
    declared.add(name);
    return;
  }
  schedulerTestHooks.declare?.(graph);
  ctx.declareFlow(graph);
}

/**
 * Declares every flow the repository sets. A repository that writes no `flows`
 * runs the built-in `dev` flow, so its old runs and tests keep their ids.
 */
async function declareRepositoryFlows(
  ctx: TickContext,
  repository: RepositoryData,
  settings: DevSettings,
): Promise<RepositoryFlows> {
  const named = new Map<string, StartFlow>();
  let fallback: StartFlow = { name: DEFAULT_FLOW_NAME };
  const project = await loadProjectFlows(repository.path, repository.name, settings);
  const refused = new Map(project.refused);
  const compiled = compiledSettingsFlows(ctx.store, repository, settings);
  for (const [flowName, start] of compiled.starts) {
    if (refused.has(flowName)) continue;
    if (start.graph !== undefined) declareFlowOnce(ctx, start.graph);
    named.set(flowName, start);
    if (flowName === "default") fallback = start;
  }
  for (const [flowName, graph] of project.flows) {
    try {
      declareFlowOnce(ctx, graph);
    } catch (error) {
      refused.set(
        flowName,
        `${PROJECT_FLOWS_DIR}/${flowName}.flow.ts: ${messageOf(error)}`,
      );
      continue;
    }
    const start = { name: graph.name, graph };
    named.set(flowName, start);
    if (flowName === "default") fallback = start;
  }
  named.set("default", fallback);
  return { named, fallback, refused };
}

/** The repository flow a task starts with, or undefined when it names none. */
function flowFor(
  flows: RepositoryFlows,
  name: string | undefined,
): StartFlow | undefined {
  const wanted = name ?? "default";
  if (flows.refused.has(wanted)) return undefined;
  return flows.named.get(wanted);
}

/** What the scheduler last said about a task whose flow name is unknown. */
const reportedFlowProblems = new Map<string, string>();

/** Says once per task and name that its flow is not in dev.json. */
function reportFlowProblem(
  id: string,
  name: string | undefined,
  refused?: string,
): void {
  const wanted = name ?? "default";
  if (reportedFlowProblems.get(id) === wanted) return;
  reportedFlowProblems.set(id, wanted);
  writeSchedulerLine(
    `${bareId(id)} ready -> ready (${refused ?? `no flow "${wanted}" in dev.json`})`,
  );
}

/** What the scheduler last said about each task whose recorded graph is refused. */
const reportedStoredFlows = new Map<string, string>();

/**
 * Declares the graph a task started with. False when the task has none, or
 * when today's steps refuse it: a graph recorded by an older dev may lack an
 * edge for a result a step has since gained. The refusal is said once per
 * task and reason, and only that task loses its recorded graph; the
 * repository's other tasks are still scheduled.
 */
function declareStoredFlow(ctx: TickContext, object: StoredObject): boolean {
  const graph = taskData(object.data).flowGraph;
  if (graph === undefined) return false;
  try {
    declareFlowOnce(ctx, graph);
    reportedStoredFlows.delete(object.id);
    return true;
  } catch (error) {
    const reason = messageOf(error);
    if (reportedStoredFlows.get(object.id) !== reason) {
      reportedStoredFlows.set(object.id, reason);
      writeSchedulerLine(
        `${bareId(object.id)} keeps no recorded flow: ${reason}; a new start uses the repository's flow`,
      );
    }
    return false;
  }
}

/**
 * Re-declares the graph every open task started with, so a fresh process
 * resumes it. A merged or cancelled task runs nothing again.
 */
function declareStoredFlows(ctx: TickContext, tasks: readonly StoredObject[]): void {
  for (const object of tasks) {
    const phase = taskData(object.data).phase;
    if (phase === "merged" || phase === "cancelled") continue;
    declareStoredFlow(ctx, object);
  }
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
 * Whether a task's flow has a configured human stage that no review stage
 * comes before, and the code and test before it finished well: the wait the
 * task is in is that stage. A review before the human stage is answered
 * through its pass; a review after it has not run yet at that wait.
 */
function atHumanStage(task: TaskData): boolean {
  const steps = task.flowGraph?.steps;
  const attempt = task.attempt;
  if (steps === undefined || attempt === undefined) return false;
  const indexOf = (kind: string): number =>
    steps.findIndex((step) => new RegExp(`^${kind}(_\\d+)?$`).test(step.id));
  const human = indexOf("human");
  if (human < 0) return false;
  const review = indexOf("review");
  if (review >= 0 && review < human) return false;
  // A review after the human stage has not run while the task waits here.
  if (review > human && attempt.review !== undefined && attempt.review !== null) {
    return false;
  }
  if (attempt.result !== undefined && attempt.result !== null && attempt.result !== "done") {
    return false;
  }
  const check = indexOf("check");
  if (check >= 0 && check < human) return attempt.verify?.result === "pass";
  return attempt.worked === true;
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
  if (!passed && !atHumanStage(task)) return false;
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
  /** The tasks not merged yet, as a note names them. */
  readonly waitingFor: readonly string[];
}

/**
 * A task starts once every task it follows is merged, in any plan and any
 * repository. `byKey` holds the tasks of every repository by store key.
 */
function dependencyState(
  task: TaskData,
  byKey: ReadonlyMap<string, TaskData>,
): DependencyState {
  const waitingFor: string[] = [];
  let cancelled: string | undefined;
  for (const entry of task.after) {
    const key = dependencyKey(task.repository, entry);
    const label = dependencyLabel(task.repository, key);
    const dependency = byKey.get(key);
    if (dependency?.phase === "merged") continue;
    waitingFor.push(label);
    if (dependency?.phase === "cancelled" && cancelled === undefined) {
      cancelled = label;
    }
  }
  return {
    ready: waitingFor.length === 0,
    ...(cancelled === undefined ? {} : { cancelled }),
    waitingFor,
  };
}

/** The pool of the first `dev/work` step of the graph a task started with, whatever the step is named. */
function storedGraphPool(graph: FlowDefinition | undefined): string | undefined {
  for (const step of graph?.steps ?? []) {
    const outer: unknown = step.params;
    if (typeof outer !== "object" || outer === null) continue;
    const { use, params } = outer as { use?: unknown; params?: unknown };
    if (use !== "dev/work") continue;
    const pool: unknown = isRecord(params) ? params.flowPool : undefined;
    return typeof pool === "string" ? pool : DEFAULT_POOL;
  }
  return undefined;
}

function planConcurrency(plan: PlanData): number {
  const value: unknown = plan.concurrency;
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

function repositoryConcurrency(settings: DevSettings, pool?: string): number {
  const value: unknown =
    pool === undefined ? repositoryTaskCap(settings) : runningTaskCap(settings, pool);
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

async function startOne(
  ctx: TickContext,
  object: StoredObject,
  params?: Readonly<Record<string, string>>,
  oldestPlanSlot = false,
  fallbackFlow: StartFlow = { name: DEFAULT_FLOW_NAME },
): Promise<boolean> {
  const stored = taskData(object.data);
  // A recorded graph today's steps refuse cannot run; the start takes the
  // repository's flow and records that one instead.
  const flow =
    stored.flowName !== undefined &&
    (stored.flowGraph === undefined || declareStoredFlow(ctx, object))
      ? { name: stored.flowName, graph: stored.flowGraph }
      : fallbackFlow;
  // A task that started before the repository's flow changed keeps the graph
  // it started with; the name is content-addressed, so a new graph gets a new
  // name and never replaces the running attempt's definition.
  if (flow?.graph !== undefined) ctx.declareFlow(flow.graph);
  // A start that only parks the task for a person (a cancelled dependency)
  // runs no work, so it is not held by an area.
  const claimed = await claimTaskStart(ctx.store, object.id, {
    checkArea: params?.blockedBy === undefined,
    oldestPlanSlot,
    ...(flow === undefined
      ? {}
      : { flow: { name: flow.name, ...(flow.graph === undefined ? {} : { graph: flow.graph }) } }),
  });
  if (claimed === undefined) return false;
  const token = claimed.claim?.token;
  const startParams: Readonly<Record<string, string>> | undefined =
    token === undefined
      ? params
      : { ...(params ?? {}), token };
  await ctx.start({
    flow: flow?.name ?? DEFAULT_FLOW_NAME,
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
): Promise<boolean> {
  let changed = false;
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
    if (!(await recordMergeReported(store, object.id, attempt.number))) continue;
    changed = true;
    writeSchedulerLine(`${bareId(object.id)} integrating -> ${phase}`);
  }
  return changed;
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
    if (!(await recordPlanFinishedReported(store, object.id))) continue;
    writeSchedulerLine(`${bareId(object.id)} confirmed -> finished`);
  }
}

/**
 * Ends a run that is still active on a cancelled task. A cancel that could
 * not reach its run (one made where no run control was set) left the run
 * waiting for a person; the task is final, so no person has anything to do.
 */
async function endRunsOfCancelledTasks(
  ctx: TickContext,
  runs: NonNullable<TickContext["runLookup"]>,
  tasks: readonly StoredObject[],
  repository: string,
): Promise<void> {
  if (ctx.runs === undefined) return;
  const cancelled = new Set(
    tasksOf(tasks, repository)
      .filter((object) => taskData(object.data).phase === "cancelled")
      .map((object) => `task:${object.id}`),
  );
  if (cancelled.size === 0) return;
  for (const run of await runs.active()) {
    if (!cancelled.has(run.object)) continue;
    await ctx.runs.cancel(run.runId);
    writeSchedulerLine(`${run.object.slice(5)} cancelled: ended its run ${run.runId}`);
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
  flows: RepositoryFlows,
): Promise<boolean> {
  const runs = ctx.runLookup;
  if (runs === undefined) return false;
  let changed = false;
  for (const object of tasksOf(tasks, repository)) {
    const task = taskData(object.data);
    if (task.phase !== "waiting" && task.phase !== "running" && task.phase !== "review") {
      continue;
    }
    const active = await runs.active(`task:${object.id}`);
    const run = active[0];
    if (run !== undefined) {
      // A run paused for a person is the truth: the task is waiting.
      const state = await runs.state(run.runId);
      if (state?.status === "waiting_person" && task.phase !== "waiting") {
        const moved = await moveTaskPhase(ctx.store, object.id, task.phase, "waiting", {
          run: run.runId,
        });
        if (moved === undefined) continue;
        changed = true;
        writeSchedulerLine(`${bareId(object.id)} ${task.phase} -> waiting`);
      }
      continue;
    }
    // A running task with no run id is a start that never landed; the claim
    // release below gives it back to ready.
    if ((task.phase === "running" || task.phase === "review") && task.run === null) continue;
    // A recovered run starts the dev flow again; without the plugins it
    // runs through, the task waits where it is.
    if (!canStartWork) continue;
    const step = task.run === null ? null : await runs.lastStep(task.run);
    const plan = await ctx.store.get("plan", storeKey(task.repository, task.plan));
    const requested = task.flow ?? (plan === undefined ? undefined : planData(plan.data).flow);
    const selected =
      task.flowName !== undefined &&
      (task.flowGraph === undefined || declareStoredFlow(ctx, object))
        ? { name: task.flowName, graph: task.flowGraph }
        : flowFor(flows, requested);
    if (selected === undefined) {
      const reason =
        flows.refused.get(requested ?? "default") ??
        `no flow "${requested ?? "default"}" in dev.json`;
      reportFlowProblem(object.id, requested, flows.refused.get(requested ?? "default"));
      // There is no graph to resume. End the task's wait for its run and leave
      // it for a person; a flow defined again resumes it on a later tick.
      if (task.phase !== "waiting" || task.run !== null) {
        const moved = await moveTaskPhase(ctx.store, object.id, task.phase, "waiting", {
          run: null,
        });
        if (moved !== undefined) {
          changed = true;
          writeSchedulerLine(`${bareId(object.id)} ${task.phase} -> waiting (${reason})`);
        }
      }
      continue;
    }
    if ((await reopenTask(ctx.store, object.id)) === undefined) continue;
    changed = true;
    try {
      if (await startOne(ctx, object, { runStoppedAt: step ?? "the run" }, false, selected)) {
        writeSchedulerLine(
          `${bareId(object.id)} ${task.phase} -> waiting (run stopped during ${step ?? "the run"})`,
        );
      }
    } catch (error) {
      if (!(error instanceof ActiveRunError)) throw error;
    }
  }
  return changed;
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

/** What the scheduler last said about each repository's check host. */
const reportedCheckHosts = new Map<string, string>();

/**
 * Says once per change that a repository's check commands use
 * `remote-check.sh` while no check host is set. The commands run here,
 * so a person must know before the checks do; a host that is set later clears
 * the line, and losing it again says it once more.
 */
function reportCheckHostProblem(
  ctx: TickContext,
  repository: RepositoryData,
  settings: DevSettings,
): void {
  const warning = checkHostWarning(repository.name, settings, ctx.settings);
  if (warning === undefined) {
    reportedCheckHosts.delete(repository.path);
    return;
  }
  if (reportedCheckHosts.get(repository.path) === warning) return;
  reportedCheckHosts.set(repository.path, warning);
  console.error(`dev: ${warning}`);
}

/** The tasks and plans one pass reads, and the tasks it refreshes after a write. */
interface PassSnapshot {
  readonly store: ObjectStore;
  tasks: StoredObject[];
  readonly plans: readonly StoredObject[];
}

/** Replaces one repository's tasks in the pass snapshot; other repositories stay as read. */
async function refreshRepositoryTasks(
  snapshot: PassSnapshot,
  repository: string,
): Promise<void> {
  const fresh = await listAll(snapshot.store, "task", { repository });
  snapshot.tasks = [
    ...snapshot.tasks.filter(
      (object) => taskData(object.data).repository !== repository,
    ),
    ...fresh,
  ];
}

/** The versions of a plan's tasks, so an unchanged finished plan is left alone. */
const planTaskSignatures = new WeakMap<ObjectStore, Map<string, string>>();

function taskSignature(tasks: readonly StoredObject[]): string {
  return tasks
    .map((object) => `${object.id}:${object.version}`)
    .sort()
    .join("\n");
}

async function scheduleRepository(
  ctx: TickContext,
  repository: RepositoryData,
  snapshot: PassSnapshot,
): Promise<void> {
  let dirty = false;
  const initialTasks = tasksOf(snapshot.tasks, repository.name);
  reportSettingsProblem(repository);
  // A cancelled task's run ends whether or not the settings can be read.
  if (ctx.runLookup !== undefined) {
    await endRunsOfCancelledTasks(ctx, ctx.runLookup, initialTasks, repository.name);
  }
  let settings: DevSettings;
  try {
    settings = await readDevSettings(repository.path);
  } catch {
    // Never valid: the problem is reported and shown as pending. Nothing
    // here may touch the repository's running steps.
    return;
  }
  reportCheckHostProblem(ctx, repository, settings);
  // Work needs the plugins dev runs its steps through; without them a task
  // stays ready instead of failing.
  const canStartWork = missingPlugins(ctx.loaded).length === 0;

  // Compile every repository flow once; a start records its graph on the task,
  // and a graph recorded there is declared again below so a fresh process
  // resumes a running attempt on the graph it started with.
  const flows = await declareRepositoryFlows(ctx, repository, settings);
  declareStoredFlows(ctx, tasksOf(snapshot.tasks, repository.name));

  // Repair a run that ended without an edge, or one whose phase was left
  // behind, before the scheduler reads phases and starts anything else.
  dirty =
    (await reconcileTaskRuns(
      ctx,
      repository.name,
      tasksOf(snapshot.tasks, repository.name),
      canStartWork,
      flows,
    )) || dirty;

  // A claim is not durable until the kernel records the run. A task left
  // running with no run is a start that never landed (a crash or a kernel
  // failure between the two writes): give it back to ready, and this tick
  // starts it again. A run that already exists is never duplicated, because
  // the kernel refuses a second run for an object.
  // A claim whose run the kernel already holds is a start still landing: the
  // run's first step records its id moments later. Releasing it would cancel
  // that run and start another one on the next tick, forever.
  for (const object of tasksOf(snapshot.tasks, repository.name)) {
    const task = taskData(object.data);
    if ((task.phase !== "running" && task.phase !== "review") || task.run !== null) continue;
    if (
      ctx.runLookup !== undefined &&
      (await ctx.runLookup.active(`task:${object.id}`)).length > 0
    ) {
      continue;
    }
    if ((await releaseTaskClaim(ctx.store, object.id)) === undefined) continue;
    dirty = true;
    writeSchedulerLine(`${bareId(object.id)} running -> ready`);
  }

  // Findings that did not fail a review become one follow-up task once the
  // plan has no open task; this runs before a plan can be reported finished.
  const followupsPending = snapshot.tasks.some((object) => {
    const task = taskData(object.data);
    return task.repository === repository.name && task.followups?.state === "collect";
  });
  await collectFollowups(ctx.store, repository.name, settings, snapshot.tasks);
  if (followupsPending) dirty = true;

  // A recovered claim changes the store; read the phases again before counting.
  if (dirty) {
    await refreshRepositoryTasks(snapshot, repository.name);
    dirty = false;
  }
  const current = tasksOf(snapshot.tasks, repository.name);
  const plans = orderPlans(plansOf(snapshot.plans, repository.name));
  const tasksById = new Map(
    snapshot.tasks.map((object) => [object.id, taskData(object.data)]),
  );
  declareStoredFlows(ctx, current);

  dirty = (await reportIntegrationResults(ctx.store, current)) || dirty;
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
  // A task counts against the pool of the flow it runs.
  const plansByName = new Map(plans.map((object) => [bareId(object.id), planData(object.data)]));
  // A task that has started runs the graph it started with, so its pool is
  // that graph's; dev.json changing meanwhile does not move it.
  const poolOf = (task: TaskData): string =>
    storedGraphPool(task.flowGraph) ??
    flowPool(settings, task.flow ?? plansByName.get(task.plan)?.flow);
  const poolActive = new Map<string, number>();
  for (const object of current) {
    const task = taskData(object.data);
    if (!isActive(task)) continue;
    const pool = poolOf(task);
    poolActive.set(pool, (poolActive.get(pool) ?? 0) + 1);
  }
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
    if (repositoryActive >= repositoryConcurrency(settings)) return false;
    const pool = poolOf(task);
    return (poolActive.get(pool) ?? 0) < repositoryConcurrency(settings, pool);
  };

  /**
   * Starts ready tasks one at a time. Each start changes whose turn it is, so
   * plans of one priority alternate; while the repository has more than one
   * slot, the last free slot goes by turn alone, whatever the priority.
   */
  const startReady = async (
    inScope: (task: TaskData, plan: PlanData) => boolean,
    flows: RepositoryFlows,
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
      const plan = planData(planObject.data);
      for (const object of scoped(planObject)) {
        const task = taskData(object.data);
        const dependencies = dependencyState(task, tasksById);
        if (dependencies.cancelled === undefined || started.has(object.id)) {
          continue;
        }
        const requested = task.flow ?? plan.flow;
        const selected = flowFor(flows, requested);
        if (selected === undefined) {
          reportFlowProblem(object.id, requested, flows.refused.get(requested ?? "default"));
          continue;
        }
        if (
          await startOne(ctx, object, { blockedBy: dependencies.cancelled }, false, selected)
        ) {
          dirty = true;
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
        const requested = taskData(pick.data).flow ?? plan.flow;
        const selected = flowFor(flows, requested);
        if (selected === undefined) {
          reportFlowProblem(pick.id, requested, flows.refused.get(requested ?? "default"));
          failed.add(pick.id);
          continue;
        }
        if (!(await startOne(ctx, pick, undefined, useOldestPlan, selected))) {
          failed.add(pick.id);
          break;
        }
        dirty = true;
        const task = taskData(pick.data);
        writeSchedulerLine(`${bareId(pick.id)} ready -> running`);
        planActive.set(planId, (planActive.get(planId) ?? 0) + 1);
        repositoryActive += 1;
        const startedPool = poolOf(task);
        poolActive.set(startedPool, (poolActive.get(startedPool) ?? 0) + 1);
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
      dirty = true;
      writeSchedulerLine(`${bareId(object.id)} waiting -> integrating`);
    }
  }

  // A task that left running while it held the kept slot no longer holds it.
  for (const object of current) {
    const task = taskData(object.data);
    if (task.oldestPlanSlot === true && !isActive(task)) {
      dirty = (await clearOldestPlanSlot(ctx.store, object.id)) || dirty;
    }
  }

  // The owner's manual start is exempt from the auto level, not from the
  // dependencies or the limits that keep two runs off one repository.
  await startReady((task) => task.startRequested === true, flows);
  await startReady(
    (task, plan) => plan.auto !== "off" && task.startRequested !== true,
    flows,
  );

  // Starts and repairs changed the tasks; read them once before the notes and
  // counts below. A pass that changed nothing keeps the snapshot it read.
  if (dirty) {
    await refreshRepositoryTasks(snapshot, repository.name);
    dirty = false;
  }
  const latest = tasksOf(snapshot.tasks, repository.name);

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
  for (const object of latest) {
    const task = taskData(object.data);
    if (task.phase !== "ready" || started.has(object.id)) continue;
    const holder =
      task.area !== undefined && dependencyState(task, tasksById).ready
        ? areaActive.get(task.area)
        : undefined;
    dirty =
      (await setAreaHold(ctx.store, object.id, holder, aheadOf(object), task)) || dirty;
    const dependencies = dependencyState(task, tasksById);
    dirty =
      (await setDependencyHold(
        ctx.store,
        object.id,
        !dependencies.ready && dependencies.cancelled === undefined,
        dependencies.waitingFor,
        task,
      )) || dirty;
  }

  const plansById = new Map(plans.map((object) => [bareId(object.id), planData(object.data)]));

  // Say why a ready task that could otherwise start does not: the plan's or
  // the repository's slots are full, or a plugin dev needs is not loaded.
  const heldBy = (holders: readonly string[]): string => {
    const [first = "", ...more] = holders;
    return more.length === 0 ? first : `${first} and ${more.length} more`;
  };
  const activeIds = (inPlan: string | undefined): readonly string[] =>
    latest
      .filter((object) => {
        const task = taskData(object.data);
        return (isActive(task) || started.has(object.id)) && (inPlan === undefined || task.plan === inPlan);
      })
      .map((object) => bareId(object.id))
      .sort();
  const missing = missingPlugins(ctx.loaded).map((plugin) => plugin.name);
  for (const object of latest) {
    const task = taskData(object.data);
    if (task.phase !== "ready" || started.has(object.id)) continue;
    let note: string | undefined;
    if (plansById.get(task.plan)?.status === "paused") {
      note = "waiting for the plan to resume";
    } else if (queuedIds.has(object.id)) {
      const plan = plansById.get(task.plan);
      const holders = activeIds(task.plan);
      const all = activeIds(undefined);
      if (missing.length > 0) {
        note = `waiting for plugin ${missing.join(", ")}`;
      } else if (task.area !== undefined && areaActive.has(task.area)) {
        note = undefined;
      } else if (plan !== undefined && holders.length >= planConcurrency(plan)) {
        note = `waiting for the plan's slot (${heldBy(holders)})`;
      } else {
        const pool = poolOf(task);
        const inPool = latest
          .filter((other) => {
            const otherTask = taskData(other.data);
            return (isActive(otherTask) || started.has(other.id)) && poolOf(otherTask) === pool;
          })
          .map((other) => bareId(other.id))
          .sort();
        if (
          Object.keys(settings.workers.pools).length > 1 &&
          inPool.length >= repositoryConcurrency(settings, pool)
        ) {
          // Which pool is full: a full code pool is not a full image pool.
          note = `waiting for the ${pool} pool's slot (${heldBy(inPool)})`;
        } else if (all.length >= repositoryConcurrency(settings)) {
          note = `waiting for the repository's slot (${heldBy(all)})`;
        }
      }
    }
    dirty = (await setSlotHold(ctx.store, object.id, note, task)) || dirty;
  }

  // Name each open task's flow when the repository defines more than one, and
  // say why a ready task whose flow is not defined does not start.
  for (const object of latest) {
    const task = taskData(object.data);
    const requested = task.flow ?? plansById.get(task.plan)?.flow ?? "default";
    const missing =
      (task.phase === "ready" ||
        (task.phase === "waiting" && task.run === null)) &&
      task.flowName === undefined &&
      flowFor(flows, requested) === undefined;
    dirty =
      (await setFlowNote(
        ctx.store,
        object.id,
        {
          shown: flows.named.size > 1 ? requested : undefined,
          held: missing
            ? (flows.refused.get(requested) ?? `flow ${requested} is not defined in .operad/dev.json`)
            : undefined,
        },
        task,
      )) || dirty;
  }

  if (dirty) {
    await refreshRepositoryTasks(snapshot, repository.name);
    dirty = false;
  }
  const final = tasksOf(snapshot.tasks, repository.name);
  const tasksByPlan = new Map<string, StoredObject[]>();
  for (const object of final) {
    const plan = taskData(object.data).plan;
    const mine = tasksByPlan.get(plan);
    if (mine === undefined) tasksByPlan.set(plan, [object]);
    else mine.push(object);
  }
  let signatures = planTaskSignatures.get(ctx.store);
  if (signatures === undefined) {
    signatures = new Map();
    planTaskSignatures.set(ctx.store, signatures);
  }

  // Keep each plan's cached counts, and with them its row's mark, current.
  for (const planObject of plans) {
    const id = bareId(planObject.id);
    const mine = tasksByPlan.get(id) ?? [];
    const signature = taskSignature(mine);
    const changed = signatures.get(planObject.id) !== signature;
    if (planData(planObject.data).finishedReported === true && !changed) continue;
    await refreshPlanCounts(ctx.store, await getPlan(ctx.store, planObject.id), mine);
    signatures.set(planObject.id, signature);
  }
}

/** The pass running for a store and whether another was asked for meanwhile. */
interface PassState {
  running: Promise<void> | undefined;
  /** The pass that runs once after the running one, shared by every asker. */
  next: Promise<void> | undefined;
}

const passes = new WeakMap<object, PassState>();

/**
 * One scheduler tick. Passes never overlap: a pass asked for while one runs
 * runs once after it, and every asker in between shares that one pass.
 */
export function runScheduler(ctx: TickContext): Promise<void> {
  let state = passes.get(ctx.store);
  if (state === undefined) {
    state = { running: undefined, next: undefined };
    passes.set(ctx.store, state);
  }
  const current = state;
  const start = (): Promise<void> => {
    const pass = runPass(ctx).finally(() => {
      current.running = undefined;
    });
    current.running = pass;
    return pass;
  };
  if (current.running === undefined) return start();
  if (current.next === undefined) {
    const after = (): Promise<void> => {
      current.next = undefined;
      return start();
    };
    // The running pass failing must not stop the pass that follows it.
    current.next = current.running.then(after, after);
  }
  return current.next;
}

/**
 * One pass. Each registered repository is scheduled on its own, so a slow or
 * broken repository cannot stop another one.
 */
async function runPass(ctx: TickContext): Promise<void> {
  const repositories = await listRepositories(ctx.store);
  if (repositories.length === 0) return;
  const snapshot: PassSnapshot = {
    store: ctx.store,
    tasks: await listAll(ctx.store, "task"),
    plans: await listAll(ctx.store, "plan"),
  };
  for (const repository of repositories) {
    try {
      await scheduleRepository(ctx, repository, snapshot);
    } catch (error) {
      const message = messageOf(error);
      console.error(`dev: repository "${repository.name}": ${message}`);
    }
  }
}
