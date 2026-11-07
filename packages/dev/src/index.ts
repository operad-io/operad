/** The dev plugin: repositories, plans, tasks and their commands and views. */

import { definePlugin } from "@operad-io/engine";
import devFlow from "../flows/dev.flow.ts";
import { actions } from "./actions.ts";
import { runAnnounce } from "./announce.ts";
import { checkDev } from "./check.ts";
import { commands } from "./commands.ts";
import { runRework, runReview, runVerify } from "./gate.ts";
import { runCleanup, runIntegrate } from "./integrate.ts";
import { runScheduler } from "./schedule.ts";
import { resolveDevKey } from "./service.ts";
import { runWork, runWorktree } from "./steps.ts";
import { planViews, taskViews } from "./views.ts";

/**
 * How long work, verify, review and integrate may take: above the worker's
 * two-hour wall time and the reviewer's one-hour timeout in `.operad/dev.json`.
 */
const STEP_TIMEOUT_SECS = 3 * 60 * 60;

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
        results: ["pass", "fail", "failed", "cancelled"],
        run: runReview,
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
      {
        name: "announce",
        results: ["done", "interrupted", "cancelled"],
        run: runAnnounce,
      },
    ],
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
export * from "./announce.ts";
export * from "./check.ts";
export * from "./commands.ts";
export * from "./gate.ts";
export * from "./integrate.ts";
export * from "./model.ts";
export * from "./schedule.ts";
export * from "./service.ts";
export * from "./settings.ts";
export * from "./steps.ts";
export * from "./views.ts";
