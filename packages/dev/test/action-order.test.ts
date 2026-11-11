import { afterAll, describe, expect, test } from "bun:test";
import { PluginRegistry, Views, type ObjectData } from "@operad-io/engine";
import plugin from "../src/index.ts";
import { addPlan, addRepository, addTask, getPlan, getTask } from "../src/service.ts";
import { planData, planState, taskData } from "../src/model.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

/** The actions that end the object they run on. */
const ENDING = ["cancel"];

async function setup() {
  const root = await tempRoot();
  const store = storeAt(root);
  const registry = new PluginRegistry([plugin], { store, storeRoot: store.root });
  const repository = await addRepository(store, { path: await makeGitRepository(root) });
  const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
  const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
  return { store, registry, plan, task };
}

type Store = Awaited<ReturnType<typeof setup>>["store"];

async function change(store: Store, type: "plan" | "task", id: string, patch: ObjectData) {
  const object = type === "plan" ? await getPlan(store, id) : await getTask(store, id);
  await store.put(type, id, { ...object.data, ...patch }, "test:order");
}

async function order(
  registry: PluginRegistry,
  type: "plan" | "task",
  id: string,
  store: Store,
): Promise<string[]> {
  const object = type === "plan" ? await getPlan(store, id) : await getTask(store, id);
  const [entry] = await registry.pending([{ runId: "run-1", object: { type, id } }]);
  expect(object.id).toBe(id);
  return entry?.actions.map((action) => action.action) ?? [];
}

const verified = { number: 1, run: "run-1", verified: "abc123" };

describe("the order of the actions", () => {
  const plans: [string, ObjectData, string][] = [
    ["draft", { status: "draft", taskCount: 1 }, "confirm"],
    ["confirmed, auto off", { status: "confirmed", taskCount: 1, auto: "off" }, "auto"],
    ["confirmed, auto on", { status: "confirmed", taskCount: 1, auto: "merge" }, "priority"],
    ["paused", { status: "paused", taskCount: 1, auto: "off" }, "auto"],
    [
      "finished",
      { status: "confirmed", taskCount: 1, mergedCount: 1, cancelledCount: 0, auto: "run" },
      "priority",
    ],
  ];
  for (const [name, patch, first] of plans) {
    test(`a ${name} plan offers dev:${first} first`, async () => {
      const { store, registry, plan } = await setup();
      await change(store, "plan", plan.id, patch);
      const names = await order(registry, "plan", plan.id, store);
      expect(names[0]).toBe(first);
      expect(ENDING).not.toContain(names[0] ?? "");
      if (names.includes("cancel")) expect(names.at(-1)).toBe("cancel");
    });
  }

  const tasks: [string, ObjectData, string][] = [
    ["ready", { phase: "ready" }, "pause"],
    ["running", { phase: "running" }, "pause"],
    ["review", { phase: "review" }, "pause"],
    ["waiting, ready to merge", { phase: "waiting", attempt: verified }, "merge"],
    [
      "waiting for a rework answer",
      { phase: "waiting", attempt: { ...verified, rework: { source: "review", streak: 3, result: "ask" } } },
      "rework",
    ],
    ["waiting with no verified commit", { phase: "waiting", attempt: { number: 1, run: "run-1" } }, "rework"],
    ["paused", { phase: "paused" }, "resume"],
  ];
  for (const [name, patch, first] of tasks) {
    test(`a ${name} task offers dev:${first} first`, async () => {
      const { store, registry, task } = await setup();
      await change(store, "task", task.id, patch);
      const names = await order(registry, "task", task.id, store);
      expect(names[0]).toBe(first);
      expect(ENDING).not.toContain(names[0] ?? "");
      if (names.includes("cancel")) expect(names.at(-1)).toBe("cancel");
    });
  }

  test("a proposed task in a confirmed plan offers dev:confirm first", async () => {
    const { store, registry, plan, task } = await setup();
    await change(store, "plan", plan.id, { status: "confirmed" });
    await change(store, "task", task.id, { phase: "proposed" });
    expect(planState(planData((await getPlan(store, plan.id)).data))).toBe("confirmed");
    expect(taskData((await getTask(store, task.id)).data).phase).toBe("proposed");
    const names = await order(registry, "task", task.id, store);
    expect(names).toEqual(["confirm", "cancel"]);
  });

  test("a task whose only offered action is cancel has no main action: cancel is marked as ending", async () => {
    const { store, registry, plan, task } = await setup();
    // Proposed in a draft plan: dev:confirm is withheld, dev:cancel remains.
    await change(store, "task", task.id, { phase: "proposed" });
    const views = new Views({ registry, store, onLog: () => {} });
    const shown = await views.get(`task:${task.id}`);
    expect(shown.actions.map((action) => action.name)).toEqual(["dev:cancel"]);
    expect(shown.actions.every((action) => action.ends === true)).toBe(true);
    expect(plan.id).toBeDefined();
  });

  test("the views list a confirmed plan's actions in the same order, auto first", async () => {
    const { store, registry, plan } = await setup();
    await change(store, "plan", plan.id, { status: "confirmed", taskCount: 1, auto: "off" });
    const views = new Views({ registry, store, onLog: () => {} });
    const shown = await views.get(`plan:${plan.id}`);
    const names = shown.actions.map((action) => action.name);
    expect(names[0]).toBe("dev:auto");
    expect(names.at(-1)).toBe("dev:cancel");
  });

  test("the plan row shows the level dev:auto asks for, which is a pick from the schema", async () => {
    const { store, plan } = await setup();
    await change(store, "plan", plan.id, { auto: "run" });
    const { planViews } = await import("../src/views.ts");
    expect(planViews.row(await getPlan(store, plan.id)).badge).toBe("run");
    const auto = plugin.actions.find((a) => a.name === "auto" && a.on === "plan");
    expect(auto?.args?.properties?.level?.enum).toEqual(["off", "run", "merge"]);
  });
});
