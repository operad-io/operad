/**
 * What `dev` asks a person to know about without a run waiting: a repository
 * whose settings are not valid, a plugin dev needs that the home does not
 * load, and proposed tasks.
 * The pending view builds these each time, so each disappears when it is fixed.
 */

import type { StandingContext, StandingItem } from "@operad-io/engine";
import { bareId, listAll, planData, storeKey, taskData } from "./model.ts";
import { listRepositories } from "./service.ts";
import { hasValidSettings, settingsProblem } from "./settings.ts";

/** A plugin dev starts steps of, so it cannot start work without it. */
export interface RequiredPlugin {
  readonly name: string;
  readonly why: string;
}

/** The plugins dev's steps run through. */
export const REQUIRED_PLUGINS: readonly RequiredPlugin[] = [
  { name: "pool", why: "runs its workers" },
];

/** The required plugins that `loaded` does not contain. */
export function missingPlugins(loaded: readonly string[]): readonly RequiredPlugin[] {
  return REQUIRED_PLUGINS.filter((plugin) => !loaded.includes(plugin.name));
}

function pluginItem(plugin: RequiredPlugin): StandingItem {
  return {
    id: `plugin:${plugin.name}`,
    prompt: `plugin ${plugin.name} is not loaded and dev ${plugin.why} through it: run \`operad plugin enable ${plugin.name}\` and restart serve; until then no new work starts`,
  };
}

/** The `standing` hook of the dev plugin. */
export async function devStanding(ctx: StandingContext): Promise<readonly StandingItem[]> {
  const items: StandingItem[] = [];
  for (const repository of await listRepositories(ctx.store)) {
    const problem = settingsProblem(repository.path);
    if (problem === undefined) continue;
    items.push({
      id: `settings:${repository.name}`,
      prompt: hasValidSettings(repository.path)
        ? `the repository settings are not valid: ${problem}; the last valid settings are in use (repository ${repository.name})`
        : `the repository settings are not valid: ${problem}; no valid settings were read before, so nothing starts in it until the file is fixed (repository ${repository.name})`,
    });
  }
  // A proposed task has no run, so it is pending here: whoever opened it, the
  // owner confirms or cancels it. It leaves when it is confirmed or cancelled.
  // A task of a draft plan is confirmed with its plan, so the plan carries one
  // item for all of its proposed tasks.
  const drafts = new Map<string, { titles: string[]; tasks: { type: string; id: string }[]; byDev: boolean }>();
  for (const object of await listAll(ctx.store, "task")) {
    const task = taskData(object.data);
    if (task.phase !== "proposed") continue;
    const planKey = storeKey(task.repository, task.plan);
    const plan = await ctx.store.get("plan", planKey);
    if (plan !== undefined && planData(plan.data).status === "draft") {
      const draft = drafts.get(planKey) ?? { titles: [], tasks: [], byDev: false };
      draft.titles.push(`${bareId(object.id)}`);
      draft.tasks.push({ type: "task", id: object.id });
      draft.byDev = draft.byDev || task.openedBy === "dev";
      drafts.set(planKey, draft);
      continue;
    }
    const by = task.openedBy === "dev" ? "dev" : "a person";
    items.push({
      id: `task:${object.id}`,
      prompt: `task ${bareId(object.id)} is proposed by ${by} and waits for you: ${task.title}`,
      object: { type: "task", id: object.id },
      // A person who added the task knows of it; the lead is told of dev's own.
      announce: task.openedBy === "dev",
    });
  }
  for (const [planKey, draft] of drafts) {
    items.push({
      id: `plan:${planKey}`,
      prompt: `plan ${bareId(planKey)} is a draft whose tasks wait for you: ${draft.titles.join(", ")}; confirm the plan to start them`,
      object: { type: "plan", id: planKey },
      covers: draft.tasks,
      announce: draft.byDev,
    });
  }
  for (const plugin of missingPlugins(ctx.loaded)) items.push(pluginItem(plugin));
  return items;
}
