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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ObjectStore, StoredObject } from "@operad-io/engine";
import { withRepositoryLock } from "./lock.ts";
import {
  appendChange,
  appendRework,
  bareId,
  DevError,
  editBrief,
  isOpenTask,
  isRecord,
  keyRepository,
  listAll,
  lowerPriority,
  nextId,
  parseId,
  planData,
  PRIORITIES,
  priorityIndex,
  repositoryData,
  storeKey,
  taskData,
  validateRepositoryName,
  validateSlug,
  validateTitle,
  type AutoMode,
  type PlanData,
  type Priority,
  type RepositoryData,
  type TaskData,
  type TaskPhase,
} from "./model.ts";
import { DEFAULT_DEV_SETTINGS } from "./settings.ts";

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

const REPOSITORY_TYPE = "repository";
const PLAN_TYPE = "plan";
const TASK_TYPE = "task";

const EXCLUDES = [".operad-worktrees/", ".radian-sandbox/"] as const;

/**
 * The operad source checkout this module was loaded from, when it came from
 * source. `repo add` never registers it: a test that uses it would write into
 * the repository it is testing.
 */
const SOURCE_CHECKOUT = findSourceCheckout();

function findSourceCheckout(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (isRecord(parsed) && parsed.name === "operad-workspace") {
          return realpathSync(directory);
        }
      } catch {
        // Not this directory's manifest; keep walking.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

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

async function repositories(store: ObjectStore): Promise<readonly StoredObject[]> {
  return listAll(store, REPOSITORY_TYPE);
}

export async function findRepository(
  store: ObjectStore,
  name: string,
  options: { readonly includeRemoved?: boolean | undefined } = {},
): Promise<StoredObject | undefined> {
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

/** The repository the current directory belongs to, or the named one. */
export async function resolveRepository(
  store: ObjectStore,
  options: ResolveRepositoryOptions = {},
): Promise<RepositoryData> {
  if (options.name !== undefined) {
    const found = await findRepository(store, options.name);
    if (found === undefined) {
      throw new DevError(
        "repo",
        `no registered repository "${options.name}"`,
      );
    }
    return repositoryData(found.data);
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const registered = await listRepositories(store);
  const matches = registered.filter((repository) =>
    inside(resolve(repository.path), cwd),
  );
  matches.sort((left, right) => right.path.length - left.path.length);
  const found = matches[0];
  if (found === undefined) {
    throw new DevError(
      "repo",
      `no registered repository here; pass --repo <name>`,
    );
  }
  return found;
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
): Promise<string | undefined> {
  const prefix =
    type === PLAN_TYPE ? "PL" : type === TASK_TYPE ? "TK" : undefined;
  if (prefix === undefined) return undefined;
  if (parseId(id, prefix) === undefined) return undefined;
  let repository: RepositoryData;
  try {
    repository = await resolveRepository(store, { cwd });
  } catch (error) {
    if (error instanceof DevError) return undefined;
    throw error;
  }
  return storeKey(repository.name, id);
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
        name,
        remote: DEFAULT_DEV_SETTINGS.remote,
        mainBranch: DEFAULT_DEV_SETTINGS.mainBranch,
        worktreeRoot: DEFAULT_DEV_SETTINGS.worktreeRoot,
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
  if (SOURCE_CHECKOUT !== undefined && path === SOURCE_CHECKOUT) {
    throw new DevError(
      "path",
      `"${path}" is the operad source checkout; register a work tree of your own`,
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

  const data: RepositoryData = { name, path, removed: false };
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
  return store.put(PLAN_TYPE, id, data, cause);
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
  if (
    data.taskCount === taskCount &&
    data.mergedCount === mergedCount &&
    data.cancelledCount === cancelledCount
  ) {
    return plan;
  }
  const next: PlanData = {
    ...data,
    taskCount,
    mergedCount,
    cancelledCount,
  };
  return writePlan(store, plan.id, next, "dev:refresh-plan");
}

export interface AddPlanOptions {
  readonly repository: RepositoryData;
  readonly slug: string;
  readonly title: string;
  readonly request?: string | undefined;
}

export async function addPlan(
  store: ObjectStore,
  options: AddPlanOptions,
): Promise<StoredObject> {
  const slug = validateSlug(options.slug);
  const title = validateTitle(options.title);
  return withRepoLock(store, options.repository.name, async (repository) => {
    const id = await nextId(store, "plan", repository.name, slug);
    const data: PlanData = {
      repository: repository.name,
      title,
      request: options.request ?? "",
      status: "draft",
      auto: "off",
      priority: "P3",
      concurrency: 1,
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
  return withRepoLock(store, planObject.repository, async (repository) => {
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
    const data: TaskData = {
      repository: repository.name,
      plan: bareId(currentPlan.id),
      title,
      brief,
      after,
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
  });
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
}

export async function updateTask(
  store: ObjectStore,
  id: string,
  options: UpdateTaskOptions,
): Promise<StoredObject> {
  if (options.title === undefined && options.after === undefined) {
    throw new DevError("update", "nothing to change; pass --title or --after");
  }
  const title =
    options.title === undefined ? undefined : validateTitle(options.title);
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
    let brief = data.brief;
    for (const line of lines) brief = appendChange(brief, line);
    const next: TaskData = {
      ...data,
      ...(title === undefined ? {} : { title }),
      after,
      brief,
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
