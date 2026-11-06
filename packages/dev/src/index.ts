/** The dev plugin: repositories, plans, tasks and their commands and views. */

import { definePlugin } from "@operad-io/engine";
import devFlow from "../flows/dev.flow.ts";
import { actions } from "./actions.ts";
import { commands } from "./commands.ts";
import { runRework, runReview, runVerify } from "./gate.ts";
import { runCleanup, runIntegrate } from "./integrate.ts";
import { runScheduler } from "./schedule.ts";
import { resolveDevKey } from "./service.ts";
import { runWork, runWorktree } from "./steps.ts";
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
        results: ["ready", "conflict", "failed"],
        run: runWorktree,
      },
      {
        name: "work",
        results: ["done", "nothing", "failed"],
        run: runWork,
      },
      {
        name: "verify",
        results: ["pass", "fail"],
        run: runVerify,
      },
      {
        name: "review",
        results: ["pass", "fail", "failed"],
        run: runReview,
      },
      {
        name: "rework",
        results: ["again", "ask"],
        run: runRework,
      },
      {
        name: "integrate",
        results: ["merged", "conflict", "fail", "failed"],
        run: runIntegrate,
      },
      {
        name: "cleanup",
        results: ["done"],
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
    check() {
      return "ready";
    },
  });
}

export default createDevPlugin();

export * from "./actions.ts";
export * from "./commands.ts";
export * from "./gate.ts";
export * from "./integrate.ts";
export * from "./model.ts";
export * from "./schedule.ts";
export * from "./service.ts";
export * from "./settings.ts";
export * from "./steps.ts";
export * from "./views.ts";
