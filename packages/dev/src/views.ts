/** How a plan and a task appear in a list and a detail page. */

import type {
  ObjectRow,
  ObjectViews,
  StoredObject,
  ViewSection,
} from "@operad-io/engine";
import {
  bareId,
  hasRework,
  listAll,
  planData,
  planNote,
  planState,
  splitBrief,
  taskData,
  type TaskData,
} from "./model.ts";

function costNote(cost: unknown): string | undefined {
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return `$${cost.toFixed(2)}`;
  }
  if (typeof cost === "string" && cost.trim().length > 0) return cost.trim();
  return undefined;
}

/**
 * The short note a waiting task shows. A refused push leaves the integration
 * message that names the remote, the branch and git's own words; the person
 * sees it next to the task before deciding what to do.
 */
function waitNote(task: TaskData): string | undefined {
  if (task.phase !== "waiting") return undefined;
  const integration = task.attempt?.integration;
  if (integration === undefined || integration === null) return undefined;
  if (integration.result !== "failed") return undefined;
  const message = integration.message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : undefined;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tasksTable(
  tasks: readonly StoredObject[],
): string {
  if (tasks.length === 0) return "_No tasks._";
  const lines = [
    "| id | title | phase | after |",
    "| --- | --- | --- | --- |",
  ];
  for (const object of tasks) {
    const data = taskData(object.data);
    const after = data.after.length === 0 ? "-" : data.after.join(", ");
    lines.push(
      `| ${cell(bareId(object.id))} | ${cell(data.title)} | ${cell(data.phase)} | ${cell(after)} |`,
    );
  }
  return lines.join("\n");
}

export const planViews: ObjectViews = {
  row(object: StoredObject): ObjectRow {
    const plan = planData(object.data);
    return {
      id: bareId(object.id),
      title: plan.title,
      state: planState(plan),
      note: planNote(plan),
    };
  },

  sections(): readonly ViewSection[] {
    return [
      { id: "request", title: "Request" },
      { id: "tasks", title: "Tasks" },
    ];
  },

  async load(ctx, object, sectionId) {
    const plan = planData(object.data);
    if (sectionId === "request") {
      return { markdown: plan.request };
    }
    if (sectionId === "tasks") {
      const tasks = (await listAll(ctx.store, "task"))
        .filter((candidate) => {
          const task = taskData(candidate.data);
          return (
            task.repository === plan.repository &&
            task.plan === bareId(object.id)
          );
        })
        .sort((left, right) =>
          bareId(left.id).localeCompare(bareId(right.id)),
        );
      return { markdown: tasksTable(tasks) };
    }
    return { markdown: "" };
  },
};

export const taskViews: ObjectViews = {
  row(object: StoredObject): ObjectRow {
    const task = taskData(object.data);
    const note = waitNote(task) ?? costNote(task.cost);
    return {
      id: bareId(object.id),
      title: task.title,
      state: task.phase,
      ...(note === undefined ? {} : { note }),
    };
  },

  sections(object: StoredObject): readonly ViewSection[] {
    const task = taskData(object.data);
    const sections: ViewSection[] = [{ id: "brief", title: "Brief" }];
    if (hasRework(task.brief)) {
      sections.push({ id: "rework", title: "Rework" });
    }
    sections.push({ id: "changes", title: "Changes" });
    return sections;
  },

  load(_ctx, object, sectionId) {
    const task = taskData(object.data);
    const parts = splitBrief(task.brief);
    if (sectionId === "brief") return { markdown: parts.body };
    if (sectionId === "rework") return { markdown: parts.reworks };
    if (sectionId === "changes") return { markdown: parts.changes };
    return { markdown: "" };
  },
};
