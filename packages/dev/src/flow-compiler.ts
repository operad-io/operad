/**
 * The compiler that turns a repository's ordered dev stages into an engine
 * flow. A flow is data: worktree first, the stages in order, integrate and
 * cleanup last. The edges a failed stage takes, and the retry, wait and
 * announce steps around it, are the ones the hand-written dev flow used.
 */

import { type FlowDefinition, type StepShape } from "@operad-io/engine";
import { createHash } from "node:crypto";
import type { CheckCommand } from "./settings.ts";
import { DEV_MAX_VISITS } from "./timeouts.ts";
import { WAIT_STEPS, WORK_QUESTION_CHOICES, WORK_QUESTION_LATE_CHOICES, waitChoiceInfo, waitChoices } from "./waits.ts";

/** The current names of the four stage kinds. */
export type StageKind = "code" | "test" | "review" | "human";

/** The code stage: the harness changes the task branch. `work` is its older name. */
export interface WorkStage {
  readonly stage: "code" | "work";
  /** The harness step; unset uses `worker`/the default pool from dev.json. */
  readonly use?: string | undefined;
  /** Arguments for the harness step; unset uses the worker's own. */
  readonly args?: readonly string[] | undefined;
  /** The pool the stage takes workers from; unset is `default`. */
  readonly pool?: string | undefined;
  /** A file (relative to the repository) that replaces the repository's worker brief for this stage. */
  readonly workerBrief?: string | undefined;
  /** When true, dev commits what the worker left in the worktree after a done; default false. */
  readonly commit?: boolean | undefined;
  /** Extra instructions appended to the worker's prompt. */
  readonly brief?: string | undefined;
  /** Work done before the attempt, such as `merge-main`; dev merges main today. */
  readonly beforeAttempt?: string | undefined;
}

/** The test stage: commands run in a gate checkout. `check` is its older name. */
export interface CheckStage {
  readonly stage: "test" | "check";
  /** The commands; unset uses `gate.commands` from dev.json. */
  readonly commands?: readonly CheckCommand[] | undefined;
  /** How often a failed line list runs again; unset uses `check.rerun`. */
  readonly rerun?: number | undefined;
}

/** The review stage: a reviewer harness reads the diff. */
export interface ReviewStage {
  readonly stage: "review";
  /** The reviewer harness step; unset uses `reviewer.use` from dev.json. */
  readonly use?: string | undefined;
  /** The reviewer's arguments; unset uses `reviewer.args`. */
  readonly args?: readonly string[] | undefined;
  /** The arguments of every review after the first in an attempt. */
  readonly later?: readonly string[] | undefined;
  /** The entry in review.json; unset names the flow itself. */
  readonly grading?: string | undefined;
}

/** The human stage: the run waits for a person to decide. */
export interface HumanStage {
  readonly stage: "human";
}

/** One stage of a repository flow. */
export type DevStage = WorkStage | CheckStage | ReviewStage | HumanStage;

/** A repository flow: its stages, in order. */
export interface DevFlowSpec {
  readonly stages: readonly DevStage[];
}

/** The flows a repository sets in dev.json, by name. */
export type DevFlows = Readonly<Record<string, DevFlowSpec>>;

/** The stages a repository with no `flows` gets: today's dev flow. */
export const DEFAULT_STAGES: readonly DevStage[] = [
  { stage: "code" },
  { stage: "test" },
  { stage: "review" },
  { stage: "human" },
];

/** The flow name a repository sets no `flows` for. */
export const DEFAULT_FLOW_NAME = "dev";

/**
 * The registered name of a repository's own flow: the repository and flow make
 * it readable, and the hash of the compiled graph makes it unique, so two
 * repositories may use the same flow name, and a changed flow or a dev that
 * compiles the same stages to other steps gets a new name instead of
 * replacing a graph a running attempt still uses.
 */
export function flowNameFor(
  repository: string,
  flow: string,
  spec: DevFlowSpec,
): string {
  const slug = (text: string): string =>
    text.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "flow";
  const graph = compileDevFlow("", spec.stages, { gradingName: flow });
  const hash = createHash("sha1")
    .update(
      JSON.stringify({ entry: graph.entry, maxVisits: graph.maxVisits, steps: graph.steps }),
    )
    .digest("hex")
    .slice(0, 12);
  return `dev/${slug(repository)}/${slug(flow)}/${hash}`;
}

type Edge = Readonly<Record<string, string>>;

function plugin(
  id: string,
  use: string,
  params: Readonly<Record<string, unknown>>,
  next: Edge,
  replay: "safe" | "unsafe" = "safe",
): StepShape {
  return { id, kind: "plugin", params: { use, params }, replay, next };
}

function waitCheck(id: string, check: string, next: Edge): StepShape {
  return { id, kind: "wait", params: { check }, replay: "safe", next };
}

function waitPerson(
  id: string,
  prompt: string,
  choices: readonly string[],
  next: Edge,
  note?: string,
  primary = true,
): StepShape {
  return {
    id,
    kind: "wait_person",
    params: {
      prompt,
      choices,
      choiceInfo: waitChoiceInfo(choices, primary),
      ...(note === undefined ? {} : { note }),
    },
    replay: "safe",
    next,
  };
}

/** The wait a worker's own question goes to, and the answer goes back to the same work step. */
function workQuestionWaitId(workId: string): string {
  return workId === "work"
    ? WAIT_STEPS["work-question"]
    : `${WAIT_STEPS["work-question"]}_${workId}`;
}

function waitWorkerQuestion(id: string, workId: string): StepShape {
  return {
    id,
    kind: "wait_person",
    params: {
      prompt: "The worker asked about a call.",
      choices: [...WORK_QUESTION_CHOICES],
      lateChoices: [...WORK_QUESTION_LATE_CHOICES],
    },
    replay: "safe",
    next: {
      allow_once: workId,
      allow_always: workId,
      reject_once: workId,
      interrupted: "end_cancelled",
    },
  };
}

function end(id: string, status: "done" | "failed" | "cancelled"): StepShape {
  return { id, kind: "end", params: { status }, replay: "safe" };
}

const END_FAILED = end("end_failed", "failed");
const END_CANCELLED = end("end_cancelled", "cancelled");
const END_DONE = end("end_done", "done");

/**
 * The edges of an announcement step: a stop, or the question it hands over,
 * goes to `wait`.
 */
function announce(
  id: string,
  from: string,
  result: string,
  wait: string,
  choices: readonly string[],
): StepShape {
  return plugin(
    id,
    "dev/announce",
    { from, result, choices },
    {
      done: wait,
      interrupted: wait,
      waiting: wait,
      cancelled: "end_cancelled",
    },
  );
}

/** The retry step and its wait, as the hand-written flow declares them. */
function retry(
  id: string,
  from: string,
  result: string,
  again: string,
  ask: string,
  giveUp: string,
  hold: string,
): StepShape {
  return plugin(
    id,
    "dev/retry",
    { from, result },
    { again, hold, ask, give_up: giveUp, cancelled: "end_cancelled" },
  );
}

const WORKTREE: StepShape = plugin(
  "worktree",
  "dev/worktree",
  {},
  {
    ready: "work",
    conflict: "work",
    blocked: "announce_blocked",
    failed: "end_failed",
    cancelled: "end_cancelled",
    interrupted: "retry_worktree",
  },
  "unsafe",
);

const REVERIFY: StepShape = plugin(
  "reverify",
  "dev/reverify",
  {},
  {
    ready: "verify",
    conflict: "work",
    failed: "end_failed",
    cancelled: "end_cancelled",
    interrupted: "retry_reverify",
  },
  "unsafe",
);

/** The current name of a stage kind; the older `work` and `check` load as `code` and `test`. */
function canonicalStage(stage: DevStage): DevStage {
  if (stage.stage === "work") return { ...stage, stage: "code" };
  if (stage.stage === "check") return { ...stage, stage: "test" };
  return stage;
}

function canonicalStages(stages: readonly DevStage[]): DevStage[] {
  return stages.map(canonicalStage);
}

/** The internal step id base of a stage, with the ids earlier runs recorded. */
function stepNameOf(stage: DevStage): string {
  switch (stage.stage) {
    case "code":
    case "work":
      return "work";
    case "test":
    case "check":
      return "check";
    default:
      return stage.stage;
  }
}

/** True when the stages are the built-in default, so its old step ids stay. */
function isDefaultStages(stages: readonly DevStage[]): boolean {
  if (stages.length !== DEFAULT_STAGES.length) return false;
  return stages.every((stage, index) => sameStage(stage, DEFAULT_STAGES[index] as DevStage));
}

function sameStage(left: DevStage, right: DevStage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The params a test stage gives `dev/verify`; unset fields read dev.json. */
function checkParams(stage: CheckStage): Readonly<Record<string, unknown>> {
  return {
    ...(stage.commands === undefined ? {} : { commands: stage.commands }),
    ...(stage.rerun === undefined ? {} : { rerun: stage.rerun }),
  };
}

/** The params a code stage gives `dev/worktree`; unset fields read dev.json. */
function worktreeParams(work: WorkStage | undefined): Readonly<Record<string, unknown>> {
  return work?.beforeAttempt === undefined ? {} : { beforeAttempt: work.beforeAttempt };
}

/** The params a code stage gives `dev/work`; unset fields read dev.json. */
function workParams(stage: WorkStage): Readonly<Record<string, unknown>> {
  return {
    ...(stage.use === undefined ? {} : { flowUse: stage.use }),
    ...(stage.args === undefined ? {} : { flowArgs: stage.args }),
    ...(stage.pool === undefined ? {} : { flowPool: stage.pool }),
    ...(stage.brief === undefined ? {} : { flowBrief: stage.brief }),
    ...(stage.workerBrief === undefined ? {} : { flowWorkerBrief: stage.workerBrief }),
    ...(stage.commit === true ? { flowCommit: true } : {}),
    ...(stage.beforeAttempt === undefined ? {} : { beforeAttempt: stage.beforeAttempt }),
  };
}

/** The params a review stage gives `dev/review`, including its grading entry. */
function reviewParams(
  stage: ReviewStage,
  gradingName: string,
): Readonly<Record<string, unknown>> {
  return {
    ...(stage.use === undefined ? {} : { use: stage.use }),
    ...(stage.args === undefined ? {} : { args: stage.args }),
    ...(stage.later === undefined ? {} : { later: stage.later }),
    ...(stage.grading === undefined ? {} : { grading: stage.grading }),
    // A custom flow reads its own entry unless the stage names one.
    ...(stage.grading === undefined && gradingName !== DEFAULT_FLOW_NAME
      ? { grading: gradingName }
      : {}),
  };
}

/** Every step of the built-in default flow, with the ids earlier runs use. */
function defaultSteps(
  stages: readonly DevStage[],
  gradingName: string,
): StepShape[] {  const check = stages[1] as CheckStage;
  const review = stages[2] as ReviewStage;
  const work = stages[0] as WorkStage;
  const choices = waitChoices("person", true);
  return [
    { ...WORKTREE, params: { use: "dev/worktree", params: worktreeParams(work) }, next: { ...(WORKTREE.next as Edge) } },
    { ...REVERIFY, next: { ...(REVERIFY.next as Edge) } },
    plugin(
      "work",
      "dev/work",
      workParams(work),
      {
        done: "verify",
        nothing: "announce_nothing",
        failed: "retry_work_failed",
        unavailable: "work_retry",
        cancelled: "end_cancelled",
        interrupted: "retry_work_stopped",
        waiting: workQuestionWaitId("work"),
      },
      "unsafe",
    ),
    waitWorkerQuestion(workQuestionWaitId("work"), "work"),
    waitCheck("work_retry", "dev/work_due", {
      ready: "work",
      interrupted: "end_cancelled",
    }),
    plugin("verify", "dev/verify", checkParams(check), {
      pass: "review",
      fail: "rework",
      not_code: "announce_verify_not_code",
      cancelled: "end_cancelled",
    }),
    plugin("review", "dev/review", reviewParams(review, gradingName), {
      pass: "announce_ready",
      fail: "rework",
      failed: "announce_review_failed",
      unavailable: "review_retry",
      timed_out: WAIT_STEPS["review-timeout"],
      exhausted: WAIT_STEPS["review-unavailable"],
      out_of_time: WAIT_STEPS["review-out-of-time"],
      cancelled: "end_cancelled",
    }),
    waitCheck("review_retry", "dev/review_due", {
      ready: "review",
      interrupted: "end_cancelled",
    }),
    waitPerson(
      WAIT_STEPS["review-timeout"],
      "review timed out twice",
      waitChoices("review-timeout", true),
      {
        merge: "integrate",
        reject: "worktree",
        rework: "worktree",
        interrupted: "end_cancelled",
      },
      "review timed out twice",
      false,
    ),
    waitPerson(
      WAIT_STEPS["review-unavailable"],
      "review did not finish (model unavailable)",
      waitChoices("review-unavailable", true),
      {
        merge: "integrate",
        reject: "worktree",
        rework: "worktree",
        reverify: "reverify",
        interrupted: "end_cancelled",
      },
      "review did not finish (model unavailable)",
      false,
    ),
    waitPerson(
      WAIT_STEPS["review-out-of-time"],
      "review did not finish (out of time)",
      waitChoices("review-out-of-time", true),
      {
        merge: "integrate",
        reject: "worktree",
        rework: "worktree",
        interrupted: "end_cancelled",
      },
      "review did not finish (out of time)",
      false,
    ),
    plugin("rework", "dev/rework", {}, {
      again: "worktree",
      ask: "announce_rework",
      cancelled: "end_cancelled",
    }),
    retry(
      "retry_worktree",
      "worktree",
      "interrupted",
      "worktree",
      "announce_worktree_stopped",
      "announce_worktree_environment",
      "retry_worktree_wait",
    ),
    waitCheck("retry_worktree_wait", "dev/retry_due", {
      ready: "retry_worktree_after",
      interrupted: "end_cancelled",
    }),
    retry(
      "retry_worktree_after",
      "worktree",
      "waited",
      "worktree",
      "announce_worktree_stopped",
      "announce_worktree_environment",
      "retry_worktree_wait",
    ),
    retry(
      "retry_reverify",
      "reverify",
      "interrupted",
      "reverify",
      "announce_reverify_stopped",
      "announce_reverify_environment",
      "retry_reverify_wait",
    ),
    waitCheck("retry_reverify_wait", "dev/retry_due", {
      ready: "retry_reverify_after",
      interrupted: "end_cancelled",
    }),
    retry(
      "retry_reverify_after",
      "reverify",
      "waited",
      "reverify",
      "announce_reverify_stopped",
      "announce_reverify_environment",
      "retry_reverify_wait",
    ),
    retry(
      "retry_work_failed",
      "work",
      "failed",
      "work",
      "announce_work_failed",
      "announce_work_environment",
      "retry_work_wait",
    ),
    retry(
      "retry_work_stopped",
      "work",
      "interrupted",
      "work",
      "announce_work_stopped",
      "announce_work_environment",
      "retry_work_wait",
    ),
    waitCheck("retry_work_wait", "dev/retry_due", {
      ready: "retry_work_after",
      interrupted: "end_cancelled",
    }),
    retry(
      "retry_work_after",
      "work",
      "waited",
      "work",
      "announce_work_stopped",
      "announce_work_environment",
      "retry_work_wait",
    ),
    announce("announce_worktree_environment", "worktree", "environment", "wait", choices),
    announce("announce_reverify_environment", "reverify", "environment", "wait", choices),
    announce("announce_work_environment", "work", "environment", "wait", choices),
    announce("announce_blocked", "worktree", "blocked", "wait", choices),
    announce("announce_worktree_stopped", "worktree", "interrupted", "wait", choices),
    announce("announce_reverify_stopped", "reverify", "interrupted", "wait", choices),
    announce("announce_nothing", "work", "nothing", "wait", choices),
    announce("announce_work_failed", "work", "failed", "wait", choices),
    announce("announce_work_stopped", "work", "interrupted", "wait", choices),
    announce("announce_verify_not_code", "verify", "not_code", "wait", choices),
    announce("announce_ready", "review", "pass", "wait", choices),
    announce("announce_review_failed", "review", "failed", "wait", choices),
    announce("announce_rework", "rework", "ask", "wait", choices),
    announce("announce_integrate", "integrate", "failed", "wait", choices),
    waitPerson(
      WAIT_STEPS.person,
      "The task is waiting for you.",
      waitChoices("person", true),
      {
        merge: "integrate",
        reject: "worktree",
        rework: "worktree",
        reverify: "reverify",
        interrupted: "end_cancelled",
      },
      "the run stopped during {step}; reject to run it again, or reverify to check the same commit again",
    ),
    plugin("integrate", "dev/integrate", {}, {
      merged: "cleanup",
      conflict: "worktree",
      fail: "worktree",
      failed: "announce_integrate",
      cancelled: "end_cancelled",
    }),
    plugin("cleanup", "dev/cleanup", {}, {
      done: "end_done",
      cancelled: "end_cancelled",
    }),
    END_DONE,
    END_FAILED,
    END_CANCELLED,
  ];
}

interface NamedStage {
  readonly index: number;
  readonly stage: DevStage;
  readonly id: string;
}

/** The step id of each stage: the first of a kind keeps its plain name. */
function namedStages(stages: readonly DevStage[]): NamedStage[] {
  const counts = new Map<string, number>();
  return stages.map((stage, index) => {
    const base = stepNameOf(stage);
    const seen = (counts.get(base) ?? 0) + 1;
    counts.set(base, seen);
    return {
      index,
      stage,
      id: seen === 1 ? base : `${base}_${seen}`,
    };
  });
}

/** The steps of a flow whose stages are not the built-in default. */
function generatedSteps(
  stages: readonly DevStage[],
  gradingName: string,
): StepShape[] {
  const named = namedStages(stages);
  const firstWork = named.find((item) => item.stage.stage === "code");
  const usedKinds = new Set(named.map((item) => item.stage.stage));
  const hasReverify = usedKinds.has("test") || usedKinds.has("review");
  const choices = waitChoices("person", hasReverify);
  const lastWork = [...named].reverse().find((item) => item.stage.stage === "code");
  const reverifyTarget =
    lastWork === undefined
      ? (named[0]?.id ?? "integrate")
      : (named.find((item) => item.index > lastWork.index)?.id ?? "integrate");
  const firstStage = named[0]?.id ?? "integrate";

  /** Where a person's reject or rework sends the flow. */
  const reworkTarget = firstWork === undefined
    ? firstStage
    : firstWork.index === 0
      ? "worktree"
      : firstWork.id;

  /** The entry of the nearest code stage before a stage, or the wait. */
  const workEntryBefore = (index: number): string | undefined => {
    for (let at = index - 1; at >= 0; at -= 1) {
      const item = named[at];
      if (item?.stage.stage !== "code") continue;
      return item.index === 0 ? "worktree" : item.id;
    }
    return undefined;
  };

  const nextAfter = (index: number): string =>
    named[index + 1]?.id ?? "integrate";

  const firstWorkStage = firstWork?.stage.stage === "code" ? firstWork.stage : undefined;
  const steps: StepShape[] = [];
  const waitId = WAIT_STEPS.person;
  steps.push({
    ...WORKTREE,
    params: { use: "dev/worktree", params: worktreeParams(firstWorkStage) },
    next: {
      ready: firstStage,
      conflict: firstWork === undefined ? waitId : firstWork.id,
      blocked: "announce_blocked",
      failed: "end_failed",
      cancelled: "end_cancelled",
      interrupted: "retry_worktree",
    },
  });
  if (hasReverify) {
    steps.push({
      ...REVERIFY,
      next: {
        ready: reverifyTarget,
        conflict: reworkTarget,
        failed: "end_failed",
        cancelled: "end_cancelled",
        interrupted: "retry_reverify",
      },
    });
  }
  steps.push(
    retry(
      "retry_worktree",
      "worktree",
      "interrupted",
      "worktree",
      "announce_worktree_stopped",
      "announce_worktree_environment",
      "retry_worktree_wait",
    ),
    waitCheck("retry_worktree_wait", "dev/retry_due", {
      ready: "retry_worktree_after",
      interrupted: "end_cancelled",
    }),
    retry(
      "retry_worktree_after",
      "worktree",
      "waited",
      "worktree",
      "announce_worktree_stopped",
      "announce_worktree_environment",
      "retry_worktree_wait",
    ),
  );
  if (hasReverify) {
    steps.push(
      retry(
        "retry_reverify",
        "reverify",
        "interrupted",
        "reverify",
        "announce_reverify_stopped",
        "announce_reverify_environment",
        "retry_reverify_wait",
      ),
      waitCheck("retry_reverify_wait", "dev/retry_due", {
        ready: "retry_reverify_after",
        interrupted: "end_cancelled",
      }),
      retry(
        "retry_reverify_after",
        "reverify",
        "waited",
        "reverify",
        "announce_reverify_stopped",
        "announce_reverify_environment",
        "retry_reverify_wait",
      ),
    );
  }

  for (const item of named) {
    const next = nextAfter(item.index);
    switch (item.stage.stage) {
      case "code": {
        const id = item.id;
        steps.push(
          plugin(
            id,
            "dev/work",
            workParams(item.stage),
            {
              done: next,
              nothing: `announce_${id}_nothing`,
              failed: `retry_${id}_failed`,
              unavailable: `${id}_retry`,
              cancelled: "end_cancelled",
              interrupted: `retry_${id}_stopped`,
              waiting: workQuestionWaitId(id),
            },
            "unsafe",
          ),
          waitWorkerQuestion(workQuestionWaitId(id), id),
          waitCheck(`${id}_retry`, "dev/work_due", {
            ready: id,
            interrupted: "end_cancelled",
          }),
          retry(
            `retry_${id}_failed`,
            id,
            "failed",
            id,
            `announce_${id}_failed`,
            `announce_${id}_environment`,
            `retry_${id}_wait`,
          ),
          retry(
            `retry_${id}_stopped`,
            id,
            "interrupted",
            id,
            `announce_${id}_stopped`,
            `announce_${id}_environment`,
            `retry_${id}_wait`,
          ),
          waitCheck(`retry_${id}_wait`, "dev/retry_due", {
            ready: `retry_${id}_after`,
            interrupted: "end_cancelled",
          }),
          retry(
            `retry_${id}_after`,
            id,
            "waited",
            id,
            `announce_${id}_stopped`,
            `announce_${id}_environment`,
            `retry_${id}_wait`,
          ),
          announce(`announce_${id}_environment`, id, "environment", waitId, choices),
          announce(`announce_${id}_nothing`, id, "nothing", waitId, choices),
          announce(`announce_${id}_failed`, id, "failed", waitId, choices),
          announce(`announce_${id}_stopped`, id, "interrupted", waitId, choices),
        );
        break;
      }
      case "test": {
        const id = item.id;
        const target = workEntryBefore(item.index);
        if (target !== undefined) {
          steps.push(
            plugin(id, "dev/verify", checkParams(item.stage), {
              pass: next,
              fail: `rework_${id}`,
              not_code: `announce_${id}_not_code`,
              cancelled: "end_cancelled",
            }),
            announce(`announce_${id}_not_code`, id, "not_code", waitId, choices),
            plugin(`rework_${id}`, "dev/rework", {}, {
              again: target,
              ask: `announce_rework_${id}`,
              cancelled: "end_cancelled",
            }),
            announce(`announce_rework_${id}`, `rework_${id}`, "ask", waitId, choices),
          );
        } else {
          steps.push(
            plugin(id, "dev/verify", checkParams(item.stage), {
              pass: next,
              fail: waitId,
              not_code: `announce_${id}_not_code`,
              cancelled: "end_cancelled",
            }),
            announce(`announce_${id}_not_code`, id, "not_code", waitId, choices),
          );
        }
        break;
      }
      case "review": {
        const id = item.id;
        const target = workEntryBefore(item.index);
        const passedTo =
          named[item.index + 1]?.stage.stage === "human"
            ? `announce_ready_${id}`
            : next;
        steps.push(
          plugin(id, "dev/review", reviewParams(item.stage, gradingName), {
            pass: passedTo,
            fail: target === undefined ? waitId : `rework_${id}`,
            failed: `announce_review_failed_${id}`,
            unavailable: `${id}_retry`,
            timed_out: `${WAIT_STEPS["review-timeout"]}_${id}`,
            exhausted: `${WAIT_STEPS["review-unavailable"]}_${id}`,
            out_of_time: `${WAIT_STEPS["review-out-of-time"]}_${id}`,
            cancelled: "end_cancelled",
          }),
          waitCheck(`${id}_retry`, "dev/review_due", {
            ready: id,
            interrupted: "end_cancelled",
          }),
          waitPerson(
            `${WAIT_STEPS["review-timeout"]}_${id}`,
            "review timed out twice",
            waitChoices("review-timeout", hasReverify),
            {
              merge: "integrate",
              reject: target ?? firstStage,
              rework: target ?? firstStage,
              interrupted: "end_cancelled",
            },
            "review timed out twice",
            false,
          ),
          waitPerson(
            `${WAIT_STEPS["review-unavailable"]}_${id}`,
            "review did not finish (model unavailable)",
            waitChoices("review-unavailable", hasReverify),
            {
              merge: "integrate",
              reject: target ?? firstStage,
              rework: target ?? firstStage,
              ...(hasReverify ? { reverify: "reverify" } : {}),
              interrupted: "end_cancelled",
            },
            "review did not finish (model unavailable)",
            false,
          ),
          waitPerson(
            `${WAIT_STEPS["review-out-of-time"]}_${id}`,
            "review did not finish (out of time)",
            waitChoices("review-out-of-time", hasReverify),
            {
              merge: "integrate",
              reject: target ?? firstStage,
              rework: target ?? firstStage,
              interrupted: "end_cancelled",
            },
            "review did not finish (out of time)",
            false,
          ),
          announce(`announce_review_failed_${id}`, id, "failed", waitId, choices),
        );
        if (target !== undefined) {
          steps.push(
            plugin(`rework_${id}`, "dev/rework", {}, {
              again: target,
              ask: `announce_rework_${id}`,
              cancelled: "end_cancelled",
            }),
            announce(`announce_rework_${id}`, `rework_${id}`, "ask", waitId, choices),
          );
        }
        if (passedTo !== next) {
          steps.push(announce(`announce_ready_${id}`, id, "pass", next, choices));
        }
        break;
      }
      case "human": {
        steps.push(
          waitPerson(
            item.id,
            "The task is waiting for you.",
            choices,
            {
              merge: next,
              reject: reworkTarget,
              rework: reworkTarget,
              ...(hasReverify ? { reverify: "reverify" } : {}),
              interrupted: "end_cancelled",
            },
            "the run stopped during {step}; reject to run it again, or reverify to check the same commit again",
          ),
        );
        break;
      }
    }
  }

  steps.push(
    announce("announce_blocked", "worktree", "blocked", waitId, choices),
    announce("announce_worktree_environment", "worktree", "environment", waitId, choices),
    announce("announce_worktree_stopped", "worktree", "interrupted", waitId, choices),
    ...(hasReverify
      ? [
          announce("announce_reverify_environment", "reverify", "environment", waitId, choices),
          announce("announce_reverify_stopped", "reverify", "interrupted", waitId, choices),
        ]
      : []),
    waitPerson(
      waitId,
      "The task is waiting for you.",
      choices,
      {
        merge: "integrate",
        reject: reworkTarget,
        rework: reworkTarget,
        ...(hasReverify ? { reverify: "reverify" } : {}),
        interrupted: "end_cancelled",
      },
      "the run stopped during {step}; reject to run it again, or reverify to check the same commit again",
    ),
    plugin("integrate", "dev/integrate", {}, {
      merged: "cleanup",
      conflict: reworkTarget,
      fail: reworkTarget,
      failed: "announce_integrate",
      cancelled: "end_cancelled",
    }),
    announce("announce_integrate", "integrate", "failed", waitId, choices),
    plugin("cleanup", "dev/cleanup", {}, {
      done: "end_done",
      cancelled: "end_cancelled",
    }),
    END_DONE,
    END_FAILED,
    END_CANCELLED,
  );
  return steps;
}

/** The visit bound of a generated flow: today's plus room for every stage. */
function visitsFor(stages: readonly DevStage[], defaults: boolean): number {
  return defaults ? DEV_MAX_VISITS : DEV_MAX_VISITS + Math.max(0, stages.length - 4) * 10;
}

/**
 * Compiles a repository flow. The built-in default stages keep the step ids
 * earlier dev runs and tests use; every other stage list gets ids from its
 * stage names and order.
 */
export function compileDevFlow(
  name: string,
  written: readonly DevStage[],
  options: { readonly gradingName?: string | undefined } = {},
): FlowDefinition {
  const stages = canonicalStages(written);
  const defaults = isDefaultStages(stages);
  const steps = defaults
    ? defaultSteps(stages, options.gradingName ?? name)
    : generatedSteps(stages, options.gradingName ?? name);
  return {
    name,
    entry: "worktree",
    maxVisits: visitsFor(stages, defaults),
    steps,
  };
}
