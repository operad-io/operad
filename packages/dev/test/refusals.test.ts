import { afterAll, describe, expect, test } from "bun:test";
import type { StoredObject } from "@operad-io/engine";
import { actions } from "../src/actions.ts";
import { bareId, PLAN_STATES, planData, taskData } from "../src/model.ts";
import {
  PLAN_ACTIONS,
  PLAN_LINES,
  TASK_ACTIONS,
  TASK_LINES,
  TASK_STATES,
  type Facts,
  type Line,
  type PlanActionName,
  type TaskState,
} from "../src/refusals.ts";
import type { RepositoryData } from "../src/model.ts";
import { addPlan, addRepository, addTask, getPlan, getTask } from "../src/service.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const INTERNAL = /\b(phase|graph|node|fact|effect|decide|evolve|runner|backend)s?\b/i;
const FACTS: Facts = {
  id: "T-0001-one",
  plan: { id: "P-0001-work", state: "draft" },
  value: 3,
};

/** Every line a table can say, for every state. */
function sayings(line: Line): string[] {
  if (line.kind === "ok") return line.same === undefined ? [] : [line.same(FACTS)];
  if (line.kind === "done") return [line.say(FACTS)];
  return (["draft", "confirmed", "paused", "finished", "cancelled"] as const).map((state) =>
    line.say({ ...FACTS, plan: { id: "P-0001-work", state } }),
  );
}

describe("the table of refusal lines", () => {
  test("every action the plugin declares has a row for every state", () => {
    for (const action of actions) {
      const table = action.on === "plan" ? PLAN_LINES : TASK_LINES;
      const row = (table as Record<string, Record<string, Line> | undefined>)[action.name];
      expect(row, `${action.name} on ${action.on}`).toBeDefined();
      const states = action.on === "plan" ? PLAN_STATES : TASK_STATES;
      for (const state of states) {
        expect(row?.[state], `${action.name} on ${action.on} in ${state}`).toBeDefined();
      }
    }
    // And the other way: no row for an action that does not exist.
    const declared = (on: string) => actions.filter((a) => a.on === on).map((a) => a.name).sort();
    expect([...PLAN_ACTIONS].map(String).sort()).toEqual(declared("plan"));
    expect([...TASK_ACTIONS].map(String).sort()).toEqual(declared("task"));
  });

  test("every line is one plain sentence with no internal word and no trailing ';'", () => {
    const all: [string, Line][] = [
      ...TASK_ACTIONS.flatMap((a) =>
        TASK_STATES.map((s): [string, Line] => [`${a} ${s}`, TASK_LINES[a][s]]),
      ),
      ...PLAN_ACTIONS.flatMap((a) =>
        PLAN_STATES.map((s): [string, Line] => [`${a} ${s}`, PLAN_LINES[a][s]]),
      ),
    ];
    let seen = 0;
    for (const [where, line] of all) {
      for (const text of sayings(line)) {
        seen += 1;
        expect(text, where).not.toMatch(INTERNAL);
        expect(text, where).not.toMatch(/\n/);
        expect(text.trimEnd(), where).not.toMatch(/;$/);
        expect(text, where).not.toMatch(/needs (proposed|waiting|draft|ready|running)/);
        expect(text, where).toMatch(/^[TP]-0001/);
      }
    }
    expect(seen).toBeGreaterThan(40);
  });
});

/** Every state a task can be in, with a plan state for a proposed one. */
async function world() {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath });
  return { store, repository };
}

async function taskIn(
  store: ReturnType<typeof storeAt>,
  repository: RepositoryData,
  slug: string,
  state: TaskState,
): Promise<StoredObject> {
  const plan = await addPlan(store, { repository, slug: `p-${slug}`, title: "Work" });
  const task = await addTask(store, { plan: plan.id, slug, title: "One" });
  const current = taskData((await getTask(store, task.id)).data);
  const phase = state === "waiting-review" ? "waiting" : state;
  const extra =
    state === "waiting-review"
      ? {
          retryAt: 1,
          attempt: { number: 1, run: "run-1", review: { decision: "unavailable", reason: "busy" } },
        }
      : {};
  await store.put("task", task.id, { ...current, phase, ...extra }, "test:phase");
  return getTask(store, task.id);
}

describe("the table agrees with what each action does", () => {
  test("a task action is offered, settled or refused exactly as its line says", async () => {
    const { store, repository } = await world();
    const env = { store };
    for (const name of TASK_ACTIONS) {
      const definition = actions.find((a) => a.name === name && a.on === "task");
      expect(definition).toBeDefined();
      for (const state of TASK_STATES) {
        const object = await taskIn(store, repository, `${name}-${state}`.slice(0, 20), state);
        const where = `${name} on a task in ${state}`;
        const line = TASK_LINES[name][state];
        let offered = await definition?.when(object.data, env);
        let refusal = await definition?.why?.(object, env);
        if (name === "confirm" && state === "proposed") {
          // The plan is a draft: not offered, and the refusal sends the person to the plan.
          expect(offered, where).toBe(false);
          expect(refusal, where).toMatch(/is in draft plan P-\d+-p-.*; confirm the plan first \(dev:confirm P-\d+-p-/);
          const planKey = `${taskData(object.data).repository}/${taskData(object.data).plan}`;
          const plan = await getPlan(store, planKey);
          await store.put("plan", plan.id, { ...planData(plan.data), status: "confirmed" }, "test:confirm");
          offered = await definition?.when(object.data, env);
          refusal = await definition?.why?.(object, env);
          expect(offered, where).toBe(true);
          expect(refusal, where).toBeUndefined();
          continue;
        }
        const settled = await definition?.settled?.(object, {}, env);
        expect(offered, where).toBe(line.kind === "ok");
        expect(typeof settled === "string", where).toBe(line.kind === "done");
        expect(typeof refusal === "string", where).toBe(line.kind === "refuse");
        for (const text of [settled, refusal]) {
          if (text === undefined) continue;
          expect(text, where).toMatch(/^T-\d+-/);
          expect(text, where).not.toMatch(INTERNAL);
        }
      }
    }
  });

  test("a plan action is offered, settled or refused exactly as its line says", async () => {
    const { store, repository } = await world();
    const env = { store };
    for (const name of PLAN_ACTIONS) {
      const definition = actions.find((a) => a.name === name && a.on === "plan");
      expect(definition).toBeDefined();
      for (const state of PLAN_STATES) {
        const plan = await addPlan(store, { repository, slug: `${name}-${state}`.slice(0, 20), title: "Work" });
        await addTask(store, { plan: plan.id, slug: "t", title: "T" });
        const data = planData((await getPlan(store, plan.id)).data);
        const status = state === "finished" ? "confirmed" : state;
        const counts =
          state === "finished" ? { taskCount: 1, mergedCount: 1, cancelledCount: 0 } : {};
        await store.put("plan", plan.id, { ...data, status, ...counts }, "test:state");
        const object = await getPlan(store, plan.id);
        const where = `${name} on a plan in ${state}`;
        const line = PLAN_LINES[name][state];
        const args = name === "auto" ? { level: "merge" } : name === "priority" ? { level: "P9x" } : { count: 99 };
        const offered = await definition?.when(object.data, env);
        const settled = await definition?.settled?.(object, args, env);
        const refusal = await definition?.why?.(object, env);
        expect(offered, where).toBe(line.kind === "ok");
        // A value that differs from the plan's own is never "already set".
        expect(typeof settled === "string", where).toBe(line.kind === "done");
        expect(typeof refusal === "string", where).toBe(line.kind === "refuse");
        for (const text of [settled, refusal]) {
          if (text === undefined) continue;
          expect(text, where).toMatch(/^P-\d+-/);
          expect(text, where).not.toMatch(INTERNAL);
        }
      }
    }
  });

  test("the results that are already true, each in its own words", async () => {
    const { store, repository } = await world();
    const env = { store };
    const settle = async (name: string, on: "plan" | "task", object: StoredObject, args: unknown = {}) =>
      actions.find((a) => a.name === name && a.on === on)?.settled?.(object, args, env);

    const merged = await taskIn(store, repository, "m", "merged");
    expect(await settle("merge", "task", merged)).toBe(`${bareId(merged.id)} is already merged; nothing to do`);
    const cancelled = await taskIn(store, repository, "c", "cancelled");
    expect(await settle("cancel", "task", cancelled)).toBe(`${bareId(cancelled.id)} is already cancelled; nothing to do`);
    const ready = await taskIn(store, repository, "r", "ready");
    expect(await settle("confirm", "task", ready)).toBe(`${bareId(ready.id)} is already ready; nothing to do`);

    const plan = await addPlan(store, { repository, slug: "pc", title: "Work" });
    const draft = await getPlan(store, plan.id);
    expect(await settle("confirm", "plan", draft)).toBeUndefined();
    await store.put("plan", plan.id, { ...planData(draft.data), status: "confirmed" }, "test:confirm");
    expect(await settle("confirm", "plan", await getPlan(store, plan.id))).toBe(
      `${bareId(plan.id)} is already confirmed; nothing to do`,
    );
    await store.put("plan", plan.id, { ...planData(draft.data), status: "cancelled" }, "test:cancel");
    expect(await settle("cancel", "plan", await getPlan(store, plan.id))).toBe(
      `${bareId(plan.id)} is already cancelled; nothing to do`,
    );
    // The other states of those objects have something to do.
    expect(await settle("merge", "task", ready)).toBeUndefined();
    expect(await settle("cancel", "task", ready)).toBeUndefined();
  });

  test("a value a plan already has is settled, and another value is not", async () => {
    const { store, repository } = await world();
    const env = { store };
    const plan = await addPlan(store, { repository, slug: "same", title: "Work" });
    const object = await getPlan(store, plan.id);
    const data = planData(object.data);
    const settle = (name: PlanActionName, args: unknown) =>
      actions.find((a) => a.name === name && a.on === "plan")?.settled?.(object, args, env);
    expect(await settle("auto", { level: data.auto })).toBe(
      `${bareId(plan.id)} already has auto ${data.auto}; nothing to do`,
    );
    expect(await settle("auto", { level: data.auto === "off" ? "run" : "off" })).toBeUndefined();
    expect(await settle("priority", { level: data.priority })).toBe(
      `${bareId(plan.id)} already has priority ${data.priority}; nothing to do`,
    );
    expect(await settle("concurrency", { count: data.concurrency })).toBe(
      `${bareId(plan.id)} already has concurrency ${data.concurrency}; nothing to do`,
    );
    expect(await settle("concurrency", { count: data.concurrency + 1 })).toBeUndefined();
    expect(await settle("auto", "not an object")).toBeUndefined();
  });
});
