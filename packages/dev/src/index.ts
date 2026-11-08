/** The dev plugin: repositories, plans, tasks and their commands and views. */

import { definePlugin } from "@operad-io/engine";
import { PLAN_FILTERS, REPO_FILTERS, TASK_FILTERS } from "./model.ts";
import devFlow from "../flows/dev.flow.ts";
import { actions } from "./actions.ts";
import { runAnnounce } from "./announce.ts";
import { checkDev } from "./check.ts";
import { commands } from "./commands.ts";
import { runRework, runReview, runReviewDue, runVerify, runWorkDue } from "./gate.ts";
import { runRetry, runRetryDue } from "./retry.ts";
import { runCleanup, runIntegrate } from "./integrate.ts";
import { runScheduler } from "./schedule.ts";
import { devStanding } from "./standing.ts";
import { migrateLegacyRepositories, resolveDevKey } from "./service.ts";
import { runReverify, runWork, runWorktree } from "./steps.ts";
import { STEP_TIMEOUT_SECS } from "./timeouts.ts";
import { planViews, repoViews, taskViews } from "./views.ts";

/** Builds the dev plugin. Tests build it directly when they need a fake host. */
export function createDevPlugin() {
  return definePlugin({
    name: "dev",
    kind: "domain",
    version: "0.0.0",
    objects: [
      {
        name: "repo",
        prepare: ({ store }) => migrateLegacyRepositories(store),
        filters: REPO_FILTERS,
      },
      {
        name: "plan",
        filters: PLAN_FILTERS,
        index: ["repository"],
        resolve: (ctx, type, id) => resolveDevKey(ctx.store, type, id, ctx.cwd, ctx.scope),
      },
      {
        name: "task",
        filters: TASK_FILTERS,
        index: ["repository"],
        resolve: (ctx, type, id) => resolveDevKey(ctx.store, type, id, ctx.cwd, ctx.scope),
      },
    ],
    steps: [
      {
        name: "worktree",
        calls: ["shell/check"],
        results: ["ready", "conflict", "blocked", "failed", "cancelled", "interrupted"],
        run: runWorktree,
      },
      {
        name: "reverify",
        calls: ["shell/check"],
        results: ["ready", "conflict", "failed", "cancelled", "interrupted"],
        run: runReverify,
      },
      {
        name: "work",
        calls: ["pool/agent"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["done", "nothing", "failed", "unavailable", "cancelled", "interrupted"],
        run: runWork,
      },
      {
        name: "verify",
        calls: ["shell/check"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["pass", "fail", "cancelled"],
        run: runVerify,
      },
      {
        name: "review",
        calls: ["shell/check"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: [
          "pass",
          "fail",
          "failed",
          "unavailable",
          "timed_out",
          "exhausted",
          "out_of_time",
          "cancelled",
        ],
        run: runReview,
      },
      {
        name: "review_due",
        // The wait runs in pieces below this timeout until the recorded retry
        // time; it is cancelled with the run, never by the step clock.
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["ready", "interrupted"],
        run: runReviewDue,
      },
      {
        name: "work_due",
        // Like review_due: pieces below this timeout until the recorded time.
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["ready", "interrupted"],
        run: runWorkDue,
      },
      {
        name: "retry",
        results: ["again", "hold", "ask", "give_up", "cancelled"],
        run: runRetry,
      },
      {
        // A wait: it holds until what a retry waits for is there or the bound
        // has passed, in pieces below the step timeout.
        name: "retry_due",
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["ready", "waiting", "interrupted"],
        run: runRetryDue,
      },
      {
        name: "rework",
        results: ["again", "ask", "cancelled"],
        run: runRework,
      },
      {
        name: "integrate",
        calls: ["shell/check", "shell/command"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["merged", "conflict", "fail", "failed", "cancelled"],
        run: runIntegrate,
      },
      {
        name: "cleanup",
        calls: ["shell/command"],
        results: ["done", "cancelled"],
        run: runCleanup,
      },
      {
        name: "announce",
        results: ["done", "interrupted", "cancelled"],
        run: runAnnounce,
      },
    ],
    settings: {
      type: "object",
      properties: {
        checks: {
          type: "integer",
          minimum: 1,
          description:
            "How many verify and integrate checks may run at once in this home, across all repositories. Default 2.",
        },
      },
      additionalProperties: false,
    },
    flows: [devFlow],
    // Every stop that needs a person is in history; a user can route the event
    // to a channel by replacing this rule.
    rules: [
      {
        source: "operad",
        type: "dev.waiting",
        start: { flow: "dev" },
        object: "$event.object",
        mode: "observe",
      },
    ],
    actions,
    commands,
    onTick: runScheduler,
    standing: devStanding,
    views: {
      repo: repoViews,
      plan: planViews,
      task: taskViews,
    },
    keys: {
      c: "dev:confirm",
      x: "dev:cancel",
    },
    check(ctx) {
      return checkDev(ctx);
    },
  });
}

export default createDevPlugin();

export * from "./actions.ts";
export * from "./announce.ts";
export * from "./check.ts";
export * from "./commands.ts";
export * from "./gate.ts";
export * from "./integrate.ts";
export * from "./model.ts";
export * from "./schedule.ts";
export * from "./service.ts";
export * from "./places.ts";
export * from "./retry.ts";
export * from "./stops.ts";
export * from "./settings.ts";
export * from "./standing.ts";
export * from "./steps.ts";
export * from "./timeouts.ts";
export * from "./views.ts";
