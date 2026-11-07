/** The dev plugin: repositories, plans, tasks and their commands and views. */

import { definePlugin } from "@operad-io/engine";
import devFlow from "../flows/dev.flow.ts";
import { actions } from "./actions.ts";
import { checkDev } from "./check.ts";
import { commands } from "./commands.ts";
import { runRework, runReview, runReviewDue, runVerify } from "./gate.ts";
import { runCleanup, runIntegrate } from "./integrate.ts";
import { runScheduler } from "./schedule.ts";
import { resolveDevKey } from "./service.ts";
import { runWork, runWorktree } from "./steps.ts";
import { STEP_TIMEOUT_SECS } from "./timeouts.ts";
import { planViews, taskViews } from "./views.ts";

/** Builds the dev plugin. Tests build it directly when they need a fake host. */
export function createDevPlugin() {
  return definePlugin({
    name: "dev",
    kind: "domain",
    version: "0.0.0",
    objects: [
      {
        name: "plan",
        resolve: (ctx, type, id) => resolveDevKey(ctx.store, type, id, ctx.cwd),
      },
      {
        name: "task",
        resolve: (ctx, type, id) => resolveDevKey(ctx.store, type, id, ctx.cwd),
      },
    ],
    steps: [
      {
        name: "worktree",
        results: ["ready", "conflict", "blocked", "failed", "cancelled", "interrupted"],
        run: runWorktree,
      },
      {
        name: "work",
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["done", "nothing", "failed", "cancelled", "interrupted"],
        run: runWork,
      },
      {
        name: "verify",
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["pass", "fail", "cancelled"],
        run: runVerify,
      },
      {
        name: "review",
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: [
          "pass",
          "fail",
          "failed",
          "unavailable",
          "timed_out",
          "cancelled",
        ],
        run: runReview,
      },
      {
        name: "review_due",
        // The wait holds until the recorded retry time; it is cancelled with
        // the run, never by the step clock.
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["ready", "interrupted"],
        run: runReviewDue,
      },
      {
        name: "rework",
        results: ["again", "ask", "cancelled"],
        run: runRework,
      },
      {
        name: "integrate",
        timeoutSecs: STEP_TIMEOUT_SECS,
        results: ["merged", "conflict", "fail", "failed", "cancelled"],
        run: runIntegrate,
      },
      {
        name: "cleanup",
        results: ["done", "cancelled"],
        run: runCleanup,
      },
    ],
    flows: [devFlow],
    actions,
    commands,
    onTick: runScheduler,
    views: {
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
export * from "./check.ts";
export * from "./commands.ts";
export * from "./gate.ts";
export * from "./integrate.ts";
export * from "./model.ts";
export * from "./schedule.ts";
export * from "./service.ts";
export * from "./settings.ts";
export * from "./steps.ts";
export * from "./timeouts.ts";
export * from "./views.ts";
