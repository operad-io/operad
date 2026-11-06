/** The dev plugin: repositories, plans, tasks and their commands and views. */

import { definePlugin } from "@operad-io/engine";
import { actions } from "./actions.ts";
import { commands } from "./commands.ts";
import { planViews, taskViews } from "./views.ts";

export default definePlugin({
  name: "dev",
  kind: "domain",
  version: "0.0.0",
  objects: [{ name: "plan" }, { name: "task" }],
  actions,
  commands,
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

export * from "./actions.ts";
export * from "./commands.ts";
export * from "./model.ts";
export * from "./service.ts";
export * from "./views.ts";
