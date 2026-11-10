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

/** The worker stage: the harness changes the task branch. */
export interface WorkStage {
  readonly stage: "work";
  /** The harness step; unset uses `worker`/the default pool from dev.json. */
  readonly use?: string | undefined;
  /** Arguments for the harness step; unset uses the worker's own. */
  readonly args?: readonly string[] | undefined;
  /** Extra instructions appended to the worker's prompt. */
  readonly brief?: string | undefined;
  /** Work done before the attempt, such as `merge-main`; dev merges main today. */
  readonly beforeAttempt?: string | undefined;
}

/** The check stage: commands run in a gate checkout. */
export interface CheckStage {
  readonly stage: "check";
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
  { stage: "work" },
  { stage: "check" },
  { stage: "review" },
  { stage: "human" },
];

/** The flow name a repository sets no `flows` for. */
export const DEFAULT_FLOW_NAME = "dev";

/**
 * The registered name of a repository's own flow: the repository and flow make
 * it readable, and the stages' hash makes it unique, so two repositories may
 * use the same flow name and a changed flow gets a new name instead of
 * replacing a graph a running attempt still uses.
 */
export function flowNameFor(
  repository: string,
  flow: string,
  spec: DevFlowSpec,
): string {
  const slug = (text: string): string =>
    text.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "flow";
  const hash = createHash("sha1")
    .update(JSON.stringify(spec.stages))
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
): StepShape {
  return {
    id,
    kind: "wait_person",
    params: {
      prompt,
      choices,
      ...(note === undefined ? {} : { note }),
    },
    replay: "safe",
    next,
  };
}

function end(id: string, status: "done" | "failed" | "cancelled"): StepShape {
  return { id, kind: "end", params: { status }, replay: "safe" };
}

const END_FAILED = end("end_failed", "failed");
const END_CANCELLED = end("end_cancelled", "cancelled");
const END_DONE = end("end_done", "done");

/** The edges of an announcement step: a done stop goes to `wait`. */
function announce(id: string, from: string, result: string, wait: string): StepShape {
  return plugin(
    id,
    "dev/announce",
    { from, result },
    { done: wait, interrupted: wait, cancelled: "end_cancelled" },
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

/** True when the stages are the built-in default, so its old step ids stay. */
function isDefaultStages(stages: readonly DevStage[]): boolean {
  if (stages.length !== DEFAULT_STAGES.length) return false;
  return stages.every((stage, index) => sameStage(stage, DEFAULT_STAGES[index] as DevStage));
}

function sameStage(left: DevStage, right: DevStage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The params a check stage gives `dev/verify`; unset fields read dev.json. */
function checkParams(stage: CheckStage): Readonly<Record<string, unknown>> {
  return {
    ...(stage.commands === undefined ? {} : { commands: stage.commands }),
    ...(stage.rerun === undefined ? {} : { rerun: stage.rerun }),
  };
}

/** The params a work stage gives `dev/work`; unset fields read dev.json. */
function workParams(stage: WorkStage): Readonly<Record<string, unknown>> {
  return {
    ...(stage.use === undefined ? {} : { flowUse: stage.use }),
    ...(stage.args === undefined ? {} : { flowArgs: stage.args }),
    ...(stage.brief === undefined ? {} : { flowBrief: stage.brief }),
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
  return [
    { ...WORKTREE, next: { ...(WORKTREE.next as Edge) } },
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
      },
      "unsafe",
    ),
    waitCheck("work_retry", "dev/work_due", {
      ready: "work",
      interrupted: "end_cancelled",
    }),
    plugin("verify", "dev/verify", checkParams(check), {
      pass: "review",
      fail: "rework",
      cancelled: "end_cancelled",
    }),
    plugin("review", "dev/review", reviewParams(review, gradingName), {
      pass: "announce_ready",
      fail: "rework",
      failed: "announce_review_failed",
      unavailable: "review_retry",
      timed_out: "wait_review_timeout",
      exhausted: "wait_review_unavailable",
      out_of_time: "wait_review_out_of_time",
      cancelled: "end_cancelled",
    }),
    waitCheck("review_retry", "dev/review_due", {
      ready: "review",
      interrupted: "end_cancelled",
    }),
    waitPerson(
      "wait_review_timeout",
      "The task is waiting for you: merge it or reject it.\n\nreview timed out twice",
      ["merge", "reject", "rework"],
      {
        merge: "integrate",
        reject: "worktree",
        rework: "worktree",
        interrupted: "end_cancelled",
      },
      "review timed out twice",
    ),
    waitPerson(
      "wait_review_unavailable",
      "The task is waiting for you: merge it or reject it.\n\nreview did not finish (model unavailable)",
      ["merge", "reject", "rework"],
      {
        merge: "integrate",
        reject: "worktree",
        rework: "worktree",
        interrupted: "end_cancelled",
      },
      "review did not finish (model unavailable)",
    ),
    waitPerson(
      "wait_review_out_of_time",
      "The task is waiting for you: merge it or reject it.\n\nreview did not finish (out of time)",
      ["merge", "reject", "rework"],
      {
        merge: "integrate",
        reject: "worktree",
        rework: "worktree",
        interrupted: "end_cancelled",
      },
      "review did not finish (out of time)",
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
    announce("announce_worktree_environment", "worktree", "environment", "wait"),
    announce("announce_reverify_environment", "reverify", "environment", "wait"),
    announce("announce_work_environment", "work", "environment", "wait"),
    announce("announce_blocked", "worktree", "blocked", "wait"),
    announce("announce_worktree_stopped", "worktree", "interrupted", "wait"),
    announce("announce_reverify_stopped", "reverify", "interrupted", "wait"),
    announce("announce_nothing", "work", "nothing", "wait"),
    announce("announce_work_failed", "work", "failed", "wait"),
    announce("announce_work_stopped", "work", "interrupted", "wait"),
    announce("announce_ready", "review", "pass", "wait"),
    announce("announce_review_failed", "review", "failed", "wait"),
    announce("announce_rework", "rework", "ask", "wait"),
    announce("announce_integrate", "integrate", "failed", "wait"),
    waitPerson(
      "wait",
      "The task is waiting for you: merge it, reject it, or verify and review it again.",
      ["merge", "reject", "rework", "reverify"],
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
    const seen = (counts.get(stage.stage) ?? 0) + 1;
    counts.set(stage.stage, seen);
    return {
      index,
      stage,
      id: seen === 1 ? stage.stage : `${stage.stage}_${seen}`,
    };
  });
}

/** The steps of a flow whose stages are not the built-in default. */
function generatedSteps(
  stages: readonly DevStage[],
  gradingName: string,
): StepShape[] {
  const named = namedStages(stages);
  const firstWork = named.find((item) => item.stage.stage === "work");
  const usedKinds = new Set(named.map((item) => item.stage.stage));
  const hasReverify = usedKinds.has("check") || usedKinds.has("review");
  const choices = hasReverify
    ? ["merge", "reject", "rework", "reverify"]
    : ["merge", "reject", "rework"];
  const lastWork = [...named].reverse().find((item) => item.stage.stage === "work");
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

  /** The entry of the nearest work stage before a stage, or the wait. */
  const workEntryBefore = (index: number): string | undefined => {
    for (let at = index - 1; at >= 0; at -= 1) {
      const item = named[at];
      if (item?.stage.stage !== "work") continue;
      return item.index === 0 ? "worktree" : item.id;
    }
    return undefined;
  };

  const nextAfter = (index: number): string =>
    named[index + 1]?.id ?? "integrate";

  const steps: StepShape[] = [];
  const waitId = "wait";
  steps.push({
    ...WORKTREE,
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
      case "work": {
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
            },
            "unsafe",
          ),
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
          announce(`announce_${id}_environment`, id, "environment", waitId),
          announce(`announce_${id}_nothing`, id, "nothing", waitId),
          announce(`announce_${id}_failed`, id, "failed", waitId),
          announce(`announce_${id}_stopped`, id, "interrupted", waitId),
        );
        break;
      }
      case "check": {
        const id = item.id;
        const target = workEntryBefore(item.index);
        if (target !== undefined) {
          steps.push(
            plugin(id, "dev/verify", checkParams(item.stage), {
              pass: next,
              fail: `rework_${id}`,
              cancelled: "end_cancelled",
            }),
            plugin(`rework_${id}`, "dev/rework", {}, {
              again: target,
              ask: `announce_rework_${id}`,
              cancelled: "end_cancelled",
            }),
            announce(`announce_rework_${id}`, `rework_${id}`, "ask", waitId),
          );
        } else {
          steps.push(
            plugin(id, "dev/verify", checkParams(item.stage), {
              pass: next,
              fail: waitId,
              cancelled: "end_cancelled",
            }),
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
            timed_out: `wait_review_timeout_${id}`,
            exhausted: `wait_review_unavailable_${id}`,
            out_of_time: `wait_review_out_of_time_${id}`,
            cancelled: "end_cancelled",
          }),
          waitCheck(`${id}_retry`, "dev/review_due", {
            ready: id,
            interrupted: "end_cancelled",
          }),
          waitPerson(
            `wait_review_timeout_${id}`,
            "The task is waiting for you: merge it or reject it.\n\nreview timed out twice",
            ["merge", "reject", "rework"],
            {
              merge: "integrate",
              reject: target ?? firstStage,
              rework: target ?? firstStage,
              interrupted: "end_cancelled",
            },
            "review timed out twice",
          ),
          waitPerson(
            `wait_review_unavailable_${id}`,
            "The task is waiting for you: merge it or reject it.\n\nreview did not finish (model unavailable)",
            ["merge", "reject", "rework"],
            {
              merge: "integrate",
              reject: target ?? firstStage,
              rework: target ?? firstStage,
              interrupted: "end_cancelled",
            },
            "review did not finish (model unavailable)",
          ),
          waitPerson(
            `wait_review_out_of_time_${id}`,
            "The task is waiting for you: merge it or reject it.\n\nreview did not finish (out of time)",
            ["merge", "reject", "rework"],
            {
              merge: "integrate",
              reject: target ?? firstStage,
              rework: target ?? firstStage,
              interrupted: "end_cancelled",
            },
            "review did not finish (out of time)",
          ),
          announce(`announce_review_failed_${id}`, id, "failed", waitId),
        );
        if (target !== undefined) {
          steps.push(
            plugin(`rework_${id}`, "dev/rework", {}, {
              again: target,
              ask: `announce_rework_${id}`,
              cancelled: "end_cancelled",
            }),
            announce(`announce_rework_${id}`, `rework_${id}`, "ask", waitId),
          );
        }
        if (passedTo !== next) {
          steps.push(announce(`announce_ready_${id}`, id, "pass", next));
        }
        break;
      }
      case "human": {
        steps.push(
          waitPerson(
            item.id,
            "The task is waiting for you: merge it, reject it, or verify and review it again.",
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
        );
        break;
      }
    }
  }

  steps.push(
    announce("announce_blocked", "worktree", "blocked", waitId),
    announce("announce_worktree_environment", "worktree", "environment", waitId),
    announce("announce_worktree_stopped", "worktree", "interrupted", waitId),
    ...(hasReverify
      ? [
          announce("announce_reverify_environment", "reverify", "environment", waitId),
          announce("announce_reverify_stopped", "reverify", "interrupted", waitId),
        ]
      : []),
    waitPerson(
      waitId,
      "The task is waiting for you: merge it, reject it, or verify and review it again.",
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
    announce("announce_integrate", "integrate", "failed", waitId),
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
  stages: readonly DevStage[],
  options: { readonly gradingName?: string | undefined } = {},
): FlowDefinition {
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
