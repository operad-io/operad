/**
 * A repository's Metrics: what merged in the last 24 hours and the last 7
 * days, and where the time of those tasks went. Everything is computed when
 * the section is opened, from dev's own facts: each task's facts say when it
 * merged, what it cost and why it stopped; each run's facts say how long its
 * steps and its waits for a person took. Nothing comes from git.
 */

import {
  foldObjectFacts,
  type PluginFact,
  type StoredObject,
  type ViewContext,
} from "@operad-io/engine";
import {
  listAll,
  repositoryData,
  taskData,
  type TaskAttempt,
  type TaskData,
} from "./model.ts";
import { classifyStop, STOP_REASONS } from "./stops.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The steps of the time table, in the order the work takes them. */
const STEP_ROWS = [
  "work",
  "verify",
  "review",
  "wait for a person",
  "waiting to integrate",
  "integrate",
] as const;
type StepRow = (typeof STEP_ROWS)[number];

/** How many runs are read at once. */
const BATCH = 16;
/** How many reasons the table names. */
const TOP_REASONS = 5;

/** What one merged task contributes. */
interface MergedTask {
  readonly mergedAt: number;
  readonly cost: number | undefined;
  readonly reworks: number;
  readonly runs: readonly string[];
  /** The time it waited for a turn to integrate, from its own facts. */
  readonly integrateWaitMs: number;
  /** Why it stopped for a person, each reason once; empty when it never did. */
  readonly reasons: readonly string[];
}

/** The nearest-rank percentile of the values; they are sorted here. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function hourLabel(start: number): string {
  const d = new Date(start);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function dayLabel(start: number): string {
  const d = new Date(start);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/** The reason a task stopped for a person, from the step and the attempt it recorded. */
function stopReason(step: string, attempt: TaskAttempt | undefined): string {
  const result = attempt?.result;
  if (step === "verify") {
    return attempt?.verify?.result === "fail" ? "verify failed" : "verify";
  }
  if (step === "review") {
    const review = attempt?.review;
    if (review === undefined || review === null) return "review";
    if (review.result === "findings" || review.result === "fail") return "review: findings";
    return `review ${review.result.replace("_", " ")}`;
  }
  if (step === "integrate") {
    const integration = attempt?.integration?.result;
    if (integration === "conflict") return "conflict";
    if (integration === "fail" || integration === "failed") return "integrate failed";
    return "integrate";
  }
  if (
    (step === "worktree" || step === "reverify" || step === "work") &&
    (result === "failed" || result === "blocked" || result === "nothing")
  ) {
    return `${step} ${result}`;
  }
  return step === "" ? "stopped" : step.replaceAll("_", " ");
}

/**
 * Why a task stopped for a person: the cause dev recorded for a spent retry or
 * a stopped run when it did, else what the step and its attempt say.
 */
function reasonOf(data: TaskData, cause: string): string {
  const retry = data.retry;
  if (retry !== undefined && retry !== null && retry.state === "asked" && retry.cause.length > 0) {
    return retry.cause;
  }
  const stop = data.stop;
  if (stop !== undefined && stop !== null) {
    if (stop.reason === STOP_REASONS.runEnded) return "run stopped";
    const verdict = classifyStop({
      step: stop.step,
      result: stop.result,
      reason: stop.reason,
      use: stop.use,
    });
    if (verdict.cause !== undefined) return verdict.cause;
  }
  const step = /^dev:(\w+)$/.exec(cause)?.[1] ?? "";
  return stopReason(step, data.attempt);
}

/** Reads one merged task's facts; undefined when it did not merge in the window. */
async function readTask(
  ctx: ViewContext,
  object: StoredObject,
  since: number,
): Promise<MergedTask | undefined> {
  let mergedAt: number | undefined;
  let previous = "";
  let maxAttempt = 0;
  let waitFrom: number | undefined;
  let integrateWaitMs = 0;
  const runs: string[] = [];
  // Each attempt's cost, the latest recorded for it: a rework is paid for too.
  const attemptCosts = new Map<number, number>();
  const reasons = new Set<string>();
  const facts: PluginFact[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await ctx.store.facts(
      { type: object.type, id: object.id },
      cursor === undefined ? {} : { cursor },
    );
    facts.push(...page.facts);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  for (const version of foldObjectFacts(facts)) {
    const data = taskData(version.data);
    const attempt = data.attempt;
    if (data.phase === "merged" && mergedAt === undefined) mergedAt = version.fact.at;
    if (data.phase === "waiting" && previous !== "waiting") {
      reasons.add(reasonOf(data, version.fact.cause));
    }
    previous = data.phase;
    if (attempt !== undefined) {
      maxAttempt = Math.max(maxAttempt, attempt.number);
      if (typeof attempt.cost === "number" && Number.isFinite(attempt.cost)) {
        attemptCosts.set(attempt.number, attempt.cost);
      }
      if (typeof attempt.run === "string" && !runs.includes(attempt.run)) runs.push(attempt.run);
      const waiting = typeof attempt.integrationWait === "string" && attempt.integrationWait.length > 0;
      if (waiting && waitFrom === undefined) waitFrom = version.fact.at;
      if (!waiting && waitFrom !== undefined) {
        integrateWaitMs += Math.max(0, version.fact.at - waitFrom);
        waitFrom = undefined;
      }
    }
  }
  if (mergedAt === undefined || mergedAt < since) return undefined;
  const own = taskData(object.data).cost;
  const total = [...attemptCosts.values()].reduce((sum, cost) => sum + cost, 0);
  return {
    mergedAt,
    cost:
      attemptCosts.size > 0
        ? total
        : typeof own === "number" && Number.isFinite(own)
          ? own
          : undefined,
    reworks: Math.max(0, maxAttempt - 1),
    runs,
    integrateWaitMs,
    reasons: [...reasons],
  };
}

/** One task's time in each step, from its runs; undefined when no run could be read. */
async function stepTimes(
  ctx: ViewContext,
  task: MergedTask,
): Promise<Record<StepRow, number> | undefined> {
  if (ctx.runTimes === undefined) return undefined;
  const times: Record<StepRow, number> = {
    work: 0,
    verify: 0,
    review: 0,
    "wait for a person": 0,
    "waiting to integrate": 0,
    integrate: 0,
  };
  let read = false;
  for (const runId of task.runs) {
    const run = await ctx.runTimes(runId);
    if (run === undefined) continue;
    read = true;
    for (const segment of run.segments) {
      const spent = Math.max(0, (segment.to ?? task.mergedAt) - segment.from);
      if (segment.person) times["wait for a person"] += spent;
      else if (segment.step === "work") times.work += spent;
      else if (segment.step === "verify" || segment.step === "reverify") times.verify += spent;
      else if (segment.step === "review") times.review += spent;
      else if (segment.step === "integrate") times.integrate += spent;
    }
  }
  if (!read) return undefined;
  // The turn in the queue is part of the integrate step's stretch; it has its own row.
  const queued = Math.min(task.integrateWaitMs, times.integrate);
  times["waiting to integrate"] = queued;
  times.integrate -= queued;
  return times;
}

function perMerge(tasks: readonly MergedTask[]): string {
  const costs = tasks.flatMap((task) => (task.cost === undefined ? [] : [task.cost]));
  if (costs.length === 0) return "-";
  return `$${(costs.reduce((sum, cost) => sum + cost, 0) / costs.length).toFixed(2)}`;
}

function countTable(
  label: string,
  starts: readonly number[],
  size: number,
  name: (start: number) => string,
  tasks: readonly MergedTask[],
  /** True for a bucket that includes its end and not its start. */
  endClosed: boolean = false,
): string {
  const rows = starts.map((start) => {
    const inside = tasks.filter((task) =>
      endClosed
        ? task.mergedAt > start && task.mergedAt <= start + size
        : task.mergedAt >= start && task.mergedAt < start + size,
    );
    return [name(start), String(inside.length), perMerge(inside)];
  });
  return table([label, "merged", "cost per merge"], rows);
}

/**
 * The repository's Metrics at `now`. Hour rows are the 24 hours ending at
 * `now`; day rows are UTC calendar days, the last one the day `now` is in.
 */
export async function repositoryMetrics(
  ctx: ViewContext,
  repository: StoredObject,
  now: number = Date.now(),
): Promise<string> {
  const name = repositoryData(repository.data).name;
  const dayStart = Math.floor(now / DAY) * DAY;
  const since = dayStart - 6 * DAY;
  const tasks = (await listAll(ctx.store, "task")).filter((object) => {
    const data = taskData(object.data);
    // A merged task was last written at or after its merge.
    return data.repository === name && data.phase === "merged" && object.at >= since;
  });
  const merged: MergedTask[] = [];
  for (let index = 0; index < tasks.length; index += BATCH) {
    const read = await Promise.all(
      tasks.slice(index, index + BATCH).map((object) => readTask(ctx, object, since)),
    );
    for (const task of read) if (task !== undefined && task.mergedAt <= now) merged.push(task);
  }
  if (merged.length === 0) return "_No merged tasks in the last 7 days._";

  // Rolling hours, each (start, start + 1h]: the rows add up to the (now - 24h, now] summary.
  const hours = Array.from({ length: 24 }, (_, i) => now - (24 - i) * HOUR);
  const days = Array.from({ length: 7 }, (_, i) => dayStart - (6 - i) * DAY);
  const lastDay = merged.filter((task) => task.mergedAt > now - 24 * HOUR && task.mergedAt <= now);

  const timed: Record<StepRow, number>[] = [];
  for (let index = 0; index < merged.length; index += BATCH) {
    const read = await Promise.all(
      merged.slice(index, index + BATCH).map((task) => stepTimes(ctx, task)),
    );
    for (const times of read) if (times !== undefined) timed.push(times);
  }
  const stepRows = STEP_ROWS.map((step) => {
    const values = timed.map((times) => times[step]);
    return [step, duration(percentile(values, 50)), duration(percentile(values, 90))];
  });
  const reworks = merged.map((task) => task.reworks);
  const rounds = (value: number): string => String(value);
  const stopped = merged.filter((task) => task.reasons.length > 0);
  const counts = new Map<string, number>();
  for (const task of stopped) for (const reason of task.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const top = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_REASONS);
  const share = `${Math.round((stopped.length / merged.length) * 100)}%`;

  const sections = [
    `**Last 24 hours** ${lastDay.length} merged · ${perMerge(lastDay)} per merge`,
    countTable("hour (UTC)", hours, HOUR, hourLabel, merged, true),
    `**Last 7 days** ${merged.length} merged · ${perMerge(merged)} per merge`,
    countTable("day (UTC)", days, DAY, dayLabel, merged),
    `**Time per step** ${merged.length} tasks merged in the last 7 days`,
    table(["step", "median", "90th percentile"], [
      ...stepRows,
      ["rework rounds", rounds(percentile(reworks, 50)), rounds(percentile(reworks, 90))],
    ]),
    `**Stopped for a person** ${stopped.length} of ${merged.length} tasks (${share})`,
    top.length === 0
      ? "_No task stopped for a person._"
      : table(["reason", "tasks"], top.map(([reason, count]) => [reason.replace(/\|/g, "\\|"), String(count)])),
  ];
  if (timed.length < merged.length) {
    sections.splice(
      6,
      0,
      `_Times are from ${timed.length} of ${merged.length} tasks; the others have no run on record._`,
    );
  }
  return sections.join("\n\n");
}
