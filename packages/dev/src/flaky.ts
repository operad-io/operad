/**
 * Proposes a task when a test keeps passing only on its rerun. Each pass on a
 * rerun is remembered per repository and test; when the count reaches
 * `check.flakyTask` and no open task names the test, one task is proposed in
 * the plan `check.flakyPlan` names, else the repository's own plan `flaky-tests`.
 *
 * The proposal runs under the repository lock and finds an earlier proposal by
 * the test name in the open tasks, so a crash between the decision and the
 * proposal leaves nothing half done: the next call decides again and proposes
 * exactly one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectStore, StoredObject } from "@operad-io/engine";
import { messageOf, type SecretStore } from "@operad-io/engine";
import {
  bareId,
  changeClock,
  isOpenTask,
  isRecord,
  keyRepository,
  listAll,
  parseId,
  planData,
  planState,
  splitBrief,
  taskData,
  type PlanData,
  type RepositoryData,
} from "./model.ts";
import { anchoredPattern, shellQuote } from "./rerun.ts";
import { addConfirmedPlanLocked, addTaskLocked, withRepoLock } from "./service.ts";

const MASK = "***";
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|PASSWORD|AUTH|CREDENTIAL)/i;
const SECRET_MIN_CHARS = 6;

/** The text with each known secret value, and each secret-named environment value, shown as `***`. */
export function maskSecrets(
  text: string,
  secrets: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const values = new Set<string>();
  for (const value of secrets) if (value.length > 0) values.add(value);
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= SECRET_MIN_CHARS && SECRET_NAME.test(name)) {
      values.add(value);
    }
  }
  let out = text;
  for (const value of [...values].sort((x, y) => y.length - x.length)) {
    out = out.split(value).join(MASK);
  }
  return out;
}

const FLAKY_TYPE = "flaky-test";
const EXCERPT_LINES = 30;
const SHOWN_FAILURES = 2;
const SHOWN_TIMES = 20;

/** Test-only: set by a test to stop between the decision and the proposal. */
export const flakyTestHooks: {
  beforePropose?: ((name: string) => Promise<void> | void) | undefined;
} = {};

export interface FlakyOccurrence {
  readonly task: string;
  readonly at: number;
  readonly file: string | undefined;
  /** The "(fail)" line and the lines before it; empty when the log was gone. */
  readonly excerpt: string;
}

export interface FlakyRecord {
  readonly [key: string]: unknown;
  readonly repository: string;
  readonly name: string;
  readonly occurrences: readonly FlakyOccurrence[];
  /** The task proposed for this test; the count restarts when it ended. */
  readonly task?: string | undefined;
  /** The count a "no plan" notice was recorded for, so it is not repeated. */
  readonly noticed?: number | undefined;
}

function recordKey(repository: string, name: string): string {
  return `${repository}/${Buffer.from(name).toString("hex")}`;
}

function occurrenceOf(value: unknown): FlakyOccurrence | undefined {
  if (!isRecord(value)) return undefined;
  const { task, at, file, excerpt } = value;
  if (typeof task !== "string" || typeof at !== "number") return undefined;
  return {
    task,
    at,
    file: typeof file === "string" ? file : undefined,
    excerpt: typeof excerpt === "string" ? excerpt : "",
  };
}

function recordOf(data: unknown): FlakyRecord | undefined {
  if (!isRecord(data)) return undefined;
  const { repository, name, occurrences, task, noticed } = data;
  if (typeof repository !== "string" || typeof name !== "string") return undefined;
  if (!Array.isArray(occurrences)) return undefined;
  return {
    repository,
    name,
    occurrences: occurrences
      .map(occurrenceOf)
      .filter((entry): entry is FlakyOccurrence => entry !== undefined),
    ...(typeof task === "string" ? { task } : {}),
    ...(typeof noticed === "number" ? { noticed } : {}),
  };
}

function writableOf(record: FlakyRecord): Record<string, unknown> {
  return {
    repository: record.repository,
    name: record.name,
    occurrences: record.occurrences.map((entry) => ({
      task: entry.task,
      at: entry.at,
      excerpt: entry.excerpt,
      ...(entry.file === undefined ? {} : { file: entry.file }),
    })),
    ...(record.task === undefined ? {} : { task: record.task }),
    ...(record.noticed === undefined ? {} : { noticed: record.noticed }),
  };
}

const SUMMARY_START = /^\s*\d+ tests? failed:\s*$/;
const FILE_HEADER = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/;

/**
 * The "(fail)" line of a test with up to 30 lines before it, and the file whose
 * section holds it. bun repeats every failure in a summary after the last
 * file's section; that repeat names no file, so the first "(fail)" line of the
 * test before the summary is the test's own. A test seen only in the summary
 * has an excerpt and no file.
 */
export function failureExcerpt(
  log: string,
  name: string,
): { readonly excerpt: string; readonly file: string | undefined } {
  const lines = log.replace(/\r\n/g, "\n").split("\n");
  const wanted = `(fail) ${name} [`;
  let found = -1;
  let inSummary = false;
  let file: string | undefined;
  let current: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (SUMMARY_START.test(line)) inSummary = true;
    const header = FILE_HEADER.exec(line);
    if (header !== null && !inSummary) current = header[1];
    if (!line.startsWith(wanted)) continue;
    if (!inSummary) {
      found = index;
      file = current;
      break;
    }
    if (found < 0) found = index;
  }
  if (found < 0) return { excerpt: "", file: undefined };
  const excerpt = lines.slice(Math.max(0, found - EXCERPT_LINES), found + 1).join("\n");
  return { excerpt, file };
}

const SEARCH_SKIP = /(?:^|\/)(?:node_modules|\.git|\.operad-worktrees)\//;

/**
 * The one test file of the repository that holds every part of the test's name
 * (its describe names and its own), or undefined when none or several do.
 */
export function searchTestFile(repositoryPath: string, name: string): string | undefined {
  const parts = name.split(" > ").filter((part) => part !== "");
  if (parts.length === 0) return undefined;
  const hits: string[] = [];
  try {
    for (const path of new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scanSync({
      cwd: repositoryPath,
    })) {
      if (SEARCH_SKIP.test(path)) continue;
      let text: string;
      try {
        text = readFileSync(join(repositoryPath, path), "utf8");
      } catch {
        continue;
      }
      if (parts.every((part) => text.includes(part))) hits.push(path);
    }
  } catch {
    return undefined;
  }
  return hits.length === 1 ? hits[0] : undefined;
}

function slugOf(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const kept = `flaky-${words === "" ? "test" : words}`.slice(0, 48).replace(/-+$/, "");
  return kept;
}

function packageOf(file: string | undefined): string {
  const match = file === undefined ? null : /(?:^|\/)packages\/([^/]+)\//.exec(file);
  return match?.[1] ?? "tests";
}

const FLAKY_RULE =
  "A test that failed and then passed on rerun is a bug until shown otherwise. A task that fixes one states the stress command and its result before and after the fix in its final answer, and is done when `bash scripts/stress.sh --runs <N> --load 2 <file>` passes, N sized so the run takes about ten minutes (at least 20, at most 200). Never raise a timeout or add a retry inside a test to make it pass.";

/** The "Flaky tests" section of the repository's CLAUDE.md, else the rule as written here. */
function flakyRule(repositoryPath: string): string {
  try {
    const text = readFileSync(join(repositoryPath, "CLAUDE.md"), "utf8");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const start = lines.findIndex((line) => /^##\s+Flaky tests\s*$/.test(line));
    if (start >= 0) {
      let end = lines.length;
      for (let index = start + 1; index < lines.length; index += 1) {
        if (/^##\s/.test(lines[index] ?? "")) {
          end = index;
          break;
        }
      }
      const body = lines.slice(start + 1, end).join("\n").trim();
      if (body !== "") return body;
    }
  } catch {
    // No CLAUDE.md: the rule below stands.
  }
  return FLAKY_RULE;
}

function stamp(at: number): string {
  return new Date(at).toISOString();
}

/** The brief of the proposed task. */
export function flakyBrief(
  repositoryPath: string,
  record: FlakyRecord,
): string {
  const file = [...record.occurrences].reverse().find((entry) => entry.file !== undefined)?.file;
  const where = file === undefined ? "a file that is not known (the logs do not name it and no single test file holds the name)" : `\`${file}\``;
  const lines: string[] = [
    `The test \`${record.name}\` in ${where} failed and then passed on its own rerun ${record.occurrences.length} times.`,
    "",
    "It happened in:",
    ...record.occurrences
      .slice(-SHOWN_TIMES)
      .map((entry) => `- ${entry.task} at ${stamp(entry.at)}`),
    "",
    "The last failures:",
  ];
  const failures = record.occurrences
    .filter((entry) => entry.excerpt !== "")
    .slice(-SHOWN_FAILURES);
  if (failures.length === 0) lines.push("", "(no log was left to quote)");
  for (const entry of failures) {
    const fence = entry.excerpt.includes("```") ? "~~~~" : "```";
    lines.push("", `${entry.task} at ${stamp(entry.at)}:`, fence, entry.excerpt, fence);
  }
  const pattern = record.name.replace(/ > /g, " ");
  const command = existsSync(join(repositoryPath, "scripts", "stress.sh"))
    ? `bash scripts/stress.sh --runs <N> --load 2 -t ${shellQuote(pattern)}${file === undefined ? "" : ` ${shellQuote(file)}`}`
    : `bun test --rerun-each <N> -t ${shellQuote(anchoredPattern(record.name))}${file === undefined ? "" : ` ${shellQuote(file)}`}`;
  lines.push("", "Reproduce it:", "```sh", command, "```", "", "Write the number of runs in place of `<N>`: it follows the rule quoted below.", "", "The rule for flaky tests:", "", flakyRule(repositoryPath));
  return lines.join("\n");
}

async function newestConfirmedPlan(
  store: ObjectStore,
  repository: string,
): Promise<StoredObject | undefined> {
  let best: { readonly object: StoredObject; readonly number: number } | undefined;
  for (const object of await listAll(store, "plan")) {
    const plan = planData(object.data);
    if (plan.repository !== repository || plan.status !== "confirmed") continue;
    const number = parseId(bareId(object.id), "plan")?.number ?? -1;
    if (best === undefined || number > best.number) best = { object, number };
  }
  return best?.object;
}

const FLAKY_PLAN_SLUG = "flaky-tests";
const FLAKY_PLAN_TITLE = "Flaky tests";

function isEnded(plan: PlanData): boolean {
  const state = planState(plan);
  return state === "finished" || state === "cancelled";
}

/**
 * The plan flaky-test tasks go into: `check.flakyPlan` when it names a plan of
 * the repository that is not finished or cancelled, else dev's own plan
 * `flaky-tests`, made once (confirmed, with the auto level and priority of the
 * repository's newest confirmed plan). Runs under the repository lock.
 */
async function flakyPlanFor(
  store: ObjectStore,
  repository: RepositoryData,
  configured: string | undefined,
): Promise<StoredObject> {
  if (configured !== undefined) {
    const named = await store.get("plan", `${repository.name}/${bareId(configured)}`);
    if (named !== undefined) {
      const data = planData(named.data);
      if (data.repository === repository.name && !isEnded(data)) return named;
    }
  }
  const own = (await listAll(store, "plan"))
    .filter((object) => {
      const data = planData(object.data);
      return (
        data.repository === repository.name &&
        parseId(bareId(object.id), "plan")?.slug === FLAKY_PLAN_SLUG &&
        !isEnded(data)
      );
    })
    .sort(
      (x, y) =>
        (parseId(bareId(y.id), "plan")?.number ?? -1) - (parseId(bareId(x.id), "plan")?.number ?? -1),
    )[0];
  if (own !== undefined) return own;
  const model = await newestConfirmedPlan(store, repository.name);
  const data = model === undefined ? undefined : planData(model.data);
  return addConfirmedPlanLocked(store, repository, {
    slug: FLAKY_PLAN_SLUG,
    title: FLAKY_PLAN_TITLE,
    auto: data?.auto ?? "off",
    priority: data?.priority ?? "P3",
  });
}

/** The title of the task dev proposes for a test. */
function titleFor(name: string): string {
  return `Fix the flaky test: ${name}`;
}

/**
 * Whether an open task is the test's task: its title is exactly the title dev
 * gives a flaky task, or a line of its brief, outside fenced code and quoted
 * text, is exactly the full test name. A task dev proposed for the test is
 * linked on the test's record, not found here. Nothing else counts, so a
 * failure excerpt in another brief never links a test.
 */
export function namesTest(title: string, brief: string, name: string): boolean {
  if (title === titleFor(name)) return true;
  let fenced = false;
  for (const line of brief.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.trimStart().startsWith(">")) continue;
    if (line.trim() === name) return true;
  }
  return false;
}

async function namingTask(
  store: ObjectStore,
  repository: string,
  name: string,
): Promise<StoredObject | undefined> {
  return (await listAll(store, "task")).find((object) => {
    const task = taskData(object.data);
    return (
      task.repository === repository &&
      isOpenTask(task) &&
      namesTest(task.title, splitBrief(task.brief).body, name)
    );
  });
}

export interface FlakyInput {
  readonly store: ObjectStore;
  /** Secret values to hide in the failure excerpts. */
  readonly secrets?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly repository: RepositoryData;
  /** The task whose check passed the tests on rerun. */
  readonly taskId: string;
  readonly names: readonly string[];
  /** The check log, which still holds the first run's output. */
  readonly log: string | undefined;
  /** `check.flakyTask`; 0 turns the proposal off. */
  readonly threshold: number;
  /** `check.flakyPlan`: the plan to propose in, by id. */
  readonly flakyPlan?: string | undefined;
}

function readLog(path: string | undefined): string {
  if (path === undefined) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function taskEnded(store: ObjectStore, repository: string, id: string): Promise<boolean> {
  const object = await store.get("task", `${repository}/${id}`);
  return object === undefined || !isOpenTask(taskData(object.data));
}

/**
 * Remembers the tests that passed on rerun and proposes a task for each test
 * that reached the threshold. Safe to call again at any time.
 */
export async function trackFlakyTests(input: FlakyInput): Promise<string | undefined> {
  if (input.threshold <= 0 || input.names.length === 0) return undefined;
  const notices: string[] = [];
  const { store, repository } = input;
  const log = readLog(input.log);
  const at = changeClock.now();
  await withRepoLock(store, repository.name, async (fresh) => {
    for (const name of input.names) {
      const key = recordKey(fresh.name, name);
      const stored = await store.get(FLAKY_TYPE, key);
      let record: FlakyRecord = recordOf(stored?.data) ?? {
        repository: fresh.name,
        name,
        occurrences: [],
      };
      if (record.task !== undefined && (await taskEnded(store, fresh.name, record.task))) {
        record = { repository: fresh.name, name, occurrences: [] };
      }
      if (record.task === undefined) {
        // An open task that names the test is its task from the first pass on:
        // the count restarts when that task ends, however few passes came before.
        const existing = await namingTask(store, fresh.name, name);
        if (existing !== undefined) {
          record = { ...record, task: bareId(existing.id) };
          await store.put(FLAKY_TYPE, key, writableOf(record), "dev:flaky-task");
        }
      }
      // While its task is open the count does not grow: the fix is on its way.
      if (record.task !== undefined) continue;
      const found = failureExcerpt(log, name);
      const file = found.file ?? searchTestFile(fresh.path, name);
      const excerpt = maskSecrets(found.excerpt, input.secrets ?? [], input.env);
      record = {
        ...record,
        occurrences: [
          ...record.occurrences,
          { task: input.taskId, at, file, excerpt },
        ],
      };
      await store.put(FLAKY_TYPE, key, writableOf(record), "dev:flaky-count");
    }
    // Decide for every counted test of the repository: a crash after the count
    // was written and before the task was proposed is finished here.
    for (const object of await listAll(store, FLAKY_TYPE)) {
      if (keyRepository(object.id) !== fresh.name) continue;
      const record = recordOf(object.data);
      if (record === undefined || record.task !== undefined) continue;
      if (record.occurrences.length < input.threshold) continue;
      const notice = await propose(input, fresh, object.id, record);
      if (notice !== undefined) notices.push(notice);
    }
  });
  return notices.length === 0 ? undefined : notices.join("; ");
}

async function propose(
  input: FlakyInput,
  repository: RepositoryData,
  key: string,
  record: FlakyRecord,
): Promise<string | undefined> {
  const { store } = input;
  const existing = await namingTask(store, repository.name, record.name);
  if (existing !== undefined) {
    // Its task is the one that counts: the count restarts when that task ends.
    await store.put(
      FLAKY_TYPE,
      key,
      writableOf({ ...record, task: bareId(existing.id) }),
      "dev:flaky-task",
    );
    return undefined;
  }
  const plan = await flakyPlanFor(store, repository, input.flakyPlan);
  await flakyTestHooks.beforePropose?.(record.name);
  const file = [...record.occurrences].reverse().find((entry) => entry.file !== undefined)?.file;
  try {
    const task = await addTaskLocked(
      store,
      {
        plan: plan.id,
        slug: slugOf(record.name),
        title: titleFor(record.name),
        brief: flakyBrief(repository.path, record),
        area: packageOf(file),
      },
      repository,
    );
    await store.put(
      FLAKY_TYPE,
      key,
      writableOf({ ...record, task: bareId(task.id) }),
      "dev:flaky-task",
    );
    return undefined;
  } catch (error) {
    return noticeFor(record, messageOf(error));
  }
}

function noticeFor(record: FlakyRecord, reason: string): string {
  return `flaky test "${record.name}" passed on rerun ${record.occurrences.length} times; no task was proposed: ${reason}`;
}

/** The open task of each test name, across the home; the first one found wins. */
export async function flakyTasksByName(
  store: ObjectStore,
): Promise<ReadonlyMap<string, string>> {
  const tasks = new Map<string, string>();
  for (const object of await listAll(store, FLAKY_TYPE)) {
    const record = recordOf(object.data);
    if (record?.task === undefined || tasks.has(record.name)) continue;
    if (await taskEnded(store, record.repository, record.task)) continue;
    tasks.set(record.name, record.task);
  }
  return tasks;
}

/** What a check step passes on after it recorded its passes on rerun. */
export interface FlakyReport {
  readonly ctx: {
    readonly store: ObjectStore;
    readonly secrets: SecretStore;
    readonly logger: { write(text: string): Promise<string> | string };
  };
  readonly repository: RepositoryData;
  readonly taskId: string;
  readonly threshold: number;
  readonly flakyPlan?: string | undefined;
  readonly check: {
    readonly passedOnRerun: readonly string[];
    readonly outcome: { readonly data?: Record<string, unknown> | undefined } | undefined;
  };
}

async function secretValues(store: SecretStore): Promise<string[]> {
  try {
    const values: string[] = [];
    for (const name of await store.names()) {
      const secret = await store.get(name);
      if (secret !== undefined) values.push(secret.reveal());
    }
    return values;
  } catch {
    return [];
  }
}

/**
 * Counts the passes on rerun of a finished check; a failure here never fails
 * the check. Returns a notice for the check's history when no task could be
 * proposed.
 */
export async function reportFlakyTests(report: FlakyReport): Promise<string | undefined> {
  if (report.threshold <= 0 || report.check.passedOnRerun.length === 0) return undefined;
  const log = report.check.outcome?.data?.log;
  try {
    return await trackFlakyTests({
      store: report.ctx.store,
      secrets: await secretValues(report.ctx.secrets),
      repository: report.repository,
      taskId: report.taskId,
      names: report.check.passedOnRerun,
      log: typeof log === "string" ? log : undefined,
      threshold: report.threshold,
      flakyPlan: report.flakyPlan,
    });
  } catch (error) {
    await report.ctx.logger.write(`could not propose a task for a flaky test: ${messageOf(error)}`);
    return undefined;
  }
}
