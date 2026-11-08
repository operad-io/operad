/**
 * Proposes a task when a test keeps passing only on its rerun. Each pass on a
 * rerun is remembered per repository and test; when the count reaches
 * `check.flakyTask` and no open task names the test, one task is proposed in
 * the repository's newest confirmed plan that is not finished.
 *
 * The proposal runs under the repository lock and finds an earlier proposal by
 * the test name in the open tasks, so a crash between the decision and the
 * proposal leaves nothing half done: the next call decides again and proposes
 * exactly one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectStore, StoredObject } from "@operad-io/engine";
import { messageOf, type FactWriter } from "@operad-io/engine";
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
  taskData,
  type RepositoryData,
} from "./model.ts";
import { anchoredPattern, shellQuote } from "./rerun.ts";
import { addTaskLocked, withRepoLock } from "./service.ts";

const FLAKY_TYPE = "flaky-test";
const MAX_TITLE_NAME = 120;
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

/** The log text of the first run: the reruns are drawn after their headings. */
function firstRunText(log: string): string {
  const cut = log.search(/^===== (?:rerun of failed test:|check failed; running it once more)/m);
  return cut < 0 ? log : log.slice(0, cut);
}

/** The "(fail)" line of a test with up to 30 lines before it, and the file named above it. */
export function failureExcerpt(
  log: string,
  name: string,
): { readonly excerpt: string; readonly file: string | undefined } {
  const lines = firstRunText(log).replace(/\r\n/g, "\n").split("\n");
  const wanted = `(fail) ${name} [`;
  let found = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").startsWith(wanted)) found = index;
  }
  if (found < 0) return { excerpt: "", file: undefined };
  let file: string | undefined;
  for (let index = found; index >= 0; index -= 1) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(lines[index] ?? "");
    if (header !== null) {
      file = header[1];
      break;
    }
  }
  const excerpt = lines.slice(Math.max(0, found - EXCERPT_LINES), found + 1).join("\n");
  return { excerpt, file };
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
  "A test that failed and then passed on rerun is a bug until shown otherwise. A task that fixes one states the stress command and its result before and after the fix in its final answer, and is done when `bash scripts/stress.sh --runs 200 --load 2 <file>` passes. Never raise a timeout or add a retry inside a test to make it pass.";

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
  const where = file === undefined ? "a file not found in the logs" : `\`${file}\``;
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
    ? `bash scripts/stress.sh --runs 200 --load 2 -t ${shellQuote(pattern)}${file === undefined ? "" : ` ${shellQuote(file)}`}`
    : `bun test --rerun-each 200 -t ${shellQuote(anchoredPattern(record.name))}${file === undefined ? "" : ` ${shellQuote(file)}`}`;
  lines.push("", "Reproduce it:", "```sh", command, "```", "", "The rule for flaky tests:", "", flakyRule(repositoryPath));
  return lines.join("\n");
}

async function newestOpenPlan(
  store: ObjectStore,
  repository: string,
): Promise<StoredObject | undefined> {
  let best: { readonly object: StoredObject; readonly number: number } | undefined;
  for (const object of await listAll(store, "plan")) {
    const plan = planData(object.data);
    if (plan.repository !== repository || plan.status !== "confirmed") continue;
    if (planState(plan) === "finished") continue;
    const number = parseId(bareId(object.id), "plan")?.number ?? -1;
    if (best === undefined || number > best.number) best = { object, number };
  }
  return best?.object;
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
      (task.title.includes(name) || task.brief.includes(name))
    );
  });
}

export interface FlakyInput {
  readonly store: ObjectStore;
  readonly facts: FactWriter | undefined;
  readonly repository: RepositoryData;
  /** The task whose check passed the tests on rerun. */
  readonly taskId: string;
  readonly names: readonly string[];
  /** The check log, which still holds the first run's output. */
  readonly log: string | undefined;
  /** `check.flakyTask`; 0 turns the proposal off. */
  readonly threshold: number;
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
export async function trackFlakyTests(input: FlakyInput): Promise<void> {
  if (input.threshold <= 0 || input.names.length === 0) return;
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
      // While its task is open the count does not grow: the fix is on its way.
      if (record.task !== undefined) continue;
      const found = failureExcerpt(log, name);
      record = {
        ...record,
        occurrences: [
          ...record.occurrences,
          { task: input.taskId, at, file: found.file, excerpt: found.excerpt },
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
      await propose(input, fresh, object.id, record);
    }
  });
}

async function propose(
  input: FlakyInput,
  repository: RepositoryData,
  key: string,
  record: FlakyRecord,
): Promise<void> {
  const { store } = input;
  const existing = await namingTask(store, repository.name, record.name);
  if (existing !== undefined) return;
  const plan = await newestOpenPlan(store, repository.name);
  if (plan === undefined) {
    // One notice per count is enough; the count stays and decides again later.
    const count = record.occurrences.length;
    if (record.noticed !== undefined && record.noticed >= count) return;
    await store.put(FLAKY_TYPE, key, writableOf({ ...record, noticed: count }), "dev:flaky-task");
    await input.facts?.append({
      type: "dev/flaky_task_skipped",
      cause: "dev:flaky-task",
      data: {
        repository: repository.name,
        test: record.name,
        count: record.occurrences.length,
        reason: "no confirmed plan that is not finished",
      },
    });
    return;
  }
  await flakyTestHooks.beforePropose?.(record.name);
  const file = [...record.occurrences].reverse().find((entry) => entry.file !== undefined)?.file;
  try {
    const task = await addTaskLocked(
      store,
      {
        plan: plan.id,
        slug: slugOf(record.name),
        title: `Fix the flaky test: ${record.name.slice(0, MAX_TITLE_NAME)}`,
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
  } catch (error) {
    await input.facts?.append({
      type: "dev/flaky_task_skipped",
      cause: "dev:flaky-task",
      data: {
        repository: repository.name,
        test: record.name,
        count: record.occurrences.length,
        reason: messageOf(error),
      },
    });
  }
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
    readonly facts: FactWriter;
    readonly logger: { write(text: string): Promise<string> | string };
  };
  readonly repository: RepositoryData;
  readonly taskId: string;
  readonly threshold: number;
  readonly check: {
    readonly passedOnRerun: readonly string[];
    readonly outcome: { readonly data?: Record<string, unknown> | undefined } | undefined;
  };
}

/** Counts the passes on rerun of a finished check; a failure here never fails the check. */
export async function reportFlakyTests(report: FlakyReport): Promise<void> {
  const log = report.check.outcome?.data?.log;
  try {
    await trackFlakyTests({
      store: report.ctx.store,
      facts: report.ctx.facts,
      repository: report.repository,
      taskId: report.taskId,
      names: report.check.passedOnRerun,
      log: typeof log === "string" ? log : undefined,
      threshold: report.threshold,
    });
  } catch (error) {
    await report.ctx.logger.write(`could not propose a task for a flaky test: ${messageOf(error)}`);
  }
}
