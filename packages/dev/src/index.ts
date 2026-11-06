/** The dev plugin: repositories, plans, tasks and their commands and views. */

import { definePlugin } from "@operad-io/engine";
import devFlow from "../flows/dev.flow.ts";
import { actions } from "./actions.ts";
import { checkDev } from "./check.ts";
import { commands } from "./commands.ts";
import { runRework, runReview, runVerify } from "./gate.ts";
import { runCleanup, runIntegrate } from "./integrate.ts";
import { runScheduler } from "./schedule.ts";
import { resolveDevKey } from "./service.ts";
import { runWork, runWorktree } from "./steps.ts";
import { planViews, taskViews } from "./views.ts";

/** Options for building the plugin; tests use the defaults. */
export interface DevPluginOptions {
  /** Whether the shipped plugin declares the radian harness it defaults to. */
  readonly requiresHarness?: boolean | undefined;
}

/** Builds the dev plugin. Tests build it directly when they need a fake host. */
export function createDevPlugin(options: DevPluginOptions = {}) {
  return definePlugin({
    name: "dev",
    kind: "domain",
    version: "0.0.0",
    ...(options.requiresHarness === true
      ? { requires: { plugins: { "harness-radian": ">=0.0.0" } } }
      : {}),
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
        results: ["ready", "conflict", "blocked", "failed", "cancelled"],
        run: runWorktree,
      },
      {
        name: "work",
        results: ["done", "nothing", "failed", "cancelled"],
        run: runWork,
      },
      {
        name: "verify",
        results: ["pass", "fail", "cancelled"],
        run: runVerify,
      },
      {
        name: "review",
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

export default createDevPlugin({ requiresHarness: true });

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
export * from "./views.ts";
