import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandContext } from "@operad-io/engine";
import { commands } from "../src/commands.ts";
import { recordRerunPasses } from "../src/reruns.ts";
import { failureExcerpt, flakyTasksByName, flakyTestHooks, trackFlakyTests } from "../src/flaky.ts";
import { appendChange, bareId, changeClock, listAll, repositoryData, taskData, type RepositoryData } from "../src/model.ts";
import {
  addPlan,
  addRepository,
  addTask,
  cancelTask,
  confirmPlan,
  setTaskPhase,
} from "../src/service.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  flakyTestHooks.beforePropose = undefined;
  changeClock.now = () => Date.now();
});
guardLockHandles();

const CHILD = fileURLToPath(new URL("./fixtures/flaky-crash-child.ts", import.meta.url));
const TEST = "widget > keeps its shape";
const FILE = "packages/widget/test/shape.test.ts";

function logWith(name: string, before: readonly string[] = ["some output"]): string {
  return [
    `${FILE}:`,
    ...before,
    `(fail) ${name} [3.20ms]`,
    "===== rerun of failed test: " + name + " =====",
    `${FILE}:`,
    `(pass) ${name} [1.00ms]`,
    "",
  ].join("\n");
}

async function setup(withPlan: boolean) {
  const root = await tempRoot();
  const store = storeAt(root);
  const path = await makeGitRepository(root);
  const repository: RepositoryData = await addRepository(store, { path, name: "demo" });
  mkdirSync(join(path, "scripts"), { recursive: true });
  writeFileSync(join(path, "scripts", "stress.sh"), "#!/usr/bin/env bash\n");
  let planId: string | undefined;
  if (withPlan) {
    const plan = await addPlan(store, { repository, slug: "main", title: "Main" });
    await addTask(store, { plan: plan.id, slug: "first", title: "First" });
    await confirmPlan(store, plan.id);
    planId = plan.id;
  }
  const notices: string[] = [];
  const track = async (
    taskId: string,
    log: string,
    threshold = 2,
    names: readonly string[] = [TEST],
    secrets: readonly string[] = [],
  ) => {
    const logPath = join(root, `${taskId}.log`);
    writeFileSync(logPath, log);
    const notice = await trackFlakyTests({ store, repository, taskId, names, log: logPath, threshold, secrets });
    if (notice !== undefined) notices.push(notice);
  };
  const flaky = async () =>
    (await listAll(store, "task")).filter((object) => taskData(object.data).title.startsWith("Fix the flaky test"));
  return { root, store, path, repository, planId, notices, track, flaky };
}

describe("a flaky test proposes a task", () => {
  test("the threshold proposes exactly one task with the expected brief", async () => {
    const s = await setup(true);
    let now = Date.parse("2026-11-08T10:00:00Z");
    changeClock.now = () => (now += 60_000);
    await s.track("T-0001-a", logWith(TEST, ["old line"]));
    expect(await s.flaky()).toHaveLength(0);
    await s.track("T-0002-b", logWith(TEST, ["x1", "x2"]));
    const tasks = await s.flaky();
    expect(tasks).toHaveLength(1);
    const task = taskData(tasks[0]?.data ?? {});
    expect(bareId(tasks[0]?.id ?? "")).toMatch(/^T-\d{4}-flaky-widget-keeps-its-shape$/);
    expect(task.title).toBe(`Fix the flaky test: ${TEST}`);
    expect(task.area).toBe("widget");
    expect(task.phase).toBe("proposed");
    expect(task.plan).toBe(bareId(s.planId ?? ""));
    expect(task.brief).toContain(`\`${TEST}\` in \`${FILE}\``);
    expect(task.brief).toContain("2 times");
    expect(task.brief).toContain("- T-0001-a at 2026-11-08T10:01:00.000Z");
    expect(task.brief).toContain("- T-0002-b at 2026-11-08T10:02:00.000Z");
    expect(task.brief).toContain(`old line\n(fail) ${TEST} [3.20ms]`);
    expect(task.brief).toContain(`x1\nx2\n(fail) ${TEST} [3.20ms]`);
    expect(task.brief).toContain(`bash scripts/stress.sh --runs 200 --load 2 -t 'widget keeps its shape' '${FILE}'`);
    expect(task.brief).toContain("Never raise a timeout or add a retry inside a test");
  });

  test("without scripts/stress.sh the brief gives the bun rerun-each form", async () => {
    const s = await setup(true);
    const { rmSync } = await import("node:fs");
    rmSync(join(s.path, "scripts"), { recursive: true });
    await s.track("T-0001-a", logWith(TEST), 1);
    const brief = taskData((await s.flaky())[0]?.data ?? {}).brief;
    expect(brief).toContain("bun test --rerun-each 200 -t");
    expect(brief).not.toContain("stress.sh --runs 200 --load 2 -t");
  });

  test("the failure excerpt holds the (fail) line and up to 30 lines before it", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const found = failureExcerpt(logWith(TEST, before), TEST);
    expect(found.file).toBe(FILE);
    const lines = found.excerpt.split("\n");
    expect(lines).toHaveLength(31);
    expect(lines[0]).toBe("line 10");
    expect(lines[30]).toBe(`(fail) ${TEST} [3.20ms]`);
  });

  test("a second crossing while the task is open proposes none", async () => {
    const s = await setup(true);
    await s.track("T-0001-a", logWith(TEST));
    await s.track("T-0002-b", logWith(TEST));
    await s.track("T-0003-c", logWith(TEST));
    await s.track("T-0004-d", logWith(TEST));
    expect(await s.flaky()).toHaveLength(1);
    const tasks = await flakyTasksByName(s.store);
    expect(tasks.get(TEST)).toMatch(/flaky-widget/);
  });

  test("an open task that already names the test stops a proposal", async () => {
    const s = await setup(true);
    await addTask(s.store, { plan: s.planId ?? "", slug: "mine", title: `Look at ${TEST}` });
    await s.track("T-0001-a", logWith(TEST), 1);
    expect(await s.flaky()).toHaveLength(0);
    // The open task is the one that counts: reruns shows it, and its end restarts the count.
    const mine = (await listAll(s.store, "task")).find((object) => taskData(object.data).title.startsWith("Look at"));
    expect((await flakyTasksByName(s.store)).get(TEST)).toBe(bareId(mine?.id ?? ""));
    await setTaskPhase(s.store, mine?.id ?? "", "merged");
    await s.track("T-0002-b", logWith(TEST), 2);
    expect(await s.flaky()).toHaveLength(0);
    await s.track("T-0003-c", logWith(TEST), 2);
    expect(await s.flaky()).toHaveLength(1);
  });

  test("a task whose Changes only say the test passed on rerun does not stop the proposal", async () => {
    const s = await setup(true);
    const other = await addTask(s.store, { plan: s.planId ?? "", slug: "other", title: "Other work" });
    const data = taskData(other.data);
    await s.store.put("task", other.id, { ...data, brief: appendChange(data.brief, `passed on rerun: ${TEST}`) }, "test");
    await s.track("T-0001-a", logWith(TEST), 1);
    expect(await s.flaky()).toHaveLength(1);
  });

  test("secrets in a failure excerpt are masked in the record and the brief", async () => {
    const s = await setup(true);
    const leaky = logWith(TEST, ["token=hunter2hunter2 seen", "plain"]);
    await s.track("T-0001-a", leaky, 1, [TEST], ["hunter2hunter2"]);
    const brief = taskData((await s.flaky())[0]?.data ?? {}).brief;
    expect(brief).not.toContain("hunter2hunter2");
    expect(brief).toContain("token=*** seen");
    const records = await listAll(s.store, "flaky-test");
    expect(JSON.stringify(records.map((record) => record.data))).not.toContain("hunter2hunter2");
  });

  test("a failure after an earlier command's rerun keeps its excerpt and file", async () => {
    const s = await setup(true);
    const log = [
      "===== rerun of failed test: first one =====",
      "(pass) first one [1ms]",
      logWith(TEST, ["later output"]),
    ].join("\n");
    await s.track("T-0001-a", log, 1);
    const task = taskData((await s.flaky())[0]?.data ?? {});
    expect(task.area).toBe("widget");
    expect(task.brief).toContain("later output");
    expect(task.brief).toContain(`'${FILE}'`);
  });

  test("after a merge the count restarts at 0", async () => {
    const s = await setup(true);
    await s.track("T-0001-a", logWith(TEST));
    await s.track("T-0002-b", logWith(TEST));
    const first = (await s.flaky())[0];
    await setTaskPhase(s.store, first?.id ?? "", "merged");
    await s.track("T-0003-c", logWith(TEST));
    expect(await s.flaky()).toHaveLength(1);
    expect((await flakyTasksByName(s.store)).size).toBe(0);
    await s.track("T-0004-d", logWith(TEST));
    expect(await s.flaky()).toHaveLength(2);
  });

  test("a cancelled task also restarts the count", async () => {
    const s = await setup(true);
    await s.track("T-0001-a", logWith(TEST), 1);
    const first = (await s.flaky())[0];
    await cancelTask(s.store, first?.id ?? "", {});
    await s.track("T-0002-b", logWith(TEST), 1);
    expect(await s.flaky()).toHaveLength(2);
  });

  test("flakyTask 0 proposes nothing", async () => {
    const s = await setup(true);
    await s.track("T-0001-a", logWith(TEST), 0);
    await s.track("T-0002-b", logWith(TEST), 0);
    expect(await s.flaky()).toHaveLength(0);
  });

  test("a repository without a confirmed plan records a notice and proposes nothing", async () => {
    const s = await setup(false);
    await addPlan(s.store, { repository: s.repository, slug: "draft", title: "Draft" });
    await s.track("T-0001-a", logWith(TEST));
    await s.track("T-0002-b", logWith(TEST));
    await s.track("T-0003-c", logWith("other"), 2, ["other"]);
    expect(await s.flaky()).toHaveLength(0);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain(`"${TEST}" passed on rerun 2 times`);
    expect(s.notices[0]).toContain("no confirmed plan");
  });

  test("a finished plan is passed over for an older unfinished one", async () => {
    const s = await setup(true);
    const newer = await addPlan(s.store, { repository: s.repository, slug: "newer", title: "Newer" });
    const only = await addTask(s.store, { plan: newer.id, slug: "only", title: "Only" });
    await confirmPlan(s.store, newer.id);
    await setTaskPhase(s.store, only.id, "merged");
    await s.track("T-0001-a", logWith(TEST), 1);
    const task = taskData((await s.flaky())[0]?.data ?? {});
    expect(task.plan).toBe(bareId(s.planId ?? ""));
  });

  test("operad reruns shows the task beside its test while it is open", async () => {
    const s = await setup(true);
    await recordRerunPasses(s.store, [TEST, TEST, "other"]);
    await s.track("T-0001-a", logWith(TEST), 1);
    const reruns = commands.find((command) => command.name === "reruns");
    const context = { store: s.store } as unknown as CommandContext;
    const shown = String((await reruns?.run(context, [])) ?? "");
    const task = bareId((await s.flaky())[0]?.id ?? "");
    expect(shown.split("\n")).toEqual([`2\t${TEST}\t${task}`, "1\tother"]);
    await setTaskPhase(s.store, (await s.flaky())[0]?.id ?? "", "merged");
    expect(await reruns?.run(context, [])).toBe(`2\t${TEST}\n1\tother`);
  });

  test("a crash between the decision and the proposal still proposes exactly one task", async () => {
    const s = await setup(true);
    const logPath = join(s.root, "child.log");
    writeFileSync(logPath, logWith(TEST));
    const child = Bun.spawn({
      cmd: [process.execPath, CHILD, join(s.root, "store"), "demo", TEST, logPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await s.flaky()).toHaveLength(0);
    // A later pass on rerun, of this or any test, finishes the decision once.
    await s.track("T-0002-b", logWith(TEST), 1);
    await s.track("T-0003-c", logWith(TEST), 1);
    const tasks = await s.flaky();
    expect(tasks).toHaveLength(1);
    expect(taskData(tasks[0]?.data ?? {}).brief).toContain("T-0001-child");
    expect(repositoryData(s.repository)).toBeDefined();
  });
});
