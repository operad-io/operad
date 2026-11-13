import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createViews,
  listPending,
  openLog,
  PluginRegistry,
  type PendingItem,
} from "@operad-io/engine";
import plugin from "../../src/index.ts";
import { trackFlakyTests } from "../../src/flaky.ts";
import { bareId, listAll, planData, taskData } from "../../src/model.ts";
import {
  addPlan,
  addRepository,
  addTask,
  cancelTask,
  confirmPlan,
  confirmTask,
  setTaskPhase,
} from "../../src/service.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const TEST = "widget > keeps its shape";
const FILE = "packages/widget/test/shape.test.ts";

async function setup() {
  const root = await tempRoot();
  const path = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path, name: "demo" });
  const plan = await addPlan(store, { repository, slug: "main", title: "Main" });
  await addTask(store, { plan: plan.id, slug: "first", title: "First" });
  await confirmPlan(store, plan.id);
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: path,
    store,
    storeRoot: store.root,
  });
  const log = openLog({ backend: "sqlite", path: join(store.root, "log", "log.sqlite") });
  const views = createViews({ registry, store, log, cwd: path });
  const items = (): Promise<readonly PendingItem[]> => listPending(log, registry, undefined, views);
  const proposed = async () =>
    (await items()).filter((item) => item.kind === "standing" && item.object?.startsWith("task:"));
  const planRow = async () => (await views.get(`plan:${plan.id}`)).row;
  return { root, path, store, repository, plan, registry, log, views, items, proposed, planRow };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function flakyTask(s: Setup): Promise<string> {
  const logPath = join(s.root, "flaky.log");
  writeFileSync(
    logPath,
    [`${FILE}:`, `(fail) ${TEST} [3.20ms]`, `===== rerun of failed test: ${TEST} =====`, `${FILE}:`, `(pass) ${TEST} [1.00ms]`, ""].join("\n"),
  );
  await trackFlakyTests({
    store: s.store,
    repository: s.repository,
    taskId: "T-0001-a",
    names: [TEST],
    log: logPath,
    threshold: 1,
    secrets: [],
    flakyPlan: undefined,
  });
  const found = (await listAll(s.store, "task")).filter((object) =>
    taskData(object.data).title.startsWith("Fix the flaky test"),
  );
  expect(found).toHaveLength(1);
  return found[0]?.id ?? "";
}

describe("a proposed task is pending", () => {
  test("a task added by `task add` is pending with confirm and cancel, drawn waiting, and leaves on confirm", async () => {
    const s = await setup();
    expect(await s.proposed()).toEqual([]);
    expect((await s.planRow()).mark).toBe("todo");

    const task = await addTask(s.store, { plan: s.plan.id, slug: "second", title: "Second" });
    const items = await s.proposed();
    expect(items).toHaveLength(1);
    expect(items[0]?.object).toBe(`task:${task.id}`);
    expect(items[0]?.actions).toEqual([
      { plugin: "dev", action: "confirm" },
      { plugin: "dev", action: "cancel" },
    ]);
    // The lead added it, so no channel block is due for it.
    expect(items[0]?.announce).toBe(false);
    expect(items[0]?.row?.mark).toBe("proposed");
    expect(items[0]?.row?.waiting).toBe(true);
    const row = (await s.views.get(`task:${task.id}`)).row;
    expect(row.waiting).toBe(true);
    expect(row.mark).toBe("proposed");

    const plan = await s.planRow();
    expect(plan.mark).toBe("waiting");
    expect(plan.note).toContain("1 waiting");

    await confirmTask(s.store, task.id);
    expect(await s.proposed()).toEqual([]);
    const after = await s.planRow();
    expect(after.mark).toBe("todo");
    expect(after.note).not.toContain("waiting");
    expect(planData((await s.store.get("plan", s.plan.id))?.data ?? {}).waitingCount).toBe(0);
  });

  test("a task opened by the flaky detector is pending and leaves on cancel", async () => {
    const s = await setup();
    const id = await flakyTask(s);
    const items = await s.proposed();
    expect(items.map((item) => item.object)).toEqual([`task:${id}`]);
    expect(items[0]?.actions).toEqual([
      { plugin: "dev", action: "confirm" },
      { plugin: "dev", action: "cancel" },
    ]);
    expect(items[0]?.prompt).toContain("proposed by dev");
    // dev opened it, so the channel tells the lead.
    expect(items[0]?.announce).toBeUndefined();
    const flakyPlan = (await s.views.get(`plan:${taskData((await s.store.get("task", id))?.data ?? {}).repository}/${taskData((await s.store.get("task", id))?.data ?? {}).plan}`)).row;
    expect(flakyPlan.mark).toBe("waiting");
    await cancelTask(s.store, id);
    expect(await s.proposed()).toEqual([]);
    expect((await s.views.get(`plan:${taskData((await s.store.get("task", id))?.data ?? {}).repository}/${taskData((await s.store.get("task", id))?.data ?? {}).plan}`)).row.waiting).toBe(false);
  });

  test("a task waiting at a stop also turns the plan row waiting", async () => {
    const s = await setup();
    const first = (await listAll(s.store, "task"))[0];
    await setTaskPhase(s.store, first?.id ?? "", "waiting");
    expect((await s.planRow()).mark).toBe("waiting");
    await setTaskPhase(s.store, first?.id ?? "", "running");
    expect((await s.planRow()).mark).toBe("running");
  });

  test("a draft plan keeps its own mark and note", async () => {
    const s = await setup();
    const draft = await addPlan(s.store, { repository: s.repository, slug: "draft", title: "Draft" });
    await addTask(s.store, { plan: draft.id, slug: "one", title: "One" });
    const row = (await s.views.get(`plan:${draft.id}`)).row;
    expect(row.mark).toBe("proposed");
    expect(row.note).not.toContain("waiting");
    // Its tasks wait with it: one item for the plan, which confirm and cancel act on.
    const items = await s.proposed();
    expect(items).toHaveLength(0);
    const planItems = (await s.items()).filter((item) => item.object === `plan:${draft.id}`);
    expect(planItems).toHaveLength(1);
    expect(planItems[0]?.actions).toContainEqual({ plugin: "dev", action: "confirm" });
    expect(planItems[0]?.actions).toContainEqual({ plugin: "dev", action: "cancel" });
    expect(planItems[0]?.covers).toHaveLength(1);
    await confirmPlan(s.store, draft.id);
    expect((await s.items()).filter((item) => item.object === `plan:${draft.id}`)).toEqual([]);
    expect(bareId(draft.id)).toBeTruthy();
  });
});
