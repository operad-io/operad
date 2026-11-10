/**
 * The plan's review follow-up. Findings that did not fail a review (below the
 * fix level, or moved as pre-existing) are recorded on the task per round.
 * A task that merges with such findings is marked; when the plan has no open
 * task, one task is proposed that collects the findings of every marked task.
 *
 * Collection runs under the repository lock. The proposed task names the tasks
 * it collects, and the marks are written after it, so a crash between the two
 * is finished by the next call, which marks those tasks and proposes nothing.
 */

import type { ObjectStore, StoredObject } from "@operad-io/engine";
import {
  bareId,
  changeClock,
  listAll,
  parseId,
  planData,
  taskData,
  type FollowupMark,
  type ReviewNote,
  type TaskData,
} from "./model.ts";
import { addTaskLocked, getPlan, withRepoLock } from "./service.ts";
import type { DevSettings } from "./settings.ts";

/** Test-only: runs after the follow-up was proposed and before its tasks are marked. */
export const followupTestHooks: {
  afterPropose?: (() => Promise<void> | void) | undefined;
} = {};

const OPEN_PHASES: readonly string[] = ["ready", "running", "review", "waiting"];
const SLUG_MAX = 48;
const SUFFIX = "-followups";

/** The mark a task gets when it merges; empty when it has nothing to collect. */
export function followupMark(
  task: TaskData,
  settings: DevSettings,
): { readonly followups?: FollowupMark } {
  if (!settings.reviewer.followups || task.followupOf !== undefined) return {};
  if (task.followups !== undefined) return {};
  if (!(task.reviewNotes ?? []).some((round) => round.findings.length > 0)) {
    return {};
  }
  return { followups: { mergedAt: changeClock.now(), state: "collect" } };
}

interface Line {
  readonly note: ReviewNote;
  readonly task: string;
  readonly round: number;
}

/** The text without a leading tag that repeats the finding's own level, whitespace collapsed. */
function textOf(note: ReviewNote): string {
  const text = note.summary.replace(/\s+/g, " ").trim();
  const tag = /^\[\s*([^\]]*?)\s*\]\s*/.exec(text);
  if (tag !== null && tag[1]?.toLowerCase() === note.severity.toLowerCase()) {
    return text.slice(tag[0].length);
  }
  return text;
}

/**
 * The findings of the tasks, oldest first. Within one task a finding with the
 * same file, line and text (whitespace collapsed) is kept once, as its newest
 * copy with its own round (the rule of arc's follow-up); findings of
 * different tasks are never merged.
 */
function linesOf(tasks: readonly StoredObject[]): Line[] {
  const lines: Line[] = [];
  for (const object of tasks) {
    const seen = new Map<string, number>();
    for (const round of taskData(object.data).reviewNotes ?? []) {
      for (const note of round.findings) {
        const key = JSON.stringify([note.file, note.line, textOf(note)]);
        const line = { note, task: bareId(object.id), round: round.round };
        const at = seen.get(key);
        if (at !== undefined) {
          lines[at] = line;
          continue;
        }
        seen.set(key, lines.length);
        lines.push(line);
      }
    }
  }
  return lines;
}

/** The brief of the follow-up: findings grouped by task, each with level, place and text. */
export function followupBrief(planId: string, lines: readonly Line[]): string {
  const out: string[] = [
    `The reviews of ${planId}'s tasks found these, none of which failed a review.`,
    "Fix what still applies, and say which of them no longer apply.",
  ];
  for (const task of new Set(lines.map((line) => line.task))) {
    out.push("", `## From ${task}`, "");
    for (const { note, round } of lines.filter((line) => line.task === task)) {
      const where = note.line === null ? note.file : `${note.file}:${note.line}`;
      out.push(`- [${note.severity}] ${where} ${textOf(note)} (round ${round})`);
    }
  }
  return out.join("\n");
}

function slugFor(planSlug: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const tail = n === 1 ? SUFFIX : `${SUFFIX}-${n}`;
    const head = planSlug.slice(0, SLUG_MAX - tail.length).replace(/-+$/, "");
    const slug = `${head}${tail}`;
    if (!taken.has(slug)) return slug;
  }
}

async function markCollected(
  store: ObjectStore,
  repository: string,
  ids: readonly string[],
  tasks: readonly StoredObject[],
): Promise<void> {
  for (const object of tasks) {
    const task = taskData(object.data);
    if (task.repository !== repository) continue;
    if (!ids.includes(bareId(object.id)) || task.followups?.state !== "collect") continue;
    await store.put(
      "task",
      object.id,
      { ...task, followups: { ...task.followups, state: "collected" } },
      "dev:followups",
    );
  }
}

/**
 * Proposes the follow-up of every plan of the repository that has no open
 * task and marked merged tasks. Returns the ids of the tasks it proposed.
 */
export async function collectFollowups(
  store: ObjectStore,
  repository: string,
  settings: DevSettings,
): Promise<string[]> {
  // A tick that has nothing to collect must not wait for the repository lock.
  const pending = (await listAll(store, "task")).some((object) => {
    const task = taskData(object.data);
    return task.repository === repository && task.followups?.state === "collect";
  });
  if (!pending) return [];
  return withRepoLock(store, repository, async (fresh) => {
    // Finish a collection a crash cut short: a follow-up names its tasks.
    const before = (await listAll(store, "task")).filter(
      (object) => taskData(object.data).repository === repository,
    );
    for (const object of before) {
      const of = taskData(object.data).followupOf;
      if (of !== undefined) await markCollected(store, repository, of, before);
    }
    if (!settings.reviewer.followups) return [];

    const proposed: string[] = [];
    for (const planObject of await listAll(store, "plan")) {
      const plan = planData(planObject.data);
      if (plan.repository !== repository || plan.status !== "confirmed") continue;
      const planId = bareId(planObject.id);
      const tasks = (await listAll(store, "task")).filter(
        (object) =>
          taskData(object.data).repository === repository &&
          taskData(object.data).plan === planId,
      );
      if (tasks.some((object) => OPEN_PHASES.includes(taskData(object.data).phase))) continue;
      const marked = tasks
        .filter((object) => {
          const task = taskData(object.data);
          return (
            task.phase === "merged" &&
            task.followupOf === undefined &&
            task.followups?.state === "collect"
          );
        })
        .sort(
          (a, b) =>
            (taskData(a.data).followups?.mergedAt ?? 0) -
              (taskData(b.data).followups?.mergedAt ?? 0) ||
            a.id.localeCompare(b.id),
        );
      const lines = linesOf(marked);
      if (lines.length === 0) continue;
      const taken = new Set<string>();
      for (const object of await listAll(store, "task")) {
        if (taskData(object.data).repository !== repository) continue;
        const slug = parseId(bareId(object.id), "task")?.slug;
        if (slug !== undefined) taken.add(slug);
      }
      const planSlug = parseId(planId, "plan")?.slug ?? "plan";
      const ids = marked.map((object) => bareId(object.id));
      const task = await addTaskLocked(
        store,
        {
          plan: (await getPlan(store, planObject.id)).id,
          slug: slugFor(planSlug, taken),
          title: `Follow-ups from ${planId}'s reviews`,
          brief: followupBrief(planId, lines),
          after: ids,
          followupOf: ids,
          openedBy: "dev",
        },
        fresh,
      );
      await followupTestHooks.afterPropose?.();
      await markCollected(store, repository, ids, marked);
      proposed.push(bareId(task.id));
    }
    return proposed;
  });
}
