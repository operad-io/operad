/** The work the dev plugin does: repositories, plans and tasks. */

import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { ViewError } from "@operad-io/engine";
import type { ObjectStore, StoredObject } from "@operad-io/engine";
import { withRepositoryLock } from "./lock.ts";
import {
  appendChange,
  appendRework,
  bareId,
  DevError,
  editBrief,
  isOpenTask,
  keyRepository,
  listAll,
  lowerPriority,
  nextId,
  parseId,
  planData,
  planState,
  PLAN_FINAL_STATES,
  TASK_FINAL_STATES,
  PRIORITIES,
  priorityIndex,
  repositoryData,
  storeKey,
  taskData,
  validateRepositoryName,
  validateSlug,
  validateArea,
  validateTitle,
  type AutoMode,
  type PlanData,
  type Priority,
  type RepositoryData,
  type TaskData,
  type TaskPhase,
} from "./model.ts";
import { DEFAULT_DEV_SETTINGS, DEV_SETTINGS_SCHEMA } from "./settings.ts";

/** An optional way for the dev plugin to ask the kernel to cancel a run. */
export interface DevRunControl {
  cancel(runId: string): Promise<void> | void;
}

export interface ResolveRepositoryOptions {
  readonly name?: string | undefined;
  readonly cwd?: string | undefined;
}

export interface AddRepositoryOptions {
  readonly path: string;
  readonly name?: string | undefined;
  readonly cwd?: string | undefined;
}

const REPOSITORY_TYPE = "repo";
/** The type name stored repositories had before dev declared `repo`. */
const LEGACY_REPOSITORY_TYPE = "repository";
const PLAN_TYPE = "plan";
const TASK_TYPE = "task";

const EXCLUDES = [".operad-worktrees/", ".radian-sandbox/"] as const;

/**
 * Test-only hook, set by a test to pause between a command's first read and
 * its lock. Production code never sets it; the checks inside the lock must hold
 * without it.
 */
export const devTestHooks: {
  beforeLock?: ((operation: string) => Promise<void> | void) | undefined;
} = {};

interface GitResult {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function git(cwd: string, args: readonly string[]): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

/**
 * The one way a command changes a repository: refuse a removed repository,
 * take its lock, then read it and the objects again before `work` decides.
 */
export async function withRepoLock<T>(
  store: ObjectStore,
  repository: string,
  work: (fresh: RepositoryData) => Promise<T> | T,
): Promise<T> {
  const initial = await repositoryOf(store, repository);
  return withRepositoryLock(initial.path, async () => {
    const fresh = await repositoryOf(store, repository);
    return work(fresh);
  });
}

/* ---------------------------------------------------------------------------
 * Repositories
 * ------------------------------------------------------------------------- */

/** Open plans and open tasks of one repository, as its row shows them. */
async function openCounts(
  store: ObjectStore,
  name: string,
): Promise<{ readonly openPlans: number; readonly openTasks: number }> {
  const plans = (await listAll(store, PLAN_TYPE)).filter(
    (object) => planData(object.data).repository === name,
  );
  const tasks = (await listAll(store, TASK_TYPE)).filter(
    (object) => taskData(object.data).repository === name,
  );
  return {
    openPlans: plans.filter(
      (object) => !PLAN_FINAL_STATES.includes(planState(planData(object.data))),
    ).length,
    openTasks: tasks.filter(
      (object) => !TASK_FINAL_STATES.includes(taskData(object.data).phase),
    ).length,
  };
}

/**
 * Keeps the open counts a repository's row reads, writing the repository only
 * on a change. The row is pure, so the counts live in the stored object.
 */
export async function refreshRepositoryCounts(
  store: ObjectStore,
  name: string,
): Promise<void> {
  const found = await store.get(REPOSITORY_TYPE, name);
  if (found === undefined) return;
  const data = repositoryData(found.data);
  const counts = await openCounts(store, name);
  if (data.openPlans === counts.openPlans && data.openTasks === counts.openTasks) {
    return;
  }
  await store.put(
    REPOSITORY_TYPE,
    name,
    { ...data, ...counts },
    "dev:refresh-repo",
  );
}

const migrated = new WeakSet<ObjectStore>();

/** Copies repositories stored under the old type name to `repo`, once per store. */
export async function migrateLegacyRepositories(store: ObjectStore): Promise<void> {
  if (migrated.has(store)) return;
  migrated.add(store);
  for (const old of await listAll(store, LEGACY_REPOSITORY_TYPE)) {
    if ((await store.get(REPOSITORY_TYPE, old.id)) !== undefined) continue;
    await store.put(
      REPOSITORY_TYPE,
      old.id,
      { ...old.data, ...(await openCounts(store, old.id)) },
      "dev:repo-migrate",
    );
  }
}

async function repositories(store: ObjectStore): Promise<readonly StoredObject[]> {
  await migrateLegacyRepositories(store);
  return listAll(store, REPOSITORY_TYPE);
}

export async function findRepository(
  store: ObjectStore,
  name: string,
  options: { readonly includeRemoved?: boolean | undefined } = {},
): Promise<StoredObject | undefined> {
  await migrateLegacyRepositories(store);
  const object = await store.get(REPOSITORY_TYPE, name);
  if (object === undefined) return undefined;
  if (options.includeRemoved !== true && repositoryData(object.data).removed) {
    return undefined;
  }
  return object;
}

export async function listRepositories(
  store: ObjectStore,
): Promise<readonly RepositoryData[]> {
  const objects = await repositories(store);
  return objects
    .map((object) => repositoryData(object.data))
    .filter((repository) => !repository.removed)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function inside(path: string, cwd: string): boolean {
  const rel = relative(path, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shortPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function registeredLines(registered: readonly RepositoryData[]): string[] {
  return registered.map(
    (repository) =>
      `  ${repository.name}  ${shortPath(repository.path)}${
        existsSync(repository.path) ? "" : "  (missing)"
      }`,
  );
}

function noRepositoryHere(
  registered: readonly RepositoryData[],
  cwd: string,
): DevError {
  if (registered.length === 0) {
    return new DevError(
      "repo",
      `no registered repository contains ${cwd}, and none is registered; register one with \`operad repo add <path>\``,
    );
  }
  return new DevError(
    "repo",
    [
      `no registered repository contains ${cwd}; run the command inside one of these, or pass --repo <name>:`,
      ...registeredLines(registered),
    ].join("\n"),
  );
}

function unknownRepository(
  registered: readonly RepositoryData[],
  name: string,
): DevError {
  if (registered.length === 0) {
    return new DevError(
      "repo",
      `no registered repository "${name}", and none is registered; register one with \`operad repo add <path>\``,
    );
  }
  return new DevError(
    "repo",
    [`no registered repository "${name}"; registered:`, ...registeredLines(registered)].join(
      "\n",
    ),
  );
}

function repositoryAt(
  registered: readonly RepositoryData[],
  cwd: string,
): RepositoryData | undefined {
  const matches = registered.filter((repository) =>
    inside(resolve(repository.path), cwd),
  );
  matches.sort((left, right) => right.path.length - left.path.length);
  return matches[0];
}

/** The repository the current directory belongs to, or the named one. */
export async function resolveRepository(
  store: ObjectStore,
  options: ResolveRepositoryOptions = {},
): Promise<RepositoryData> {
  if (options.name !== undefined) {
    const found = await findRepository(store, options.name);
    if (found === undefined) {
      throw unknownRepository(await listRepositories(store), options.name);
    }
    return repositoryData(found.data);
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const registered = await listRepositories(store);
  const found = repositoryAt(registered, cwd);
  if (found === undefined) throw noRepositoryHere(registered, cwd);
  return found;
}

/**
 * The repository a plan or task id belongs to, and the id without its
 * repository. A qualified id (`<repo>/<id>`) names its repository; a bare id
 * means the repository of the current directory, or, outside every
 * repository, the one repository that has an object with that id.
 */
export async function resolveObjectRepository(
  store: ObjectStore,
  kind: "plan" | "task",
  id: string,
  options: ResolveRepositoryOptions = {},
): Promise<{ readonly repository: RepositoryData; readonly id: string }> {
  const slash = id.indexOf("/");
  if (slash >= 0) {
    const named = id.slice(0, slash);
    if (options.name !== undefined && options.name !== named) {
      throw new DevError(
        "repo",
        `"${id}" is in repository "${named}", but --repo names "${options.name}"`,
      );
    }
    return {
      repository: await resolveRepository(store, { name: named }),
      id: id.slice(slash + 1),
    };
  }
  if (options.name !== undefined) {
    return { repository: await resolveRepository(store, options), id };
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const registered = await listRepositories(store);
  const here = repositoryAt(registered, cwd);
  if (here !== undefined) return { repository: here, id };
  const having: RepositoryData[] = [];
  for (const repository of registered) {
    const object = await store.get(kind, storeKey(repository.name, id));
    if (object !== undefined) having.push(repository);
  }
  const only = having[0];
  if (only === undefined) throw noRepositoryHere(registered, cwd);
  if (having.length > 1) {
    throw new DevError(
      "id",
      `"${id}" is ambiguous, in more than one repository: use ${having
        .map((repository) => storeKey(repository.name, id))
        .join(", ")}`,
    );
  }
  return { repository: only, id };
}

/**
 * Resolves a bare plan or task id in the repository the current directory
 * belongs to. The kernel calls this for `show` and `dev:<action>`; without a
 * repository the id falls back to the kernel's suffix lookup, which reports an
 * ambiguity when more than one repository has it.
 *
 * A known repository returns the key even when no object is stored there: the
 * lookup stays inside that repository instead of reaching into another one.
 */
export async function resolveDevKey(
  store: ObjectStore,
  type: string,
  id: string,
  cwd: string,
  scope?: string,
): Promise<string | undefined> {
  const kind =
    type === PLAN_TYPE ? "plan" : type === TASK_TYPE ? "task" : undefined;
  if (kind === undefined) return undefined;
  const slash = id.indexOf("/");
  if (parseId(slash >= 0 ? id.slice(slash + 1) : id, kind) === undefined) {
    return undefined;
  }
  try {
    if (slash >= 0) {
      // The kernel already looked the qualified key up; only an unknown
      // repository is worth reporting here.
      await resolveRepository(store, { name: id.slice(0, slash) });
      return undefined;
    }
    const { repository } = await resolveObjectRepository(
      store,
      kind,
      id,
      scope === undefined ? { cwd } : { name: scope },
    );
    return storeKey(repository.name, id);
  } catch (error) {
    if (error instanceof DevError) {
      throw new ViewError(
        error.field === "id" ? "ambiguous" : "not-found",
        error.message,
      );
    }
    throw error;
  }
}

function ensureExcludes(repositoryPath: string): void {
  const path = git(repositoryPath, ["rev-parse", "--git-path", "info/exclude"]);
  if (!path.ok) {
    throw new DevError("path", `is not a git work tree: ${path.err}`);
  }
  const excludePath = resolve(repositoryPath, path.out);
  mkdirSync(resolve(excludePath, ".."), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const lines = current.length === 0 ? [] : current.replace(/\r\n/g, "\n").split("\n");
  const present = new Set(lines.map((line) => line.trim()));
  const missing = EXCLUDES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  // operad repo add owns this file: the "never write under .git" rule is for
  // our own work as a worker in a repository, not for this command.
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  appendFileSync(excludePath, `${prefix}${missing.join("\n")}\n`, "utf8");
}

function writeSettings(repositoryPath: string, name: string): void {
  const directory = join(repositoryPath, ".operad");
  mkdirSync(directory, { recursive: true });
  const settings = join(directory, "dev.json");
  if (existsSync(settings)) return;
  writeFileSync(
    settings,
    `${JSON.stringify(
      {
        $schema: DEV_SETTINGS_SCHEMA,
        name,
        remote: DEFAULT_DEV_SETTINGS.remote,
        mainBranch: DEFAULT_DEV_SETTINGS.mainBranch,
        worktreeRoot: DEFAULT_DEV_SETTINGS.worktreeRoot,
        concurrency: DEFAULT_DEV_SETTINGS.concurrency,
        worker: DEFAULT_DEV_SETTINGS.worker,
        workerBrief: DEFAULT_DEV_SETTINGS.workerBrief,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
}

/** Registers a git work tree that has a remote. */
export async function addRepository(
  store: ObjectStore,
  options: AddRepositoryOptions,
): Promise<RepositoryData> {
  const from = resolve(options.cwd ?? process.cwd(), options.path);
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    throw new DevError("path", `no directory "${from}"`);
  }
  const top = git(from, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || top.out.length === 0) {
    throw new DevError("path", `"${from}" is not a git work tree`);
  }
  const path = realpathSync(top.out);
  if (path !== realpathSync(from)) {
    throw new DevError(
      "path",
      `"${from}" is not the root of a git work tree`,
    );
  }
  const bare = git(path, ["rev-parse", "--is-bare-repository"]);
  if (bare.ok && bare.out === "true") {
    throw new DevError("path", `"${path}" is a bare repository`);
  }
  const remotes = git(path, ["remote"]);
  if (!remotes.ok || remotes.out.length === 0) {
    throw new DevError("path", `"${path}" has no remote`);
  }

  const name = validateRepositoryName(options.name ?? basename(path));
  const existing = await findRepository(store, name);
  if (existing !== undefined) {
    throw new DevError(
      "name",
      `repository "${name}" is already registered at "${repositoryData(existing.data).path}"`,
    );
  }
  const samePath = (await listRepositories(store)).find(
    (repository) => resolve(repository.path) === path,
  );
  if (samePath !== undefined) {
    throw new DevError(
      "path",
      `"${path}" is already registered as "${samePath.name}"`,
    );
  }

  const data: RepositoryData = {
    name,
    path,
    removed: false,
    openPlans: 0,
    openTasks: 0,
  };
  await store.put(REPOSITORY_TYPE, name, data, "dev:repo-add");
  writeSettings(path, name);
  ensureExcludes(path);
  return data;
}

/** Refuses to remove a repository that still has open tasks. */
export async function removeRepository(
  store: ObjectStore,
  name: string,
): Promise<RepositoryData> {
  const initial = await repositoryOf(store, name);
  await assertNoOpenTasks(store, initial.name);
  await devTestHooks.beforeLock?.("repo-remove");
  return withRepoLock(store, name, async (repository) => {
    await assertNoOpenTasks(store, repository.name);
    const data: RepositoryData = { ...repository, removed: true };
    await store.put(REPOSITORY_TYPE, name, data, "dev:repo-remove");
    return data;
  });
}

/** The check that decides whether a repository may be removed. */
async function assertNoOpenTasks(
  store: ObjectStore,
  name: string,
): Promise<void> {
  const open = (await listAll(store, TASK_TYPE)).filter((object) => {
    const task = taskData(object.data);
    return task.repository === name && isOpenTask(task);
  });
  if (open.length > 0) {
    throw new DevError(
      "repo",
      `repository "${name}" has ${open.length} open task(s)`,
    );
  }
}

function repositoryByName(
  objects: readonly StoredObject[],
  name: string,
): RepositoryData | undefined {
  const found = objects.find((object) => object.id === name);
  return found === undefined ? undefined : repositoryData(found.data);
}

async function repositoryOf(
  store: ObjectStore,
  name: string,
): Promise<RepositoryData> {
  const found = repositoryByName(await repositories(store), name);
  if (found === undefined) {
    throw new DevError("repository", `no repository "${name}"`);
  }
  if (found.removed) {
    throw new DevError("repository", `repository "${name}" was removed`);
  }
  return found;
}

/* ---------------------------------------------------------------------------
 * Plans and tasks
 * ------------------------------------------------------------------------- */

async function allTasks(store: ObjectStore): Promise<readonly StoredObject[]> {
  return listAll(store, TASK_TYPE);
}

async function tasksOfPlan(
  store: ObjectStore,
  planKey: string,
): Promise<readonly StoredObject[]> {
  const repository = keyRepository(planKey);
  const plan = bareId(planKey);
  return (await allTasks(store)).filter((object) => {
    const task = taskData(object.data);
    return task.repository === repository && task.plan === plan;
  });
}

export async function getPlan(
  store: ObjectStore,
  key: string,
): Promise<StoredObject> {
  const object = await store.get(PLAN_TYPE, key);
  if (object === undefined) {
    throw new DevError("plan", `no plan "${bareId(key)}"`);
  }
  return object;
}

export async function getTask(
  store: ObjectStore,
  key: string,
): Promise<StoredObject> {
  const object = await store.get(TASK_TYPE, key);
  if (object === undefined) {
    throw new DevError("task", `no task "${bareId(key)}"`);
  }
  return object;
}

async function writePlan(
  store: ObjectStore,
  id: string,
  data: PlanData,
  cause: string,
): Promise<StoredObject> {
  const written = await store.put(PLAN_TYPE, id, data, cause);
  await refreshRepositoryCounts(store, data.repository);
  return written;
}

async function writeTask(
  store: ObjectStore,
  id: string,
  data: TaskData,
  cause: string,
): Promise<StoredObject> {
  return store.put(TASK_TYPE, id, data, cause);
}

/** Recomputes the counts a plan row reads, writing the plan only on a change. */
export async function refreshPlanCounts(
  store: ObjectStore,
  plan: StoredObject,
): Promise<StoredObject> {
  const data = planData(plan.data);
  const tasks = await tasksOfPlan(store, plan.id);
  const taskCount = tasks.length;
  const mergedCount = tasks.filter(
    (object) => taskData(object.data).phase === "merged",
  ).length;
  const cancelledCount = tasks.filter(
    (object) => taskData(object.data).phase === "cancelled",
  ).length;
  const activeCount = tasks.filter((object) => {
    const phase = taskData(object.data).phase;
    return phase === "running" || phase === "review";
  }).length;
  if (
    data.taskCount === taskCount &&
    data.mergedCount === mergedCount &&
    data.cancelledCount === cancelledCount &&
    (data.activeCount ?? 0) === activeCount
  ) {
    return plan;
  }
  const next: PlanData = {
    ...data,
    taskCount,
    mergedCount,
    cancelledCount,
    activeCount,
    // A new task reopens a plan the scheduler already called finished.
    ...(taskCount > 0 && mergedCount + cancelledCount === taskCount
      ? {}
      : { finishedReported: false }),
  };
  return writePlan(store, plan.id, next, "dev:refresh-plan");
}

export interface AddPlanOptions {
  readonly repository: RepositoryData;
  readonly slug: string;
  readonly title: string;
  readonly request?: string | undefined;
  readonly concurrency?: number | undefined;
}

/** The fixed range of a plan's concurrency. */
export const MIN_PLAN_CONCURRENCY = 1;
export const MAX_PLAN_CONCURRENCY = 16;

export function validatePlanConcurrency(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_PLAN_CONCURRENCY ||
    value > MAX_PLAN_CONCURRENCY
  ) {
    throw new DevError(
      "concurrency",
      `must be an integer from ${MIN_PLAN_CONCURRENCY} to ${MAX_PLAN_CONCURRENCY}`,
    );
  }
  return value;
}

export async function addPlan(
  store: ObjectStore,
  options: AddPlanOptions,
): Promise<StoredObject> {
  const slug = validateSlug(options.slug);
  const title = validateTitle(options.title);
  const concurrency =
    options.concurrency === undefined
      ? 1
      : validatePlanConcurrency(options.concurrency);
  return withRepoLock(store, options.repository.name, async (repository) => {
    const id = await nextId(store, "plan", repository.name, slug);
    const data: PlanData = {
      repository: repository.name,
      title,
      request: options.request ?? "",
      status: "draft",
      auto: "off",
      priority: "P3",
      concurrency,
      taskCount: 0,
      mergedCount: 0,
      cancelledCount: 0,
    };
    return writePlan(store, storeKey(repository.name, id), data, "dev:plan-add");
  });
}

function validateAfter(
  tasks: readonly StoredObject[],
  repository: string,
  planId: string,
  taskId: string,
  after: readonly string[],
): readonly string[] {
  const unique: string[] = [];
  for (const id of after) {
    if (!unique.includes(id)) unique.push(id);
  }
  const byId = new Map(
    tasks
      .filter((object) => taskData(object.data).repository === repository)
      .map((object) => [bareId(object.id), object]),
  );
  for (const id of unique) {
    if (id === taskId) throw new DevError("after", "a task cannot follow itself");
    const found = byId.get(id);
    if (found === undefined) {
      throw new DevError("after", `no task "${id}"`);
    }
    const data = taskData(found.data);
    if (data.repository !== repository) {
      throw new DevError("after", `task "${id}" belongs to another repository`);
    }
    if (data.plan !== planId && data.phase !== "merged") {
      throw new DevError(
        "after",
        `task "${id}" is in another plan and is not merged`,
      );
    }
  }

  const follows = new Map<string, readonly string[]>();
  for (const object of tasks) {
    const data = taskData(object.data);
    if (data.repository !== repository) continue;
    const id = bareId(object.id);
    follows.set(id, id === taskId ? unique : data.after);
  }
  follows.set(taskId, unique);

  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new DevError("after", `cycle through "${id}"`);
    }
    visiting.add(id);
    for (const next of follows.get(id) ?? []) visit(next);
    visiting.delete(id);
    done.add(id);
  };
  visit(taskId);
  return unique;
}

export interface AddTaskOptions {
  readonly plan: string;
  readonly slug: string;
  readonly title: string;
  readonly brief?: string | undefined;
  readonly after?: readonly string[] | undefined;
  readonly area?: string | undefined;
}

export async function addTask(
  store: ObjectStore,
  options: AddTaskOptions,
): Promise<StoredObject> {
  const slug = validateSlug(options.slug);
  const title = validateTitle(options.title);
  const plan = await getPlan(store, options.plan);
  const planObject = planData(plan.data);
  if (planObject.status === "cancelled") {
    throw new DevError("plan", `plan "${bareId(plan.id)}" is cancelled`);
  }
  await devTestHooks.beforeLock?.("task-add");
  return withRepoLock(store, planObject.repository, (repository) =>
    addTaskLocked(store, options, repository),
  );
}

/** Adds the task; the caller holds the repository's lock. */
export async function addTaskLocked(
  store: ObjectStore,
  options: AddTaskOptions,
  repository: RepositoryData,
): Promise<StoredObject> {
  const slug = validateSlug(options.slug);
  const title = validateTitle(options.title);
  const currentPlan = await getPlan(store, options.plan);
  const current = planData(currentPlan.data);
  if (current.status === "cancelled") {
    throw new DevError(
      "plan",
      `plan "${bareId(currentPlan.id)}" is cancelled`,
    );
  }
  if (current.repository !== repository.name) {
    throw new DevError(
      "plan",
      `plan "${bareId(currentPlan.id)}" is not in repository "${repository.name}"`,
    );
  }
  const id = await nextId(store, "task", repository.name, slug);
  const tasks = await allTasks(store);
  const after = validateAfter(
    tasks,
    repository.name,
    bareId(currentPlan.id),
    id,
    options.after ?? [],
  );
  const brief = appendChange(options.brief ?? "", "created");
  const area =
    options.area === undefined ? undefined : validateArea(options.area);
  const data: TaskData = {
    repository: repository.name,
    plan: bareId(currentPlan.id),
    title,
    brief,
    after,
    ...(area === undefined ? {} : { area }),
    phase: "proposed",
    attempts: 0,
    run: null,
  };
  const written = await writeTask(
    store,
    storeKey(repository.name, id),
    data,
    "dev:task-add",
  );
  await refreshPlanCounts(store, currentPlan);
  return written;
}

function requireEditable(task: TaskData): void {
  if (task.phase !== "proposed" && task.phase !== "ready") {
    throw new DevError(
      "phase",
      `task is ${task.phase}; only proposed or ready tasks can change`,
    );
  }
}

/** Replaces the brief body, keeping rework and the changes section. */
export async function editTaskBrief(
  store: ObjectStore,
  id: string,
  body: string,
): Promise<StoredObject> {
  const task = await getTask(store, id);
  const data = taskData(task.data);
  requireEditable(data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    requireEditable(latest);
    const next = editBrief(latest.brief, body);
    if (next === latest.brief) return current;
    return writeTask(
      store,
      id,
      { ...latest, brief: next },
      "dev:task-edit",
    );
  });
}

export interface UpdateTaskOptions {
  readonly title?: string | undefined;
  readonly after?: readonly string[] | undefined;
  /** A new area; the empty string clears it. */
  readonly area?: string | undefined;
}

export async function updateTask(
  store: ObjectStore,
  id: string,
  options: UpdateTaskOptions,
): Promise<StoredObject> {
  if (
    options.title === undefined &&
    options.after === undefined &&
    options.area === undefined
  ) {
    throw new DevError(
      "update",
      "nothing to change; pass --title, --after or --area",
    );
  }
  const title =
    options.title === undefined ? undefined : validateTitle(options.title);
  const area =
    options.area === undefined ? undefined : validateArea(options.area);
  const initial = await getTask(store, id);
  const initialData = taskData(initial.data);
  requireEditable(initialData);
  return withRepoLock(store, initialData.repository, async () => {
    const current = await getTask(store, id);
    const data = taskData(current.data);
    requireEditable(data);
    const tasks = await allTasks(store);
    const after =
      options.after === undefined
        ? data.after
        : validateAfter(
            tasks,
            data.repository,
            data.plan,
            bareId(id),
            options.after,
          );
    const lines: string[] = [];
    if (title !== undefined && title !== data.title) {
      lines.push(`title: ${title}`);
    }
    if (options.after !== undefined) {
      lines.push(
        after.length === 0 ? "after: none" : `after: ${after.join(", ")}`,
      );
    }
    const areaChanged = options.area !== undefined && area !== data.area;
    if (areaChanged) {
      lines.push(area === undefined ? "area: none" : `area: ${area}`);
    }
    let brief = data.brief;
    for (const line of lines) brief = appendChange(brief, line);
    // A new area drops the old hold; the next tick decides it again.
    const {
      area: _area,
      areaHeldBy: _held,
      dependencyHeld: _waits,
      ...kept
    } = data;
    const nextArea = options.area === undefined ? data.area : area;
    const nextHeld = areaChanged ? undefined : data.areaHeldBy;
    const next: TaskData = {
      ...kept,
      ...(title === undefined ? {} : { title }),
      after,
      brief,
      ...(nextArea === undefined ? {} : { area: nextArea }),
      ...(nextHeld === undefined ? {} : { areaHeldBy: nextHeld }),
    };
    return writeTask(store, id, next, "dev:task-update");
  });
}

/** The task after a run changed its phase. Used by later tasks and by tests. */
export async function setTaskPhase(
  store: ObjectStore,
  id: string,
  phase: TaskPhase,
  options: { readonly run?: string | null | undefined } = {},
): Promise<StoredObject> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    const run =
      options.run === undefined
        ? phase === "running" || phase === "review" || phase === "waiting"
          ? latest.run
          : null
        : options.run;
    const brief = appendChange(latest.brief, `phase: ${phase}`);
    const written = await writeTask(
      store,
      id,
      { ...latest, phase, run, brief },
      `dev:task-${phase}`,
    );
    const plan = await getPlan(
      store,
      storeKey(latest.repository, latest.plan),
    );
    await refreshPlanCounts(store, plan);
    return written;
  });
}

/**
 * Marks a ready task as running before the kernel starts its flow, so the next
 * tick does not start it a second time. The claim carries a token that the
 * flow's steps check before writing the task, and the worktree step records
 * the run id when the child process reaches it. A manual start request stays
 * on the task so a crash before the run records itself does not lose it.
 */
export async function claimTaskStart(
  store: ObjectStore,
  id: string,
  options: { readonly checkArea?: boolean | undefined } = {},
): Promise<TaskData | undefined> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    if (latest.phase !== "ready") return undefined;
    // The area check and the claim are one decision under the repository
    // lock: whoever holds it reads the stored tasks, so two schedulers (two
    // ticks, or two processes) can never both start a task of one area.
    if (options.checkArea !== false && latest.area !== undefined) {
      const holder = await areaHolder(store, latest.repository, latest.area, id);
      if (holder !== undefined) return undefined;
    }
    const { areaHeldBy: _held, dependencyHeld: _waits, ...rest } = latest;
    const next: TaskData = {
      ...rest,
      phase: "running",
      run: null,
      brief: appendChange(latest.brief, "running"),
      claim: { token: crypto.randomUUID(), phase: "running" },
    };
    await writeTask(store, id, next, "dev:task-start");
    return next;
  });
}

/** The id of a running or reviewing task that holds the area, if any. */
export async function areaHolder(
  store: ObjectStore,
  repository: string,
  area: string,
  except: string,
): Promise<string | undefined> {
  for (const object of await allTasks(store)) {
    if (object.id === except) continue;
    const task = taskData(object.data);
    if (task.repository !== repository || task.area !== area) continue;
    if (task.phase === "running" || task.phase === "review") {
      return bareId(object.id);
    }
  }
  return undefined;
}

/**
 * Records which task holds a ready task's area, or clears the record, so a
 * list can say why the task is waiting. Writes only on a change.
 */
export async function setAreaHold(
  store: ObjectStore,
  id: string,
  holder: string | undefined,
): Promise<void> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  if (data.areaHeldBy === holder) return;
  await withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    if (latest.phase !== "ready" || latest.areaHeldBy === holder) return;
    const { areaHeldBy: _held, ...rest } = latest;
    await writeTask(
      store,
      id,
      { ...rest, ...(holder === undefined ? {} : { areaHeldBy: holder }) },
      "dev:task-area-hold",
    );
  });
}

/**
 * Records that a ready task waits for a task it follows, or clears the record,
 * so a row can say the task is blocked. Writes only on a change.
 */
export async function setDependencyHold(
  store: ObjectStore,
  id: string,
  held: boolean,
): Promise<void> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  if ((data.dependencyHeld === true) === held) return;
  await withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    if (latest.phase !== "ready" || (latest.dependencyHeld === true) === held) return;
    const { dependencyHeld: _waits, ...rest } = latest;
    await writeTask(
      store,
      id,
      { ...rest, ...(held ? { dependencyHeld: true } : {}) },
      "dev:task-dependency-hold",
    );
  });
}

/** Clears a task's dead run so a repair run can start it again. */
export async function reopenTask(
  store: ObjectStore,
  id: string,
): Promise<TaskData | undefined> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    if (latest.phase !== "waiting" && latest.phase !== "running") {
      return undefined;
    }
    const next: TaskData = {
      ...latest,
      phase: "ready",
      run: null,
      claim: null,
      brief: appendChange(latest.brief, "ready"),
    };
    await writeTask(store, id, next, "dev:task-reopen");
    return next;
  });
}

/**
 * Gives back a claim whose start never became a run. A task that is `running`
 * with no run id has nothing to recover or cancel, so it returns to `ready`
 * with no claim and the next tick can start it again. A manual start request is
 * kept: the owner's start survives the crash that lost the run.
 */
export async function releaseTaskClaim(
  store: ObjectStore,
  id: string,
): Promise<TaskData | undefined> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    if (latest.phase !== "running" || latest.run !== null) return undefined;
    const next: TaskData = {
      ...latest,
      phase: "ready",
      claim: null,
      brief: appendChange(latest.brief, "ready"),
    };
    await writeTask(store, id, next, "dev:task-claim-released");
    return next;
  });
}

/** Records that the scheduler printed this attempt's integration result. */
export async function recordMergeReported(
  store: ObjectStore,
  id: string,
  attempt: number,
): Promise<StoredObject> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    return writeTask(
      store,
      id,
      { ...latest, mergeReportedAttempt: attempt },
      "dev:task-merge-reported",
    );
  });
}

/** Asks the scheduler to start this ready task on its next tick. */
export async function requestTaskStart(
  store: ObjectStore,
  id: string,
): Promise<StoredObject> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  const at = `task "${bareId(id)}"`;
  if (data.phase !== "ready") {
    throw new DevError(
      "phase",
      `${at} is ${data.phase}; only a ready task can be started`,
    );
  }
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    if (latest.phase !== "ready") {
      throw new DevError(
        "phase",
        `${at} is ${latest.phase}; only a ready task can be started`,
      );
    }
    if (latest.startRequested === true) return current;
    return writeTask(
      store,
      id,
      { ...latest, startRequested: true },
      "dev:task-start-request",
    );
  });
}

/** Records that the scheduler answered this attempt's review with `merge`. */
export async function recordAutoMerge(
  store: ObjectStore,
  id: string,
  attempt: number,
): Promise<StoredObject> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    return writeTask(
      store,
      id,
      { ...latest, autoMergeAttempt: attempt },
      "dev:task-auto-merge",
    );
  });
}

/**
 * Claims the next transition of a waiting task for one person action. The
 * action passes the version of the task it looked at; under the repository lock
 * the claim re-reads the task and writes `change` only when the task is still
 * waiting at that version. A concurrent merge, reject, rework, reverify or
 * cancel wrote first, and this call reports what happened and changes nothing.
 * It returns what was written and the data to put back if the answer fails.
 */
export async function claimWaitingTask(
  store: ObjectStore,
  id: string,
  seen: number,
  action: string,
  change: (latest: TaskData) => TaskData,
): Promise<{ readonly claimed: StoredObject; readonly before: TaskData }> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  const at = `task "${bareId(id)}"`;
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    if (current.version !== seen || latest.phase !== "waiting") {
      throw new DevError(
        action,
        `${at} changed since you looked (it is ${latest.phase}); ${action} did nothing`,
      );
    }
    const claimed = await writeTask(
      store,
      id,
      change(latest),
      `dev:task-${action}`,
    );
    return { claimed, before: latest };
  });
}

/** Puts back a task a failed claim changed, unless something wrote it since. */
export async function releaseWaitingClaim(
  store: ObjectStore,
  id: string,
  claimed: StoredObject,
  before: TaskData,
): Promise<void> {
  const data = taskData(claimed.data);
  await withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    if (current.version !== claimed.version) return;
    await writeTask(store, id, before, "dev:task-claim-released");
  });
}

/** Appends the owner's rework section and leaves the task for the flow. */
export async function rejectTask(
  store: ObjectStore,
  id: string,
  note: string,
): Promise<StoredObject> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  const at = `task "${bareId(id)}"`;
  if (data.phase !== "waiting") {
    throw new DevError(
      "reject",
      `${at} is ${data.phase}, not waiting; only a waiting task can be rejected`,
    );
  }
  const text = note.trim();
  if (text.length === 0) {
    throw new DevError("note", "must be a non-empty string");
  }
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    if (latest.phase !== "waiting") {
      throw new DevError(
        "reject",
        `${at} is ${latest.phase}, not waiting; only a waiting task can be rejected`,
      );
    }
    return writeTask(
      store,
      id,
      { ...latest, brief: appendRework(latest.brief, "owner", text) },
      "dev:task-reject",
    );
  });
}

/** Appends a rework section and records it. */
export async function addRework(
  store: ObjectStore,
  id: string,
  source: string,
  text: string,
): Promise<StoredObject> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    return writeTask(
      store,
      id,
      { ...latest, brief: appendRework(latest.brief, source, text) },
      "dev:task-rework",
    );
  });
}

export async function confirmPlan(
  store: ObjectStore,
  id: string,
): Promise<StoredObject> {
  const initial = await getPlan(store, id);
  return withRepoLock(store, planData(initial.data).repository, async () => {
    const plan = await getPlan(store, id);
    const data = planData(plan.data);
    if (data.status === "confirmed") {
      throw new DevError(
        "confirm",
        `plan "${bareId(id)}" is already confirmed`,
      );
    }
    if (data.status === "cancelled") {
      throw new DevError("confirm", `plan "${bareId(id)}" is cancelled`);
    }
    const tasks = await tasksOfPlan(store, id);
    if (tasks.length === 0) {
      throw new DevError("confirm", `plan "${bareId(id)}" has no tasks`);
    }
    for (const object of tasks) {
      const task = taskData(object.data);
      if (task.phase !== "proposed") continue;
      await writeTask(
        store,
        object.id,
        {
          ...task,
          phase: "ready",
          brief: appendChange(task.brief, "ready"),
        },
        "dev:task-ready",
      );
    }
    const next: PlanData = { ...data, status: "confirmed" };
    return writePlan(store, id, next, "dev:plan-confirm");
  });
}

export async function confirmTask(
  store: ObjectStore,
  id: string,
): Promise<StoredObject> {
  const initial = await getTask(store, id);
  const initialData = taskData(initial.data);
  return withRepoLock(store, initialData.repository, async () => {
    const task = await getTask(store, id);
    const data = taskData(task.data);
    if (data.phase === "ready") {
      throw new DevError("confirm", `task "${bareId(id)}" is already ready`);
    }
    if (data.phase !== "proposed") {
      throw new DevError(
        "confirm",
        `task "${bareId(id)}" is ${data.phase}; only a proposed task can be confirmed`,
      );
    }
    const plan = await getPlan(
      store,
      storeKey(data.repository, data.plan),
    );
    if (planData(plan.data).status !== "confirmed") {
      throw new DevError(
        "confirm",
        `plan "${data.plan}" is not confirmed`,
      );
    }
    return writeTask(
      store,
      id,
      { ...data, phase: "ready", brief: appendChange(data.brief, "ready") },
      "dev:task-confirm",
    );
  });
}

async function cancelTasks(
  store: ObjectStore,
  tasks: readonly StoredObject[],
): Promise<readonly string[]> {
  const runs: string[] = [];
  for (const object of tasks) {
    const data = taskData(object.data);
    if (!isOpenTask(data)) continue;
    if (data.run !== null) runs.push(data.run);
    await writeTask(
      store,
      object.id,
      {
        ...data,
        phase: "cancelled",
        run: null,
        claim: null,
        brief: appendChange(data.brief, "cancelled"),
      },
      "dev:task-cancel",
    );
  }
  return runs;
}

export interface CancelOptions {
  readonly runs?: DevRunControl | undefined;
}

export async function cancelPlan(
  store: ObjectStore,
  id: string,
  options: CancelOptions = {},
): Promise<{ readonly plan: StoredObject; readonly runs: readonly string[] }> {
  const initial = await getPlan(store, id);
  const initialData = planData(initial.data);
  const cancelled = await withRepoLock(
    store,
    initialData.repository,
    async () => {
      const plan = await getPlan(store, id);
      const data = planData(plan.data);
      if (data.status === "cancelled") {
        throw new DevError(
          "cancel",
          `plan "${bareId(id)}" is already cancelled`,
        );
      }
      const tasks = await tasksOfPlan(store, id);
      const runs = await cancelTasks(store, tasks);
      const next: PlanData = { ...data, status: "cancelled" };
      const written = await writePlan(store, id, next, "dev:plan-cancel");
      await refreshPlanCounts(store, written);
      return { plan: written, runs };
    },
  );
  for (const run of cancelled.runs) {
    await options.runs?.cancel(run);
  }
  return cancelled;
}

export async function cancelTask(
  store: ObjectStore,
  id: string,
  options: CancelOptions = {},
): Promise<{ readonly task: StoredObject; readonly runs: readonly string[] }> {
  const initial = await getTask(store, id);
  const initialData = taskData(initial.data);
  const cancelled = await withRepoLock(
    store,
    initialData.repository,
    async () => {
      const task = await getTask(store, id);
      const data = taskData(task.data);
      if (data.phase === "cancelled") {
        throw new DevError(
          "cancel",
          `task "${bareId(id)}" is already cancelled`,
        );
      }
      if (data.phase === "merged") {
        throw new DevError("cancel", `task "${bareId(id)}" is already merged`);
      }
      const runs = data.run === null ? [] : [data.run];
      const written = await writeTask(
        store,
        id,
        {
          ...data,
          phase: "cancelled",
          run: null,
          claim: null,
          brief: appendChange(data.brief, "cancelled"),
        },
        "dev:task-cancel",
      );
      const plan = await getPlan(
        store,
        storeKey(data.repository, data.plan),
      );
      await refreshPlanCounts(store, plan);
      return { task: written, runs };
    },
  );
  for (const run of cancelled.runs) {
    await options.runs?.cancel(run);
  }
  return cancelled;
}

export async function setAuto(
  store: ObjectStore,
  id: string,
  auto: AutoMode,
): Promise<StoredObject> {
  const initial = await getPlan(store, id);
  const data = planData(initial.data);
  if (data.status === "cancelled") {
    throw new DevError("auto", `plan "${bareId(id)}" is cancelled`);
  }
  return withRepoLock(store, data.repository, async () => {
    const plan = await getPlan(store, id);
    const fresh = planData(plan.data);
    if (fresh.status === "cancelled") {
      throw new DevError("auto", `plan "${bareId(id)}" is cancelled`);
    }
    return writePlan(
      store,
      id,
      { ...fresh, auto },
      `dev:plan-auto-${auto}`,
    );
  });
}

export async function setPriority(
  store: ObjectStore,
  id: string,
  priority: Priority,
): Promise<StoredObject> {
  if (!PRIORITIES.includes(priority)) {
    throw new DevError("priority", `unknown priority "${priority}"`);
  }
  const initial = await getPlan(store, id);
  const data = planData(initial.data);
  if (data.status === "cancelled") {
    throw new DevError("priority", `plan "${bareId(id)}" is cancelled`);
  }
  return withRepoLock(store, data.repository, async () => {
    const plan = await getPlan(store, id);
    const fresh = planData(plan.data);
    if (fresh.status === "cancelled") {
      throw new DevError("priority", `plan "${bareId(id)}" is cancelled`);
    }
    return writePlan(
      store,
      id,
      { ...fresh, priority },
      `dev:plan-priority-${priority}`,
    );
  });
}

export async function setConcurrency(
  store: ObjectStore,
  id: string,
  count: number,
): Promise<StoredObject> {
  const concurrency = validatePlanConcurrency(count);
  const initial = await getPlan(store, id);
  const data = planData(initial.data);
  if (data.status === "cancelled" || planState(data) === "finished") {
    throw new DevError("concurrency", `plan "${bareId(id)}" is ${planState(data)}`);
  }
  return withRepoLock(store, data.repository, async () => {
    const plan = await getPlan(store, id);
    const fresh = planData(plan.data);
    if (fresh.status === "cancelled" || planState(fresh) === "finished") {
      throw new DevError("concurrency", `plan "${bareId(id)}" is ${planState(fresh)}`);
    }
    return writePlan(
      store,
      id,
      { ...fresh, concurrency },
      `dev:plan-concurrency-${concurrency}`,
    );
  });
}

export async function raisePriority(
  store: ObjectStore,
  id: string,
): Promise<StoredObject> {
  const plan = await getPlan(store, id);
  const data = planData(plan.data);
  const next = PRIORITIES[priorityIndex(data.priority) - 1];
  if (next === undefined) {
    throw new DevError("priority", `plan "${bareId(id)}" is already P0`);
  }
  return setPriority(store, id, next);
}

export async function lowerPriorityOf(
  store: ObjectStore,
  id: string,
): Promise<StoredObject> {
  const plan = await getPlan(store, id);
  const data = planData(plan.data);
  const next = lowerPriority(data.priority);
  if (next === undefined) {
    throw new DevError("priority", `plan "${bareId(id)}" is already P5`);
  }
  return setPriority(store, id, next);
}

/* ---------------------------------------------------------------------------
 * History
 * ------------------------------------------------------------------------- */

/** Rebuilds the objects a store's facts describe, in append order. */
export function rebuildObjects(
  facts: readonly {
    readonly type: string;
    readonly object: { readonly type: string; readonly id: string } | undefined;
    readonly data: Record<string, unknown>;
  }[],
): Map<string, Record<string, unknown>> {
  const objects = new Map<string, Record<string, unknown>>();
  for (const fact of facts) {
    const object = fact.object;
    if (object === undefined || fact.type !== object.type) continue;
    objects.set(`${object.type}:${object.id}`, { ...fact.data });
  }
  return objects;
}

/** The live object data, keyed the way `rebuildObjects` keys it. */
export async function liveObjects(
  store: ObjectStore,
): Promise<Map<string, Record<string, unknown>>> {
  const objects = new Map<string, Record<string, unknown>>();
  for (const type of [REPOSITORY_TYPE, PLAN_TYPE, TASK_TYPE]) {
    for (const object of await listAll(store, type)) {
      objects.set(`${type}:${object.id}`, { ...object.data });
    }
  }
  return objects;
}

/** A helper later tasks use to check an id belongs to the expected plan. */
export function taskBelongsTo(object: StoredObject, plan: string): boolean {
  const data = taskData(object.data);
  return data.plan === plan;
}
