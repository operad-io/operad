/**
 * The actions that create the dev plugin's objects: a plan on a repository and
 * a task on a plan. Each runs the command's creation path, so an action and its
 * command cannot drift.
 */

import type {
  ActionArgsSchema,
  ActionTypeDefinition,
  ObjectStore,
  StoredObject,
} from "@operad-io/engine";
import { PLAN_CREATE_TASK_RANK } from "./actions.ts";
import { createPlan, createTask } from "./commands.ts";
import {
  bareId,
  DevError,
  planData,
  repositoryData,
  taskData,
  type RepositoryData,
} from "./model.ts";
import { flowNamesOf } from "./project-flows.ts";
import { readDevSettingsNow } from "./settings.ts";

/** Every flow of a repository, default first, with a fallback when it cannot be read. */
function flowChoices(repository: RepositoryData | undefined): readonly string[] {
  if (repository === undefined) return ["default"];
  try {
    return flowNamesOf(repository.path, readDevSettingsNow(repository.path));
  } catch {
    return ["default"];
  }
}

/** The stored repository, read synchronously so an action's schema can use it. */
function repositoryNow(store: ObjectStore, name: string): RepositoryData | undefined {
  const found = store.get("repo", name);
  if (found instanceof Promise || found === undefined) return undefined;
  return repositoryData(found.data);
}

/** The tasks of a plan, read synchronously so an action's schema can list them. */
function tasksOfPlanNow(
  store: ObjectStore,
  repository: string,
  plan: string,
): readonly StoredObject[] {
  const found: StoredObject[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = store.list("task", cursor === undefined ? {} : { cursor });
    if (page instanceof Promise) return found;
    for (const object of page.objects) {
      const task = taskData(object.data);
      if (task.repository === repository && task.plan === plan) found.push(object);
    }
    if (page.next === undefined) return found;
    cursor = page.next;
  }
}

function planArgs(flows: readonly string[]): ActionArgsSchema {
  const choices = flows.length === 0 ? ["default"] : flows;
  return {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "What the plan is called.",
      },
      slug: {
        type: "string",
        description:
          "The last part of the plan id, 1-48 characters of a-z, 0-9 and -; taken from the title when left out.",
      },
      request: {
        type: "string",
        role: "note",
        description: "The request the plan answers, shown in its Request section.",
      },
      flow: {
        type: "string",
        enum: [...choices],
        default: choices[0],
        description:
          "The flow the plan's tasks start with; the repository's default when left out.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  };
}

function taskArgs(
  flows: readonly string[],
  after: readonly string[],
): ActionArgsSchema {
  const choices = flows.length === 0 ? ["default"] : flows;
  return {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "What the task is called.",
      },
      slug: {
        type: "string",
        description:
          "The last part of the task id, 1-48 characters of a-z, 0-9 and -; taken from the title when left out.",
      },
      brief: {
        type: "string",
        role: "note",
        description: "The brief, the instructions for the worker.",
      },
      flow: {
        type: "string",
        enum: [...choices],
        default: choices[0],
        description:
          "The flow the task starts with; the plan's flow when left out.",
      },
      after: {
        type: "array",
        items: { type: "string", enum: [...after] },
        description:
          "The plan's tasks this task waits for; each must be merged before it starts.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  };
}

const planAction: ActionTypeDefinition = {
  name: "plan",
  on: "repo",
  creates: "plan",
  confirm: true,
  args: planArgs([]),
  argsFor: (object) => planArgs(flowChoices(repositoryData(object.data))),
  when: (state) => repositoryData(state).removed !== true,
  async run(ctx, args) {
    const input = args as {
      readonly title?: string;
      readonly slug?: string;
      readonly request?: string;
      readonly flow?: string;
    };
    const plan = await createPlan(ctx.store, {
      repository: repositoryData(ctx.object.data),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      title: input.title ?? "",
      ...(input.request === undefined ? {} : { request: input.request }),
      ...(input.flow === undefined ? {} : { flow: input.flow }),
    });
    return { text: bareId(plan.id), opens: `plan:${plan.id}` };
  },
};

const taskAction: ActionTypeDefinition = {
  name: "task",
  on: "plan",
  creates: "task",
  rank: () => PLAN_CREATE_TASK_RANK,
  args: taskArgs([], []),
  argsFor: (object, env) => {
    const plan = planData(object.data);
    const id = bareId(object.id);
    const repository = repositoryNow(env.store, plan.repository);
    return taskArgs(
      flowChoices(repository),
      tasksOfPlanNow(env.store, plan.repository, id).map((task) => bareId(task.id)),
    );
  },
  when: () => true,
  async run(ctx, args) {
    const input = args as {
      readonly title?: string;
      readonly slug?: string;
      readonly brief?: string;
      readonly flow?: string;
      readonly after?: readonly string[];
    };
    const plan = planData(ctx.object.data);
    const repository = await ctx.store.get("repo", plan.repository);
    if (repository === undefined) {
      throw new DevError("repo", `no repository "${plan.repository}"`);
    }
    const task = await createTask(ctx.store, {
      repository: repositoryData(repository.data),
      plan: bareId(ctx.object.id),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      title: input.title ?? "",
      ...(input.brief === undefined ? {} : { brief: input.brief }),
      ...(input.flow === undefined ? {} : { flow: input.flow }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    return { text: bareId(task.id), opens: `task:${task.id}` };
  },
};

/** The actions that create a plan and a task. */
export const creationActions: readonly ActionTypeDefinition[] = [planAction, taskAction];
