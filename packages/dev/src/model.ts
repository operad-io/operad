/** The objects the dev plugin owns, and the pure rules that change them. */

import type { ObjectStore, StoredObject } from "@operad-io/engine";
import type { ReviewHistoryEntry, ReviewSettingsUsed } from "./rework.ts";

/**
 * Every object of a type, following the store's pages. The store returns one
 * page at a time; an id scan must not stop at its default limit.
 */
export async function listAll(
  store: ObjectStore,
  type: string,
): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list(type, cursor === undefined ? {} : { cursor });
    objects.push(...page.objects);
    if (page.next === undefined) return objects;
    cursor = page.next;
  }
}

/** A plan is a request the owner confirmed into work. */
export type PlanStatus = "draft" | "confirmed" | "paused" | "cancelled";

/** Every state a plan row shows: its status, or `finished` once its tasks ended. */
export const PLAN_STATES = ["draft", "confirmed", "paused", "finished", "cancelled"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

/** How far a plan may run without a person. */
export type AutoMode = "off" | "run" | "merge";

/** The five priorities, most urgent first. */
export const PRIORITIES = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Every phase a task can be in, in the order it usually passes through them. */
export const TASK_PHASES = [
  "proposed",
  "ready",
  "running",
  "review",
  "waiting",
  "paused",
  "merged",
  "cancelled",
] as const;

/** Where a task is. */
export type TaskPhase = (typeof TASK_PHASES)[number];

/**
 * The list filters of plans and tasks. The declaration and the tests read
 * these; no state name is copied anywhere else.
 */
/** The task phases that end a task; a view row marks them `final`. */
export const TASK_FINAL_STATES: readonly string[] = ["merged", "cancelled"];

/** The plan states that end a plan. */
export const PLAN_FINAL_STATES: readonly string[] = ["finished", "cancelled"];

export const TASK_FILTERS = [
  {
    name: "active",
    default: true,
    states: TASK_PHASES.filter((phase) => phase !== "merged" && phase !== "cancelled"),
  },
  { name: "done", states: ["merged"] },
  { name: "cancelled", states: ["cancelled"] },
] as const;

export const PLAN_FILTERS = [
  {
    name: "active",
    default: true,
    states: PLAN_STATES.filter((state) => state !== "finished" && state !== "cancelled"),
  },
  { name: "done", states: ["finished"] },
  { name: "cancelled", states: ["cancelled"] },
] as const;

/** The repository states a row shows; a removed repository is hidden by default. */
export const REPO_FILTERS = [
  { name: "active", default: true, states: ["active"] },
  { name: "removed", states: ["removed"] },
] as const;

/** Micros and task counts of the costed tasks of a plan, per cost quality. */
export interface PlanCostTotals {
  readonly [key: string]: unknown;
  readonly exactMicros: number;
  readonly estimatedMicros: number;
  readonly incompleteMicros: number;
  readonly exactTasks: number;
  readonly estimatedTasks: number;
  readonly incompleteTasks: number;
}

/** The data of a plan object. Counts are a cache over its tasks. */
export type PlanData = {
  readonly [key: string]: unknown;
  readonly repository: string;
  readonly title: string;
  readonly request: string;
  readonly status: PlanStatus;
  readonly auto: AutoMode;
  readonly priority: Priority;
  readonly concurrency: number;
  readonly taskCount: number;
  readonly mergedCount: number;
  readonly cancelledCount: number;
  /**
   * The cost of the plan's tasks, kept per quality so the weakest is known
   * after a task's cost changes. Absent on a plan stored before it existed.
   */
  readonly costTotals?: PlanCostTotals | undefined;
  /** Tasks being worked or reviewed now; the scheduler keeps it current. */
  readonly activeCount?: number | undefined;
  /** True once the scheduler has reported that every task ended. */
  readonly finishedReported?: boolean | undefined;
  /** When the scheduler last started one of the plan's tasks (ms); the order within a priority reads it. */
  readonly lastStartedAt?: number | undefined;
};

/** What the verify step found when it ran the gate commands. */
export type VerifyResult = "pass" | "fail";

/** One run of a task's gate commands on a commit. */
export interface VerifyRecord {
  readonly [key: string]: unknown;
  readonly result: VerifyResult;
  readonly run?: string | null;
  /** The command that failed, when one did. */
  readonly command?: string | null;
  /** The file the failed command's output was written to. */
  readonly log?: string | null;
  readonly message?: string | null;
  readonly lineNumber?: number | null;
  /** The gate commands this verify ran, as they were when it ran. */
  readonly commands?: readonly string[];
}

/** A finding the reviewer reported. */
export interface ReviewFinding {
  readonly [key: string]: unknown;
  readonly file: string;
  readonly line: number;
  readonly severity: string;
  readonly summary: string;
  readonly trigger: string;
  /** True for a finding on a file the change did not touch. */
  readonly preExisting?: boolean;
  /** The same mark as `preExisting`, in the wording the gate reports. */
  readonly pre_existing?: boolean;
}

/**
 * The decision a review round records once. A round may use more than one
 * model run (a fallback, a retry), but it has one decision.
 */
export type ReviewDecision =
  | "passed"
  | "findings"
  | "unavailable"
  | "timed_out";

/** What the review step found. The old `pass`/`fail` records still read. */
export type ReviewResult =
  | "pass"
  | "fail"
  | "passed"
  | "findings"
  | "failed"
  | "unavailable"
  | "timed_out";

/** What one model run of a review round did. */
export type ReviewRunOutcome =
  | "report"
  | "invalid"
  | "no_report"
  | "unavailable"
  | "timed_out"
  | "failed";

/** Which settings a review run used. */
export type ReviewRunRole = "primary" | "fallback";

/** Why a review run happened. */
export type ReviewRunReason =
  | "initial"
  | "retry"
  | "fallback";

/** One model run inside a review round. */
export interface ReviewRunRecord {
  readonly [key: string]: unknown;
  /** The task attempt this run belongs to. */
  readonly attempt?: number | null;
  /** The review round this run belongs to. */
  readonly round: number;
  readonly role: ReviewRunRole;
  /** The harness step this run used. */
  readonly use: string;
  readonly args: readonly string[];
  /** The model the run named, or its harness step when it named none. */
  readonly model: string;
  readonly reason: ReviewRunReason;
  readonly outcome: ReviewRunOutcome;
  readonly run?: string | null;
  readonly message?: string | null;
  /** The findings a report run returned, with pre-existing marks. */
  readonly findings?: readonly ReviewFinding[] | null;
  readonly verified?: readonly string[] | null;
  /** The user-visible words this run found in the diff. */
  readonly words?: readonly string[];
  /** How many of the findings are at or above the fix level. */
  readonly counted?: number | null;
}

/**
 * A model run of a review round that was asked for but not recorded yet. It is
 * written before the reviewer is called, so a crash after the model answered
 * resumes that run instead of asking the same model again.
 */
export interface PendingReviewRun {
  readonly [key: string]: unknown;
  readonly attempt?: number | null;
  readonly round: number;
  readonly role: ReviewRunRole;
  readonly use: string;
  readonly args: readonly string[];
  readonly model: string;
  readonly reason: ReviewRunReason;
  readonly run?: string | null;
  /** The report path inside the gate worktree this call was given. */
  readonly report?: string | null;
}

/** One review of a task's verified commit: one decision for the round. */
export interface ReviewRecord {
  readonly [key: string]: unknown;
  readonly result: ReviewResult;
  readonly run?: string | null;
  /** The decision of the round; absent on a report that failed outright. */
  readonly decision?: ReviewDecision | null;
  /** The round number inside the attempt; the first round is 1. */
  readonly round?: number | null;
  /** The model that produced the decision. */
  readonly model?: string | null;
  /** Which round (first or rework) ran and which block each setting came from. */
  readonly reviewSettings?: ReviewSettingsUsed | null;
  /** When an unavailable round may run again, in epoch milliseconds. */
  readonly retryAt?: number | null;
  /** Every run of this round, in order. */
  readonly runs?: readonly ReviewRunRecord[] | null;
  readonly findings?: readonly ReviewFinding[];
  readonly verified?: readonly string[];
  readonly log?: string | null;
  readonly message?: string | null;
  readonly reason?: string | null;
  /** The commit the reviewer saw. */
  readonly sha?: string | null;
  /** The user-visible words the reviewer found in the diff. */
  readonly words?: readonly string[];
  /** The words of the worker and the reviewer that nobody approved; a passed review waits on them. */
  readonly newWords?: readonly string[];
}

/** What the integrate step found while landing the verified commit. */
export type IntegrationResult = "merged" | "conflict" | "fail" | "failed";

/** A record written before the push says the candidate is not landed yet. */
export type IntegrationPhase = IntegrationResult | "pending";

/** One attempt at landing a task's verified commit on main. */
export interface IntegrationRecord {
  readonly [key: string]: unknown;
  readonly run?: string | null;
  readonly result: IntegrationPhase;
  readonly style?: string | null;
  /** The verified commit the candidate was built from. */
  readonly verified?: string | null;
  /** The commit built on main, before or after the push. */
  readonly candidate?: string | null;
  /** The main commit the candidate was built on. */
  readonly base?: string | null;
  /** The branch head when the step ran, which may be past the verified sha. */
  readonly head?: string | null;
  /** True when the branch head was no longer the verified commit. */
  readonly headMoved?: boolean | null;
  readonly pushed?: boolean | null;
  readonly message?: string | null;
  readonly command?: string | null;
  readonly log?: string | null;
  readonly lineNumber?: number | null;
  readonly files?: readonly string[] | null;
}

/** One cleanup hook line that failed. */
export interface CleanupFailure {
  readonly [key: string]: unknown;
  readonly line: number;
  readonly text: string;
  readonly message: string;
}

/** What the cleanup step ran after a merge. */
export interface CleanupRecord {
  readonly [key: string]: unknown;
  readonly run?: string | null;
  readonly failures: readonly CleanupFailure[];
}

/** One rework section the step appended; a replay reads it and appends nothing. */
export interface ReworkRecord {
  readonly [key: string]: unknown;
  readonly run?: string | null;
  readonly source: string;
  readonly streak: number;
  /** The automatic rework limit in force when the record was written. */
  readonly limit?: number;
  readonly result: "again" | "ask";
  /** True when the wait is because review failed twice in a row. */
  readonly twice?: boolean;
}

/** One run of a task's worker, with what the worktree step learned. */
export type TaskAttempt = {
  readonly [key: string]: unknown;
  readonly number: number;
  readonly run?: string | null;
  readonly worktree?: string | null;
  readonly branch?: string | null;
  readonly base?: string | null;
  readonly sessionId?: string | null;
  /** The cost in dollars, when the harness reported one. */
  readonly cost?: number | null;
  /** The same cost in micros, as the harness reports it. */
  readonly costMicros?: number | null;
  /** How far to trust the cost: `exact`, `estimated` or `incomplete`. */
  readonly costQuality?: "exact" | "estimated" | "incomplete" | null;
  /** The worker the pool ran for this attempt's work (the fallback one when it fell back). */
  readonly worker?: string | null;
  /** The worker that failed over to `worker`, when the pool fell back. */
  readonly fallbackFrom?: string | null;
  /** The worker of the attempt before, which this attempt's work asks for again. */
  readonly previousWorker?: string | null;
  readonly previousSession?: string | null;
  /** The earlier worker that was no longer in the pool, when the work changed hands. */
  readonly workerChanged?: string | null;
  /** Whether the work step consumed this attempt; a later worktree visit is new work. */
  readonly worked?: boolean;
  /** The file the worker's own log was written to. */
  readonly workLog?: string | null;
  /** Tokens the worker used, when the harness reported them. */
  readonly tokens?: { readonly input: number; readonly output: number } | null;
  /** How long the worker ran, in milliseconds, as the harness measured it. */
  readonly workMs?: number | null;
  /** Why the work step did not finish cleanly, in the harness's words. */
  readonly workNote?: string | null;
  /** The words the worker's final answer named in its `New words:` line. */
  readonly workWords?: readonly string[] | null;
  /** How many times the work step waited for an unavailable model in this attempt. */
  readonly workWaits?: number | null;
  /** When a work step that found its model unavailable may run again (epoch ms). */
  readonly workRetryAt?: number | null;
  readonly result?: string | null;
  /** The branch head the gate verified; review reads this and not the branch. */
  readonly verified?: string | null;
  readonly verify?: VerifyRecord | null;
  readonly review?: ReviewRecord | null;
  /** Every model run of every review round in this attempt. */
  readonly reviewRuns?: readonly ReviewRunRecord[] | null;
  /** The run this review asked for and has not recorded yet. */
  readonly reviewPending?: PendingReviewRun | null;
  /** How many review rounds this attempt has finished. */
  readonly reviews?: number | null;
  /** The rework this run appended; a replay of the same run reads it. */
  readonly rework?: ReworkRecord | null;
  /** What the integrate step did on main. */
  readonly integration?: IntegrationRecord | null;
  /** The run whose integrate step is working now; null once it wrote its result. */
  readonly integrating?: string | null;
  /** While the integrate step waits for its turn: who is integrating. */
  readonly integrationWait?: string | null;
  /** What the cleanup step ran after the merge. */
  readonly cleanup?: CleanupRecord | null;
};

/**
 * The claim a scheduler start holds on a task until its run records itself.
 * The token lets a step prove that its run is the one that made the claim.
 */
export interface TaskClaim {
  readonly [key: string]: unknown;
  readonly token: string;
  /** The phase the claim wrote; the first step expects to find it there. */
  readonly phase: TaskPhase;
}

/** The data of a task object. */
/** Why a step just stopped, in dev's own words; the retry step reads it once. */
export interface StopRecord {
  readonly [key: string]: unknown;
  readonly step: string;
  readonly result: string;
  readonly reason: string;
  /** The step that was not loaded, when the reason says so. */
  readonly use?: string | undefined;
}

/** The one automatic retry a task's attempt used for a failure outside its work. */
export interface RetryRecord {
  readonly [key: string]: unknown;
  readonly attempt: number;
  readonly step: string;
  /** What was wrong, as the waiting line says it. */
  readonly cause: string;
  /** When the retry began, in epoch milliseconds. */
  readonly at: number;
  /** What the retry waits for before it runs; absent when it runs at once. */
  readonly waitFor?: "step" | "settings" | undefined;
  readonly use?: string | undefined;
  /** `ready`: the wait is over; `expired`: it ran out; `asked`: a person decides. */
  readonly state: "retrying" | "waiting" | "ready" | "expired" | "asked";
}

export type TaskData = {
  readonly [key: string]: unknown;
  readonly repository: string;
  readonly plan: string;
  readonly title: string;
  readonly brief: string;
  readonly after: readonly string[];
  /** Tasks with the same area in one repository never run at once. */
  readonly area?: string | undefined;
  /** The running task that holds this ready task's area; the scheduler sets it. */
  readonly areaHeldBy?: string | undefined;
  /** How many ready tasks of the same area are ahead in the queue; the scheduler sets it. */
  readonly areaAhead?: number | undefined;
  /** True while this task holds the repository's one slot kept for the plan that has gone longest without starting a task. */
  readonly oldestPlanSlot?: boolean | undefined;
  /** True while a task this ready task follows is not merged; the scheduler sets it. */
  readonly dependencyHeld?: boolean | undefined;
  readonly phase: TaskPhase;
  readonly attempts: number;
  readonly run: string | null;
  readonly attempt?: TaskAttempt | undefined;
  /** What each review reported, newest last; the next review follows it. */
  readonly reviewHistory?: readonly ReviewHistoryEntry[] | undefined;
  readonly cost?: number | string | undefined;
  /** How far to trust `cost`; absent for a cost written before it was recorded. */
  readonly costQuality?: "exact" | "estimated" | "incomplete" | null | undefined;
  /** How many automatic reworks ran in a row; a passing gate resets it. */
  readonly reworkStreak?: number | undefined;
  /**
   * The findings text of the last review failure when the attempt before the
   * current rework also ended in one; absent after anything else.
   */
  readonly reviewFailed?: string | undefined;
  /** Why the last step that records one stopped; the retry step consumes it. */
  readonly stop?: StopRecord | null | undefined;
  /** The automatic retry this task's attempt used. */
  readonly retry?: RetryRecord | null | undefined;
  /** The owner asked the scheduler to start this ready task. */
  readonly startRequested?: boolean | undefined;
  /** When an unavailable review may run again, in epoch milliseconds. */
  readonly retryAt?: number | null | undefined;
  /** What the scheduler claimed while it waits for the run to record itself. */
  readonly claim?: TaskClaim | null | undefined;
  /** The attempt whose review the scheduler already answered for auto merge. */
  readonly autoMergeAttempt?: number | undefined;
  /** The attempt whose integration result the scheduler already reported. */
  readonly mergeReportedAttempt?: number | undefined;
  /** The findings that did not fail each review round, oldest first. */
  readonly reviewNotes?: readonly ReviewNotes[] | undefined;
  /** Set when the task merged with notes to collect; absent on older merges. */
  readonly followups?: FollowupMark | undefined;
  /** The tasks a follow-up task collects; set only on a follow-up. */
  readonly followupOf?: readonly string[] | undefined;
};

/** A finding that did not fail its review round. */
export interface ReviewNote {
  readonly severity: string;
  readonly file: string;
  readonly line: number | null;
  readonly summary: string;
}

/** The notes of one review round. */
export interface ReviewNotes {
  readonly attempt: number;
  readonly round: number;
  readonly findings: readonly ReviewNote[];
}

/** A merged task whose notes the plan's follow-up has not collected yet. */
export interface FollowupMark {
  /** When the task merged, in epoch milliseconds; orders the follow-up's `after`. */
  readonly mergedAt: number;
  readonly state: "collect" | "collected";
}

/** A repository registered with the dev plugin. */
export type RepositoryData = {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly path: string;
  readonly removed: boolean;
  /** Plans and tasks not yet ended; a cache the repository's row reads. */
  readonly openPlans?: number | undefined;
  readonly openTasks?: number | undefined;
  /** Tasks with a run in progress (working or in review); a cache for the row's mark. */
  readonly activeTasks?: number | undefined;
};

/** The two kinds of object the dev plugin numbers. */
export type IdKind = "plan" | "task";

/** The slug part every id carries: 1-48 of a-z, 0-9 and -, no edge -. */
const SLUG_SOURCE = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/** `P-0001-slug`, or the older `PL0001-slug`, which existing objects keep. */
export const PLAN_ID = new RegExp(
  `^(?:PL(\\d{4})|P-(\\d{4}))-(${SLUG_SOURCE})$`,
);

/** `T-0001-slug`, or the older `TK0001-slug`, which existing objects keep. */
export const TASK_ID = new RegExp(
  `^(?:TK(\\d{4})|T-(\\d{4}))-(${SLUG_SOURCE})$`,
);

export type IdMatch = {
  readonly number: number;
  readonly slug: string;
};

/** A rule of the dev plugin was broken; the message starts with the field. */
export class DevError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "DevError";
    this.field = field;
  }
}

/**
 * An action cannot run, or a race made it stale. The message is the line a
 * person reads, as it is: no field name in front, no status.
 */
export class DevRefusal extends DevError {
  constructor(line: string) {
    super("", line);
    this.name = "DevRefusal";
    this.message = line;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a stored plan; the store already validated the object when it wrote it. */
export function planData(data: Record<string, unknown>): PlanData {
  return data as unknown as PlanData;
}

export function taskData(data: Record<string, unknown>): TaskData {
  return data as unknown as TaskData;
}

export function repositoryData(
  data: Record<string, unknown>,
): RepositoryData {
  return data as unknown as RepositoryData;
}

/** `1-48` characters of `a-z0-9-`, with no leading or trailing `-`. */
export function validateSlug(slug: unknown): string {
  if (typeof slug !== "string" || slug.length < 1 || slug.length > 48) {
    throw new DevError("slug", "must be 1-48 characters of a-z, 0-9 and -");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new DevError(
      "slug",
      "must use only a-z, 0-9 and -, with no leading or trailing -",
    );
  }
  return slug;
}

export function validateTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new DevError("title", "must be a non-empty string");
  }
  return title.trim();
}

/** An area is a short single-line label; the empty string means none. */
export function validateArea(area: unknown): string | undefined {
  if (typeof area !== "string") {
    throw new DevError("area", "must be a string");
  }
  const trimmed = area.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 64 || /[\r\n\u0000]/.test(trimmed)) {
    throw new DevError("area", "must be one short line of at most 64 characters");
  }
  return trimmed;
}

export function validateRepositoryName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new DevError("name", "must be a non-empty string");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\u0000")) {
    throw new DevError("name", 'must not contain "/", "\\" or a NUL');
  }
  return name.trim();
}

export function parseId(id: string, kind: IdKind): IdMatch | undefined {
  const pattern = kind === "plan" ? PLAN_ID : TASK_ID;
  const match = pattern.exec(id);
  if (match === null) return undefined;
  const number = Number(match[1] ?? match[2]);
  const slug = match[3] ?? "";
  return { number, slug };
}

/** A new id always uses the short form, whatever form the existing ids use. */
export function formatId(
  kind: IdKind,
  number: number,
  slug: string,
): string {
  if (!Number.isInteger(number) || number < 1 || number > 9999) {
    throw new DevError("id", `no ${kind} number is left`);
  }
  const prefix = kind === "plan" ? "P" : "T";
  return `${prefix}-${String(number).padStart(4, "0")}-${slug}`;
}

function numberById(
  objects: readonly { readonly id: string }[],
  kind: IdKind,
): number {
  let highest = 0;
  for (const object of objects) {
    // The store key carries the repository; the number lives in the bare id.
    const parsed = parseId(bareId(object.id), kind);
    if (parsed !== undefined && parsed.number > highest) {
      highest = parsed.number;
    }
  }
  return highest;
}

/**
 * The store key of a plan or task. Ids are unique within a repository only, so
 * the repository name namespaces the key and two repositories may both hold
 * `T-0001-work`.
 */
export function storeKey(repository: string, id: string): string {
  return `${repository}/${id}`;
}

/** The id a person sees and types: the key without its repository prefix. */
export function bareId(key: string): string {
  const at = key.indexOf("/");
  return at < 0 ? key : key.slice(at + 1);
}

/** The repository part of a store key. */
export function keyRepository(key: string): string {
  const at = key.indexOf("/");
  return at < 0 ? "" : key.slice(0, at);
}

/**
 * The next id for a repository. Numbers count up per repository and are never
 * reused; the scan reads only that repository's objects, because the store key
 * namespaces them.
 */
export async function nextId(
  store: ObjectStore,
  type: "plan" | "task",
  repository: string,
  slug: string,
): Promise<string> {
  const all = await listAll(store, type);
  const mine = all.filter(
    (object) =>
      isRecord(object.data) && object.data.repository === repository,
  );
  let number = numberById(mine, type) + 1;
  for (;;) {
    const id = formatId(type, number, slug);
    if ((await store.get(type, storeKey(repository, id))) === undefined) {
      return id;
    }
    number += 1;
  }
}

/* ---------------------------------------------------------------------------
 * The brief: a body, rework sections and a trailing changes section.
 * ------------------------------------------------------------------------- */

interface Fence {
  readonly char: "`" | "~";
  readonly length: number;
}

function openingFence(line: string): Fence | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (match === null) return undefined;
  const run = match[1] ?? "";
  const char = run[0];
  if (char !== "`" && char !== "~") return undefined;
  return { char, length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
  if (match === null) return false;
  const run = match[1] ?? "";
  return run[0] === fence.char && run.length >= fence.length;
}

interface BriefHeadings {
  readonly rework: number;
  readonly changes: number;
}

/** Finds the first rework and changes headings that are not inside a fence. */
export function briefHeadings(brief: string): BriefHeadings {
  const lines = brief.replace(/\r\n/g, "\n").split("\n");
  let fence: Fence | undefined;
  let rework = -1;
  let changes = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const opened = openingFence(line);
    if (opened !== undefined) {
      fence = opened;
      continue;
    }
    if (rework < 0 && /^##\s+Rework(?:\s|$)/.test(line)) rework = index;
    if (changes < 0 && /^##\s+Changes\s*$/.test(line)) changes = index;
  }
  return { rework, changes };
}

export interface BriefParts {
  readonly body: string;
  readonly reworks: string;
  readonly changes: string;
}

export function splitBrief(brief: string): BriefParts {
  const text = brief.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const { rework, changes } = briefHeadings(text);
  const boundaries = [rework, changes].filter((index) => index >= 0);
  const bodyEnd = boundaries.length === 0 ? lines.length : Math.min(...boundaries);
  const tailStart = bodyEnd;
  const body = lines.slice(0, bodyEnd).join("\n").trimEnd();
  const changesStart = changes;
  const reworksEnd =
    changesStart > tailStart ? changesStart : lines.length;
  const reworks =
    rework >= 0
      ? lines.slice(rework, reworksEnd).join("\n").trim()
      : "";
  const changeText =
    changes >= 0 ? lines.slice(changes).join("\n").trimEnd() : "";
  return { body, reworks, changes: changeText };
}

export function hasRework(brief: string): boolean {
  return briefHeadings(brief).rework >= 0;
}

function tailStartOf(brief: string): number {
  const { rework, changes } = briefHeadings(brief);
  const indexes = [rework, changes].filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

/**
 * Replaces the text before the first real `## Rework` (or, when there is none,
 * before the trailing `## Changes`). A heading inside a fenced block is text.
 */
export function replaceBriefBody(brief: string, body: string): string {
  const text = brief.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const start = tailStartOf(text);
  const tail = start < 0 ? "" : lines.slice(start).join("\n").trimEnd();
  const next = body.replace(/\r\n/g, "\n").trimEnd();
  if (tail.length === 0) return next;
  return next.length === 0 ? tail : `${next}\n\n${tail}`;
}

/** Inserts a block before the trailing changes section, or at the end. */
function insertBeforeChanges(brief: string, block: string): string {
  const text = brief.replace(/\r\n/g, "\n").trimEnd();
  const { changes } = briefHeadings(text);
  if (changes < 0) {
    if (text.length === 0) return block;
    return `${text}\n\n${block}`;
  }
  const lines = text.split("\n");
  const before = lines.slice(0, changes).join("\n").trimEnd();
  const after = lines.slice(changes).join("\n");
  if (before.length === 0) return `${block}\n\n${after}`;
  return `${before}\n\n${block}\n\n${after}`;
}

/** The clock a Changes entry's time comes from; a test replaces it. */
export const changeClock: { now: () => number } = { now: () => Date.now() };

const REASON_LIMIT = 160;

/** One line of at most about 160 characters: whitespace collapsed, cut with an ellipsis. */
export function oneLine(text: string, limit: number = REASON_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Appends one line to the trailing `## Changes` section, creating it. The
 * entry keeps the time it happened (UTC, ISO) and the reason when there is one.
 */
export function appendChange(
  brief: string,
  line: string,
  reason?: string,
): string {
  const text = brief.replace(/\r\n/g, "\n").trimEnd();
  const { changes } = briefHeadings(text);
  const why = reason === undefined ? "" : oneLine(reason);
  const said = oneLine(line, Number.MAX_SAFE_INTEGER);
  const at = new Date(changeClock.now()).toISOString();
  const entry = `- [${at}] ${said}${why.length === 0 ? "" : ` — ${why}`}`;
  if (changes < 0) {
    return text.length === 0
      ? `## Changes\n${entry}`
      : `${text}\n\n## Changes\n${entry}`;
  }
  return `${text}\n${entry}`;
}

const TIMED_ENTRY = /^- \[(\d{4}-\d{2}-\d{2}T[^\]]+Z)\] (.*)$/;

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The Changes section for a reader: each timed entry as `HH:MM  text` in this
 * host's local time, with a date line before the first entry of each day.
 * An entry without a time stays as it was written.
 */
export function renderChanges(changes: string): string {
  const out: string[] = [];
  let day = "";
  for (const line of changes.split("\n")) {
    if (/^##\s+Changes\s*$/.test(line)) continue;
    const match = TIMED_ENTRY.exec(line);
    const when = match === null ? new Date(Number.NaN) : new Date(match[1] ?? "");
    if (match === null || Number.isNaN(when.getTime())) {
      if (line.trim().length > 0) out.push(line);
      continue;
    }
    const date = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
    if (date !== day) {
      day = date;
      if (out.length > 0) out.push("");
      out.push(`**${date}**`, "");
    }
    out.push(`- ${two(when.getHours())}:${two(when.getMinutes())}  ${match[2] ?? ""}`);
  }
  return out.join("\n");
}

function reworkCount(brief: string): number {
  const lines = brief.replace(/\r\n/g, "\n").split("\n");
  let fence: Fence | undefined;
  let count = 0;
  for (const line of lines) {
    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const opened = openingFence(line);
    if (opened !== undefined) {
      fence = opened;
      continue;
    }
    if (/^##\s+Rework(?:\s|$)/.test(line)) count += 1;
  }
  return count;
}

/** The word a Changes entry uses for who asked, where it differs from the section's source. */
const ASKER: Readonly<Record<string, string>> = {
  "conflict with main": "conflict",
  integration: "integrate",
};

/** Appends `## Rework <n> (<source>)`, then records the change. */
export function appendRework(
  brief: string,
  source: string,
  text: string,
  reason?: string,
): string;
export function appendRework(
  task: TaskData,
  source: string,
  text: string,
  reason?: string,
): TaskData;
export function appendRework(
  value: string | TaskData,
  source: string,
  text: string,
  reason?: string,
): string | TaskData {
  const cleanSource = source.trim();
  if (cleanSource.length === 0) {
    throw new DevError("source", "must be a non-empty string");
  }
  const brief = typeof value === "string" ? value : value.brief;
  const number = reworkCount(brief) + 1;
  const body = text.trim();
  const block = `## Rework ${number} (${cleanSource})${body.length === 0 ? "" : `\n\n${body}`}`;
  const withRework = insertBeforeChanges(brief, block);
  const asked = ASKER[cleanSource] ?? cleanSource;
  const firstLine =
    body.split("\n").find((line) => line.trim().length > 0) ?? "";
  const why = oneLine(reason ?? firstLine.replace(/^\s*[-*]\s+/, ""));
  const next = appendChange(
    withRework,
    `rework ${number} — ${asked}${why.length === 0 ? "" : `: ${why}`}`,
  );
  return typeof value === "string" ? next : { ...value, brief: next };
}

/** The Markdown of the brief body, without rework or changes. */
export function briefBody(brief: string): string {
  return splitBrief(brief).body;
}

/** The Markdown of the rework sections, without the changes section. */
export function reworkBody(brief: string): string {
  return splitBrief(brief).reworks;
}

/** The Markdown of the trailing changes section. */
export function changesBody(brief: string): string {
  return splitBrief(brief).changes;
}

/** Replaces the body and records the edit, unless the body did not change. */
export function editBrief(brief: string, body: string): string {
  if (briefBody(brief) === body.replace(/\r\n/g, "\n").trimEnd()) return brief;
  return appendChange(replaceBriefBody(brief, body), "brief edited");
}

/* ---------------------------------------------------------------------------
 * States and dependencies.
 * ------------------------------------------------------------------------- */

/** The state a plan row shows: `finished` is derived from its tasks. */
export function planState(plan: PlanData): PlanState {
  if (plan.status === "cancelled") return "cancelled";
  if (
    plan.status === "confirmed" &&
    plan.taskCount > 0 &&
    plan.mergedCount + plan.cancelledCount === plan.taskCount
  ) {
    return "finished";
  }
  return plan.status;
}

/** What a task adds to a plan's cost: micros and quality, or none. */
export function taskCostShare(
  task: TaskData,
): { readonly micros: number; readonly quality: "exact" | "estimated" | "incomplete" } | undefined {
  if (typeof task.cost !== "number" || !Number.isFinite(task.cost)) return undefined;
  // A cost written before its quality was recorded counts as estimated.
  const quality =
    task.costQuality === "exact" || task.costQuality === "incomplete"
      ? task.costQuality
      : "estimated";
  return { micros: Math.round(task.cost * 1_000_000), quality };
}

/** The totals after a task's share changes from `before` to `after`. */
export function shiftCostTotals(
  totals: PlanCostTotals | undefined,
  before: TaskData | undefined,
  after: TaskData | undefined,
): PlanCostTotals {
  const next: Record<string, number> = {
    exactMicros: totals?.exactMicros ?? 0,
    estimatedMicros: totals?.estimatedMicros ?? 0,
    incompleteMicros: totals?.incompleteMicros ?? 0,
    exactTasks: totals?.exactTasks ?? 0,
    estimatedTasks: totals?.estimatedTasks ?? 0,
    incompleteTasks: totals?.incompleteTasks ?? 0,
  };
  const apply = (task: TaskData | undefined, sign: 1 | -1): void => {
    const share = task === undefined ? undefined : taskCostShare(task);
    if (share === undefined) return;
    next[`${share.quality}Micros`] = (next[`${share.quality}Micros`] ?? 0) + sign * share.micros;
    next[`${share.quality}Tasks`] = (next[`${share.quality}Tasks`] ?? 0) + sign;
  };
  apply(before, -1);
  apply(after, 1);
  return {
    exactMicros: next.exactMicros ?? 0,
    estimatedMicros: next.estimatedMicros ?? 0,
    incompleteMicros: next.incompleteMicros ?? 0,
    exactTasks: next.exactTasks ?? 0,
    estimatedTasks: next.estimatedTasks ?? 0,
    incompleteTasks: next.incompleteTasks ?? 0,
  };
}

/** The plan's total cost in `costNote` form, or undefined with no costed task. */
function planCost(plan: PlanData): string | undefined {
  const t = plan.costTotals;
  if (t === undefined) return undefined;
  const tasks = t.exactTasks + t.estimatedTasks + t.incompleteTasks;
  if (tasks <= 0) return undefined;
  const micros = t.exactMicros + t.estimatedMicros + t.incompleteMicros;
  const symbol = t.incompleteTasks > 0 ? "≥" : t.estimatedTasks > 0 ? "~" : "";
  return `${symbol}$${(micros / 1_000_000).toFixed(2)}`;
}

/** `<merged>/<total> · <cost> · <auto> · <priority> // <concurrency>`. */
export function planNote(plan: PlanData): string {
  // Cancelled tasks are not part of the total the owner is working through.
  const progress = `${plan.mergedCount}/${plan.taskCount - plan.cancelledCount}`;
  const cost = planCost(plan);
  const parts = [progress, ...(cost === undefined ? [] : [cost]), plan.auto, plan.priority];
  return `${parts.join(" · ")} // ${plan.concurrency}`;
}

export function planDataOf(data: Record<string, unknown>): PlanData {
  return planData(data);
}

export function taskDataOf(data: Record<string, unknown>): TaskData {
  return taskData(data);
}

export function priorityIndex(priority: Priority): number {
  return PRIORITIES.indexOf(priority);
}

export function higherPriority(priority: Priority): Priority | undefined {
  const index = priorityIndex(priority);
  return index <= 0 ? undefined : PRIORITIES[index - 1];
}

export function lowerPriority(priority: Priority): Priority | undefined {
  const index = priorityIndex(priority);
  return index < 0 || index >= PRIORITIES.length - 1
    ? undefined
    : PRIORITIES[index + 1];
}

/** A task is open until it merged or was cancelled. */
export function isOpenTask(task: TaskData): boolean {
  return task.phase !== "merged" && task.phase !== "cancelled";
}
