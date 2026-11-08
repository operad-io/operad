/** How a plan and a task appear in a list and a detail page. */

import type {
  ObjectRow,
  ObjectViews,
  StoredObject,
  ViewContext,
  ViewSection,
} from "@operad-io/engine";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  bareId,
  hasRework,
  listAll,
  planData,
  planNote,
  planState,
  repositoryData,
  splitBrief,
  taskData,
  type TaskAttempt,
  type TaskData,
} from "./model.ts";
import { planMark, taskBadge, taskMark } from "./marks.ts";
import { git, workBranch } from "./steps.ts";
import { findRepository, listRepositories } from "./service.ts";
import { readDevSettings } from "./settings.ts";

function costNote(cost: unknown, quality?: unknown): string | undefined {
  if (typeof cost === "number" && Number.isFinite(cost)) {
    // An estimated or incomplete cost says so; an exact one is just the amount.
    const label = quality === "estimated" || quality === "incomplete" ? ` (${quality})` : "";
    return `$${cost.toFixed(2)}${label}`;
  }
  if (typeof cost === "string" && cost.trim().length > 0) return cost.trim();
  return undefined;
}

/**
 * The short note a waiting task shows. A refused push leaves the integration
 * message that names the remote, the branch and git's own words; the person
 * sees it next to the task before deciding what to do.
 */
function waitNote(task: TaskData): string | undefined {
  if (task.phase !== "waiting") return undefined;
  const integration = task.attempt?.integration;
  if (integration === undefined || integration === null) return undefined;
  if (integration.result !== "failed") return undefined;
  const message = integration.message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : undefined;
}

/** The longest worker name a list row shows; the full name is in Metrics. */
export const ROW_WORKER_CHARS = 16;

/** The last attempt's worker for a row: the name only, cut when it is long. */
function workerNote(task: TaskData): string | undefined {
  const worker = task.attempt?.worker;
  if (typeof worker !== "string") return undefined;
  const flat = worker.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length <= ROW_WORKER_CHARS
    ? flat
    : `${flat.slice(0, ROW_WORKER_CHARS - 1)}…`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tasksTable(
  tasks: readonly StoredObject[],
): string {
  if (tasks.length === 0) return "_No tasks._";
  const lines = [
    "| id | title | phase | after |",
    "| --- | --- | --- | --- |",
  ];
  for (const object of tasks) {
    const data = taskData(object.data);
    const after = data.after.length === 0 ? "-" : data.after.join(", ");
    lines.push(
      `| ${cell(bareId(object.id))} | ${cell(data.title)} | ${cell(data.phase)} | ${cell(after)} |`,
    );
  }
  return lines.join("\n");
}

/** A list names each row's repository once more than one is registered. */
async function showRepository(ctx: ViewContext): Promise<boolean> {
  return (await listRepositories(ctx.store)).length > 1;
}

export const planViews: ObjectViews = {
  row(object: StoredObject): ObjectRow {
    const plan = planData(object.data);
    return {
      id: bareId(object.id),
      title: plan.title,
      state: planState(plan),
      note: `${planNote(plan)}  auto: ${plan.auto}  ${plan.priority}  concurrency: ${plan.concurrency}`,
      scope: plan.repository,
      mark: planMark(plan),
    };
  },

  showScope: showRepository,

  sections(): readonly ViewSection[] {
    return [
      { id: "request", title: "Request" },
      { id: "tasks", title: "Tasks" },
    ];
  },

  async load(ctx, object, sectionId) {
    const plan = planData(object.data);
    if (sectionId === "request") {
      return { markdown: plan.request };
    }
    if (sectionId === "tasks") {
      const tasks = (await listAll(ctx.store, "task"))
        .filter((candidate) => {
          const task = taskData(candidate.data);
          return (
            task.repository === plan.repository &&
            task.plan === bareId(object.id)
          );
        })
        .sort((left, right) =>
          bareId(left.id).localeCompare(bareId(right.id)),
        );
      return { markdown: tasksTable(tasks) };
    }
    return { markdown: "" };
  },
};

export const taskViews: ObjectViews = {
  row(object: StoredObject): ObjectRow {
    const task = taskData(object.data);
    const areaNote =
      task.phase === "ready" && task.areaHeldBy !== undefined
        ? `waiting for area ${task.area ?? ""} (${task.areaHeldBy})`
        : task.area === undefined
          ? undefined
          : `area: ${task.area}`;
    const note =
      [
        waitNote(task) ?? costNote(task.cost, task.costQuality),
        workerNote(task),
        areaNote,
      ]
        .filter((part): part is string => part !== undefined)
        .join("  ") || undefined;
    return {
      id: bareId(object.id),
      title: task.title,
      state: task.phase,
      ...(note === undefined ? {} : { note }),
      scope: task.repository,
      mark: taskMark(task),
      badge: taskBadge(task),
    };
  },

  showScope: showRepository,

  sections(object: StoredObject): readonly ViewSection[] {
    const task = taskData(object.data);
    const sections: ViewSection[] = [{ id: "brief", title: "Brief" }];
    if (hasRework(task.brief)) {
      sections.push({ id: "rework", title: "Rework" });
    }
    sections.push({ id: "changes", title: "Changes" });
    sections.push({ id: "log", title: "Log", live: true });
    sections.push({ id: "diff", title: "Diff" });
    sections.push({ id: "metrics", title: "Metrics" });
    return sections;
  },

  async load(ctx, object, sectionId, options) {
    const task = taskData(object.data);
    const parts = splitBrief(task.brief);
    if (sectionId === "brief") {
      return {
        markdown:
          task.area === undefined
            ? parts.body
            : `Area: ${task.area}\n\n${parts.body}`,
      };
    }
    if (sectionId === "rework") return { markdown: parts.reworks };
    if (sectionId === "changes") return { markdown: parts.changes };
    if (sectionId === "log") return { markdown: await workerLog(ctx, task) };
    if (sectionId === "diff") return diffSection(ctx, object, options.cursor);
    if (sectionId === "metrics") return { markdown: metrics(ctx, object) };
    return { markdown: "" };
  },
};

/* ---------------------------------------------------------------------------
 * Log: the tail of the current attempt's worker log, as readable lines.
 * ------------------------------------------------------------------------- */

const LOG_TAIL_BYTES = 256 * 1024;
const LOG_TAIL_LINES = 80;
const LOG_LINE_CHARS = 240;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= LOG_LINE_CHARS
    ? flat
    : `${flat.slice(0, LOG_LINE_CHARS - 1)}…`;
}

function stringField(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** One worker log line as a sentence, or undefined for bookkeeping. */
export function readableLogLine(line: string): string | undefined {
  const text = line.trim();
  if (text.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return oneLine(text);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return oneLine(text);
  }
  const record = value as Record<string, unknown>;
  const kind = stringField(record, ["type"]) ?? "";
  const tool = stringField(record, ["tool", "tool_name", "toolName", "name"]);
  const event = stringField(record, ["event"]) ?? "";
  if (tool !== undefined) {
    const input = record.input ?? record.args ?? record.arguments;
    const shown =
      input === undefined
        ? ""
        : ` ${oneLine(typeof input === "string" ? input : JSON.stringify(input))}`;
    return oneLine(`tool ${tool}${shown}`);
  }
  if (kind === "journal") {
    return /tool/i.test(event) ? oneLine(`tool: ${event}`) : undefined;
  }
  const said = stringField(record, ["text", "message", "content"]);
  if (said !== undefined) {
    return oneLine(`${kind === "Result" ? "result" : "assistant"}: ${said}`);
  }
  return undefined;
}

function segment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length === 0 || cleaned === "." || cleaned === ".."
    ? "_"
    : cleaned;
}

async function workerLogPath(
  ctx: ViewContext,
  task: TaskData,
): Promise<string | undefined> {
  const attempt = task.attempt;
  if (attempt === undefined) return undefined;
  if (typeof attempt.workLog === "string" && attempt.workLog.length > 0) {
    return attempt.workLog;
  }
  // While the worker runs its log is not recorded yet; it is where the
  // harness's logger puts it for this run.
  if (typeof attempt.run !== "string" || attempt.run.length === 0) {
    return undefined;
  }
  const found = await findRepository(ctx.store, task.repository);
  if (found === undefined) return undefined;
  const settings = await readDevSettings(repositoryData(found.data).path);
  const ran = settings.workers.workers.find((worker) => worker.name === attempt.worker);
  const [plugin, step] = (ran?.use ?? settings.worker.use).split("/");
  if (plugin === undefined || step === undefined) return undefined;
  return join(
    ctx.store.root,
    "logs",
    segment(plugin),
    "runs",
    segment(attempt.run),
    `${segment(step)}.log`,
  );
}

async function workerLog(ctx: ViewContext, task: TaskData): Promise<string> {
  const path = await workerLogPath(ctx, task);
  if (path === undefined || !existsSync(path)) return "_No worker log yet._";
  const size = statSync(path).size;
  const bytes = readFileSync(path);
  const tail = bytes.subarray(Math.max(0, size - LOG_TAIL_BYTES));
  const lines = tail
    .toString("utf8")
    .split("\n")
    .map(readableLogLine)
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) return "_The worker has written nothing readable yet._";
  return lines.slice(-LOG_TAIL_LINES).join("\n\n");
}

/* ---------------------------------------------------------------------------
 * Diff: the task branch against main, one page per file when it is long.
 * ------------------------------------------------------------------------- */

/** A diff longer than this many characters is paged by file. */
export const DIFF_PAGE_CHARS = 60_000;

function fence(diff: string): string {
  return `\`\`\`\`diff\n${diff.trimEnd()}\n\`\`\`\``;
}

async function diffSection(
  ctx: ViewContext,
  object: StoredObject,
  cursor: string | undefined,
): Promise<{ readonly markdown: string; readonly next?: string }> {
  const task = taskData(object.data);
  const found = await findRepository(ctx.store, task.repository);
  if (found === undefined) return { markdown: "_The repository is not registered._" };
  const repository = repositoryData(found.data);
  const settings = await readDevSettings(repository.path);
  const branch = task.attempt?.branch ?? workBranch(bareId(object.id));
  const main = `${settings.remote}/${settings.mainBranch}`;
  const range = `${main}...${branch}`;
  const stat = git(repository.path, ["diff", "--stat", range], true);
  if (!stat.ok) {
    return { markdown: `_No diff: ${stat.err || `cannot compare ${branch} with ${main}`}._` };
  }
  if (stat.out.length === 0) {
    return { markdown: `_${branch} has no changes against ${main}._` };
  }
  const whole = git(repository.path, ["diff", range]);
  if (whole.out.length <= DIFF_PAGE_CHARS && cursor === undefined) {
    return { markdown: `${fence(stat.out)}\n\n${fence(whole.out)}` };
  }
  const names = git(repository.path, ["diff", "--name-only", range]).out
    .split("\n")
    .filter((name) => name.length > 0);
  const index = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(index) || index < 0 || index > names.length) {
    return { markdown: "_That page of the diff does not exist._" };
  }
  if (index === 0) {
    return {
      markdown: `${fence(stat.out)}\n\nThe diff is long: one page per file.\n\n${names
        .map((name, at) => `${at + 1}. \`${name}\``)
        .join("\n")}`,
      next: "1",
    };
  }
  const name = names[index - 1];
  if (name === undefined) return { markdown: "" };
  const file = git(repository.path, ["diff", range, "--", name]);
  return {
    markdown: `### ${name}\n\n${fence(file.out)}`,
    ...(index < names.length ? { next: String(index + 1) } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * Metrics: one row per attempt.
 * ------------------------------------------------------------------------- */

const METRIC_STEPS = ["worktree", "work", "verify", "review", "integrate"] as const;

function seconds(ms: number): string {
  if (ms < 1000) return "<1s";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes === 0 ? `${total}s` : `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}

interface AttemptMetrics {
  readonly number: number;
  readonly spent: Map<string, number>;
  last: TaskAttempt | undefined;
}

/**
 * A table of the task's attempts. Each step's time is the time between its
 * record and the record before it, so it is the step's wall time as the
 * task saw it; the worker's own time replaces it when the harness reported it.
 */
function metrics(ctx: ViewContext, object: StoredObject): string {
  const byAttempt = new Map<number, AttemptMetrics>();
  let previous: number | undefined;
  let cursor: string | undefined;
  for (;;) {
    const page = ctx.store.facts(
      { type: object.type, id: object.id },
      cursor === undefined ? {} : { cursor },
    );
    for (const fact of page.facts) {
      if (fact.type !== "task") continue;
      const data = taskData(fact.data);
      const attempt = data.attempt;
      const step = /^dev:(\w+)$/.exec(fact.cause)?.[1];
      if (
        attempt !== undefined &&
        step !== undefined &&
        (METRIC_STEPS as readonly string[]).includes(step)
      ) {
        let entry = byAttempt.get(attempt.number);
        if (entry === undefined) {
          entry = { number: attempt.number, spent: new Map(), last: undefined };
          byAttempt.set(attempt.number, entry);
        }
        const measured =
          step === "work" && typeof attempt.workMs === "number"
            ? attempt.workMs
            : previous === undefined
              ? 0
              : Math.max(0, fact.at - previous);
        entry.spent.set(step, (entry.spent.get(step) ?? 0) + measured);
        entry.last = attempt;
      } else if (attempt !== undefined) {
        const entry = byAttempt.get(attempt.number);
        if (entry !== undefined) entry.last = attempt;
      }
      previous = fact.at;
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  if (byAttempt.size === 0) return "_No attempts yet._";
  const entries = [...byAttempt.values()].sort(
    (left, right) => left.number - right.number,
  );
  const lines = [
    `| attempt | ${METRIC_STEPS.join(" | ")} | cost | tokens | review |`,
    `| --- | ${METRIC_STEPS.map(() => "---").join(" | ")} | --- | --- | --- |`,
  ];
  for (const entry of entries) {
    const last = entry.last;
    const cost = costNote(last?.cost, last?.costQuality) ?? "-";
    const tokens =
      last?.tokens === undefined || last.tokens === null
        ? "-"
        : `${last.tokens.input} in / ${last.tokens.output} out`;
    const review = last?.review?.result ?? "-";
    const times = METRIC_STEPS.map((step) => {
      const spent = entry.spent.get(step);
      return spent === undefined ? "-" : seconds(spent);
    });
    lines.push(
      `| ${entry.number} | ${times.join(" | ")} | ${cost} | ${tokens} | ${review} |`,
    );
  }
  const perWorker = workerTable(entries);
  return perWorker === undefined ? lines.join("\n") : `${lines.join("\n")}\n\n${perWorker}`;
}

/**
 * Cost, time and first-pass result per worker, summed over the attempts. An
 * attempt from before pools has no worker and is left out; no table when none
 * has one. First pass: the attempt's first review round passed.
 */
function workerTable(entries: readonly AttemptMetrics[]): string | undefined {
  const rows = new Map<
    string,
    { attempts: number; cost: number; costed: boolean; ms: number; reviewed: number; first: number }
  >();
  for (const entry of entries) {
    const worker = entry.last?.worker;
    if (typeof worker !== "string" || worker.length === 0) continue;
    const row = rows.get(worker) ?? {
      attempts: 0, cost: 0, costed: false, ms: 0, reviewed: 0, first: 0,
    };
    row.attempts += 1;
    const cost = entry.last?.cost;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      row.cost += cost;
      row.costed = true;
    }
    for (const spent of entry.spent.values()) row.ms += spent;
    const review = entry.last?.review;
    if (review !== undefined && review !== null) {
      row.reviewed += 1;
      if ((review.result === "passed" || review.result === "pass") && (review.round ?? 1) <= 1) row.first += 1;
    }
    rows.set(worker, row);
  }
  if (rows.size === 0) return undefined;
  const lines = [
    "| worker | attempts | cost | time | first pass |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [worker, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const cost = row.costed ? `$${row.cost.toFixed(2)}` : "-";
    const first = row.reviewed === 0 ? "-" : `${row.first}/${row.reviewed}`;
    lines.push(
      `| ${cell(worker)} | ${row.attempts} | ${cost} | ${seconds(row.ms)} | ${first} |`,
    );
  }
  return lines.join("\n");
}
