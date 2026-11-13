import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandContext } from "@operad-io/engine";
import { commands } from "../../src/commands.ts";
import { listRerunCounts, recordRerunPasses } from "../../src/reruns.ts";
import { failureExcerpt, flakyTasksByName, flakyTestHooks, namesTest, trackFlakyTests } from "../../src/flaky.ts";
import { appendChange, bareId, changeClock, listAll, planData, repositoryData, taskData, type RepositoryData } from "../../src/model.ts";
import {
  addPlan,
  addRepository,
  addTask,
  cancelPlan,
  cancelTask,
  confirmPlan,
  setAuto,
  setPriority,
  setTaskPhase,
} from "../../src/service.ts";
import { validateDevSettings, type FailedRerun } from "../../src/settings.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  flakyTestHooks.beforePropose = undefined;
  changeClock.now = () => Date.now();
});
guardLockHandles();

const CHILD = fileURLToPath(new URL("../fixtures/flaky-crash-child.ts", import.meta.url));
const TEST = "widget > keeps its shape";
const FILE = "packages/widget/test/shape.test.ts";
const BUN_MATCH = "^\\(fail\\) (.+?) \\[[0-9.]+m?s\\]$";
const STRESS = "bash scripts/stress.sh --runs <N> --load 2 -t {pattern} {file}";

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
  mkdirSync(join(path, ".operad"), { recursive: true });
  writeFileSync(join(path, ".operad", "flaky.md"), "Stress it first.\n\nNever raise a timeout or add a retry inside a test.\n");
  let planId: string | undefined;
  if (withPlan) {
    const plan = await addPlan(store, { repository, slug: "main", title: "Main" });
    await addTask(store, { plan: plan.id, slug: "first", title: "First" });
    await confirmPlan(store, plan.id);
    planId = plan.id;
  }
  const notices: string[] = [];
  const options: { plan?: string | undefined; failed: { match?: string | undefined; stress?: string | undefined; rule?: string | undefined } } = {
    failed: { stress: STRESS, rule: ".operad/flaky.md" },
  };
  const track = async (
    taskId: string,
    log: string,
    threshold = 2,
    names: readonly string[] = [TEST],
    secrets: readonly string[] = [],
    load: {
      readonly startLoad?: { readonly load1: number; readonly cores: number } | undefined;
      readonly endLoad?: { readonly load1: number; readonly cores: number } | undefined;
      readonly loadLimit?: number | undefined;
    } = {},
  ) => {
    const logPath = join(root, `${taskId}.log`);
    writeFileSync(logPath, log);
    const failed: FailedRerun = { match: options.failed.match ?? BUN_MATCH, rerun: "x {pattern}", max: 10, ...(options.failed.stress === undefined ? {} : { stress: options.failed.stress }), ...(options.failed.rule === undefined ? {} : { rule: options.failed.rule }) };
    const failedBy = new Map(names.map((name) => [name, failed]));
    const notice = await trackFlakyTests({ store, repository, taskId, names, failedBy, log: logPath, threshold, secrets, flakyPlan: options.plan, ...load });
    if (notice !== undefined) notices.push(notice);
  };
  const flaky = async () =>
    (await listAll(store, "task")).filter((object) => taskData(object.data).title.startsWith("Fix the flaky test"));
  return { root, store, path, repository, planId, notices, options, track, flaky };
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
    expect(task.area).toBeUndefined();
    expect(task.phase).toBe("proposed");
    const own = (await listAll(s.store, "plan")).find((object) => bareId(object.id).endsWith("-flaky-tests"));
    expect(task.plan).toBe(bareId(own?.id ?? ""));
    expect(task.brief).toContain(`\`${TEST}\` in \`${FILE}\``);
    expect(task.brief).toContain("2 times");
    expect(task.brief).toContain("- T-0001-a at 2026-11-08T10:01:00.000Z");
    expect(task.brief).toContain("- T-0002-b at 2026-11-08T10:02:00.000Z");
    expect(task.brief).toContain(`old line\n(fail) ${TEST} [3.20ms]`);
    expect(task.brief).toContain(`x1\nx2\n(fail) ${TEST} [3.20ms]`);
    expect(task.brief).toContain(`bash scripts/stress.sh --runs <N> --load 2 -t '^widget keeps its shape$' '${FILE}'`);
    expect(task.brief).toContain("Write the number of runs in place of `<N>`: it follows the rule quoted below.");
    expect(task.brief).not.toContain("--runs 200");
    expect(task.brief).toContain("Never raise a timeout or add a retry inside a test.");
  });

  test("a repository with no bun, no scripts and no CLAUDE.md gets its excerpt, command and rule from its settings", async () => {
    const s = await setup(true);
    s.options.failed = { match: "^FAIL: (.+)$", stress: "run-stress {pattern} {file}", rule: ".operad/flaky.md" };
    const log = ["suite/cart.test.ts:", "noise one", "noise two", "FAIL: cart totals", "after", ""].join("\n");
    await s.track("T-0001-a", log, 1, ["cart totals"]);
    const task = taskData((await s.flaky())[0]?.data ?? {});
    expect(task.area).toBeUndefined();
    expect(task.brief).toContain("noise one\nnoise two\nFAIL: cart totals\n```");
    expect(task.brief).not.toContain("after\n```");
    expect(task.brief).toContain("run-stress '^cart totals$' 'suite/cart.test.ts'");
    expect(task.brief).toContain("Stress it first.\n\nNever raise a timeout");
    expect(task.brief).not.toMatch(/bun |scripts\/stress|CLAUDE\.md/);
  });

  test("failed.stress and failed.rule are read; a rule outside the repository is refused", () => {
    const failed = { match: "^(.+)$", rerun: "t {name}", stress: "s {file}", rule: "docs/flaky.md" };
    const read = validateDevSettings({ name: "x", gate: { commands: [{ run: "t", failed }] } });
    expect(JSON.stringify(read.gate.commands)).toContain('"stress":"s {file}","rule":"docs/flaky.md"');
    for (const rule of ["/etc/passwd", "../x.md", "a/../../x.md"]) {
      expect(() => validateDevSettings({ name: "x", gate: { commands: [{ run: "t", failed: { ...failed, rule } }] } })).toThrow(/failed\.rule/);
    }
    expect(() => validateDevSettings({ name: "x", gate: { commands: [{ run: "t", failed: { ...failed, stress: "" } }] } })).toThrow(/failed\.stress/);
  });

  test("the first match of a repeated failure wins, as the file's own section", () => {
    const log = ["a.test.ts:", "FAIL: t", "b.test.ts:", "summary:", "FAIL: t"].join("\n");
    const found = failureExcerpt(log, "t", "^FAIL: (.+)$");
    expect(found.file).toBe("a.test.ts");
    expect(found.excerpt).toBe("a.test.ts:\nFAIL: t");
  });

  test("without stress the brief has no command and no sentence about <N>", async () => {
    const s = await setup(true);
    s.options.failed = { stress: undefined, rule: ".operad/flaky.md" };
    await s.track("T-0001-a", logWith(TEST), 1);
    const brief = taskData((await s.flaky())[0]?.data ?? {}).brief;
    expect(brief).not.toContain("Reproduce it");
    expect(brief).not.toContain("<N>");
    expect(brief).toContain("Stress it first.");
  });

  test("without rule, or with a missing, empty or outside rule file, the brief quotes the built-in sentence", async () => {
    for (const rule of [undefined, "missing.md", "empty.md", "../outside.md"]) {
      const s = await setup(true);
      writeFileSync(join(s.path, "empty.md"), "  \n");
      writeFileSync(join(s.root, "outside.md"), "OUTSIDE\n");
      s.options.failed = { stress: STRESS, rule };
      await s.track("T-0001-a", logWith(TEST), 1);
      const brief = taskData((await s.flaky())[0]?.data ?? {}).brief;
      expect(brief).toContain("A test that failed and then passed on rerun is a bug until shown otherwise. Do not raise a timeout or add a retry inside a test to make it pass.");
      expect(brief).not.toContain("OUTSIDE");
    }
  });

  test("the failure excerpt holds the (fail) line and up to 30 lines before it", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const found = failureExcerpt(logWith(TEST, before), TEST, BUN_MATCH);
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
    await addTask(s.store, { plan: s.planId ?? "", slug: "mine", title: "Look at the shape", brief: `The flaky one:\n${TEST}\n` });
    await s.track("T-0001-a", logWith(TEST), 1);
    expect(await s.flaky()).toHaveLength(0);
    // The open task is the one that counts: reruns shows it, and its end restarts the count.
    const mine = (await listAll(s.store, "task")).find((object) => taskData(object.data).title === "Look at the shape");
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

  test("an open task naming the test is linked on the first pass, so its end restarts the count", async () => {
    const s = await setup(true);
    const mine = await addTask(s.store, { plan: s.planId ?? "", slug: "mine", title: "Look at the shape", brief: `The flaky one:\n${TEST}\n` });
    await s.track("T-0001-a", logWith(TEST), 2);
    expect((await flakyTasksByName(s.store)).get(TEST)).toBe(bareId(mine.id));
    await setTaskPhase(s.store, mine.id, "merged");
    await s.track("T-0002-b", logWith(TEST), 2);
    expect(await s.flaky()).toHaveLength(0);
    await s.track("T-0003-c", logWith(TEST), 2);
    expect(await s.flaky()).toHaveLength(1);
  });

  test("an unrelated open task that only contains a short test name is not its task", async () => {
    const s = await setup(true);
    await addTask(s.store, { plan: s.planId ?? "", slug: "retry", title: "Make the retry works" });
    await s.track("T-0001-a", logWith("works"), 1, ["works"]);
    expect(await s.flaky()).toHaveLength(1);
    expect((await flakyTasksByName(s.store)).get("works")).toMatch(/flaky-works/);
  });

  test("which open task names a test", () => {
    const cases: readonly (readonly [string, string, string, boolean])[] = [
      ["its exact flaky title", `Fix the flaky test: ${TEST}`, "", true],
      ["a title that only contains the name", `Look at ${TEST}`, "", false],
      ["a title with a longer name after the prefix", `Fix the flaky test: ${TEST} again`, "", false],
      ["a brief line that is exactly the name", "Other", `Intro\n  ${TEST}  \nEnd`, true],
      ["a brief sentence that contains the name", "Other", `Please look at ${TEST} soon`, false],
      ["the name in backticks", "Other", `The test \`${TEST}\` is slow`, false],
      ["the name inside a fenced block", "Other", `\`\`\`\n${TEST}\n\`\`\``, false],
      ["the name inside a quote", "Other", `> ${TEST}`, false],
      ["the name's (fail) line in an excerpt", "Other", `\`\`\`\n(fail) ${TEST} [3.20ms]\n\`\`\``, false],
      ["a one-word name in a sentence", "Make the retry works", "it works", false],
    ];
    for (const [label, title, brief, expected] of cases) {
      const name = label === "a one-word name in a sentence" ? "works" : TEST;
      expect([label, namesTest(title, brief, name)]).toEqual([label, expected]);
    }
  });

  test("two long names that share their first 120 characters each get their own task with the full name", async () => {
    const s = await setup(true);
    const prefix = "long suite > ".padEnd(130, "x");
    const first = `${prefix} > first`;
    const second = `${prefix} > second`;
    await s.track("T-0001-a", logWith(first), 1, [first, second]);
    const titles = (await s.flaky()).map((object) => taskData(object.data).title).sort();
    expect(titles).toEqual([`Fix the flaky test: ${first}`, `Fix the flaky test: ${second}`]);
    const tasks = await flakyTasksByName(s.store);
    expect(tasks.get(first)).not.toBe(tasks.get(second));
  });

  test("a brief that quotes another test's (fail) line does not link that test", async () => {
    const s = await setup(true);
    const log = [`${FILE}:`, "(fail) beta > two [2ms]", "some output", logWith("alpha > one")].join("\n");
    await s.track("T-0001-a", log, 1, ["alpha > one", "beta > two"]);
    const titles = (await s.flaky()).map((object) => taskData(object.data).title).sort();
    expect(titles).toEqual(["Fix the flaky test: alpha > one", "Fix the flaky test: beta > two"]);
    const tasks = await flakyTasksByName(s.store);
    expect(tasks.get("alpha > one")).not.toBe(tasks.get("beta > two"));
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

  test("a repository without any plan gets the flaky-tests plan, once, at the default level", async () => {
    const s = await setup(false);
    await s.track("T-0001-a", logWith(TEST), 1);
    await s.track("T-0002-b", logWith("other"), 1, ["other"]);
    const plans = await listAll(s.store, "plan");
    expect(plans).toHaveLength(1);
    const plan = planData(plans[0]?.data ?? {});
    expect(bareId(plans[0]?.id ?? "")).toMatch(/^P-\d{4}-flaky-tests$/);
    expect([plan.title, plan.status, plan.auto, plan.priority]).toEqual(["Flaky tests", "confirmed", "off", "P3"]);
    expect(await s.flaky()).toHaveLength(2);
    expect(s.notices).toEqual([]);
  });

  test("the flaky-tests plan takes the auto level and priority of the newest confirmed plan", async () => {
    const s = await setup(true);
    await setAuto(s.store, s.planId ?? "", "merge");
    await setPriority(s.store, s.planId ?? "", "P1");
    await s.track("T-0001-a", logWith(TEST), 1);
    const own = (await listAll(s.store, "plan")).find((object) => bareId(object.id).endsWith("-flaky-tests"));
    const plan = planData(own?.data ?? {});
    expect([plan.auto, plan.priority]).toEqual(["merge", "P1"]);
    expect(taskData((await s.flaky())[0]?.data ?? {}).plan).toBe(bareId(own?.id ?? ""));
  });

  test("check.flakyPlan names the plan the tasks go into", async () => {
    const s = await setup(true);
    s.options.plan = bareId(s.planId ?? "");
    await s.track("T-0001-a", logWith(TEST), 1);
    expect(taskData((await s.flaky())[0]?.data ?? {}).plan).toBe(bareId(s.planId ?? ""));
    expect(await listAll(s.store, "plan")).toHaveLength(1);
  });

  test("a finished or cancelled flakyPlan, or one that does not exist, falls back to flaky-tests, made once", async () => {
    const s = await setup(true);
    const done = await addPlan(s.store, { repository: s.repository, slug: "done", title: "Done" });
    const only = await addTask(s.store, { plan: done.id, slug: "only", title: "Only" });
    await confirmPlan(s.store, done.id);
    await setTaskPhase(s.store, only.id, "merged");
    s.options.plan = bareId(done.id);
    await s.track("T-0001-a", logWith(TEST), 1);
    s.options.plan = "P-9999-missing";
    await s.track("T-0002-b", logWith("other"), 1, ["other"]);
    const flakyPlans = (await listAll(s.store, "plan")).filter((object) => bareId(object.id).endsWith("-flaky-tests"));
    expect(flakyPlans).toHaveLength(1);
    const tasks = await s.flaky();
    expect(tasks.map((object) => taskData(object.data).plan)).toEqual([bareId(flakyPlans[0]?.id ?? ""), bareId(flakyPlans[0]?.id ?? "")]);
    await cancelPlan(s.store, flakyPlans[0]?.id ?? "", {});
    s.options.plan = undefined;
    await s.track("T-0003-c", logWith("third"), 1, ["third"]);
    expect((await listAll(s.store, "plan")).filter((object) => bareId(object.id).endsWith("-flaky-tests"))).toHaveLength(2);
  });

  test("check.flakyPlan that names no plan says so and still proposes in flaky-tests", async () => {
    const s = await setup(true);
    s.options.plan = "P-9999-missing";
    await s.track("T-0001-a", logWith(TEST), 1);
    const tasks = await s.flaky();
    expect(tasks).toHaveLength(1);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('check.flakyPlan "P-9999-missing" does not name an open plan of this repository');
    expect(taskData(tasks[0]?.data ?? {}).plan).toMatch(/-flaky-tests$/);
  });

  test("a proposal that keeps failing returns its notice only once for the same count", async () => {
    const s = await setup(true);
    // The plan is cancelled between the decision and the proposal, so adding the task is refused.
    flakyTestHooks.beforePropose = async () => {
      for (const object of await listAll(s.store, "plan")) {
        await s.store.put("plan", object.id, { ...planData(object.data), status: "cancelled" }, "test");
      }
    };
    const log = logWith(TEST);
    await s.track("T-0001-a", log, 1);
    expect(s.notices).toHaveLength(1);
    await s.track("T-0002-b", log, 1);
    expect(s.notices).toHaveLength(1);
  });

  test("a proposal that cannot be made records a notice once and the count stays", async () => {
    const s = await setup(true);
    // The plan is cancelled between the decision and the proposal, so adding the task is refused.
    flakyTestHooks.beforePropose = async () => {
      for (const object of await listAll(s.store, "plan")) {
        await s.store.put("plan", object.id, { ...planData(object.data), status: "cancelled" }, "test");
      }
    };
    const log = logWith(TEST);
    await s.track("T-0001-a", log, 1);
    expect(await s.flaky()).toHaveLength(0);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain(`flaky test "${TEST}" passed on rerun 1 times; no task was proposed: `);
  });

  test("two files' failures repeated in bun's summary after a third file's header each get their own file and command", async () => {
    const s = await setup(true);
    const log = [
      "packages/alpha/test/a.test.ts:",
      "(pass) alpha > fine [1ms]",
      "(fail) alpha > breaks [3ms]",
      "packages/beta/test/b.test.ts:",
      "(fail) beta > breaks too [4ms]",
      "packages/gamma/test/c.test.ts:",
      "(pass) gamma > fine [1ms]",
      "",
      " 2 tests failed:",
      "(fail) alpha > breaks [3ms]",
      "(fail) beta > breaks too [4ms]",
      "",
    ].join("\n");
    await s.track("T-0001-a", log, 1, ["alpha > breaks", "beta > breaks too"]);
    const byTitle = new Map((await s.flaky()).map((object) => [taskData(object.data).title, taskData(object.data)]));
    const alpha = byTitle.get("Fix the flaky test: alpha > breaks");
    const beta = byTitle.get("Fix the flaky test: beta > breaks too");
    expect(alpha?.brief).toContain("in `packages/alpha/test/a.test.ts`");
    expect(alpha?.brief).toContain("bash scripts/stress.sh --runs <N> --load 2 -t '^alpha breaks$' 'packages/alpha/test/a.test.ts'");
    expect(beta?.brief).toContain("in `packages/beta/test/b.test.ts`");
    expect(beta?.brief).toContain("bash scripts/stress.sh --runs <N> --load 2 -t '^beta breaks too$' 'packages/beta/test/b.test.ts'");
    expect(alpha?.brief).not.toContain("gamma/test/c.test.ts");
  });

  test("a test whose file the log does not give is found by name in the test files, else the file is unknown", async () => {
    const s = await setup(true);
    mkdirSync(join(s.path, "packages", "gizmo", "test"), { recursive: true });
    mkdirSync(join(s.path, "packages", "one", "test"), { recursive: true });
    mkdirSync(join(s.path, "packages", "two", "test"), { recursive: true });
    writeFileSync(join(s.path, "packages", "gizmo", "test", "g.test.ts"), 'describe("gizmo", () => { test("turns", () => {}); });\n');
    writeFileSync(join(s.path, "packages", "one", "test", "x.test.ts"), 'test("twin case", () => {});\n');
    writeFileSync(join(s.path, "packages", "two", "test", "y.test.ts"), 'test("twin case", () => {});\n');
    mkdirSync(join(s.path, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(s.path, "node_modules", "pkg", "z.test.ts"), 'describe("gizmo", () => { test("turns", () => {}); test("twin case", () => {}); });\n');
    const log = ["some output", " 2 tests failed:", "(fail) gizmo > turns [1ms]", "(fail) twin case [1ms]", ""].join("\n");
    await s.track("T-0001-a", log, 1, ["gizmo > turns", "twin case"]);
    const byTitle = new Map((await s.flaky()).map((object) => [taskData(object.data).title, taskData(object.data)]));
    const gizmo = byTitle.get("Fix the flaky test: gizmo > turns");
    expect(gizmo?.brief).toContain("in `packages/gizmo/test/g.test.ts`");
    const twin = byTitle.get("Fix the flaky test: twin case");
    expect(twin?.brief).toContain("a file that is not known");
    expect(twin?.brief).not.toContain("x.test.ts");
    expect(twin?.brief).not.toContain("y.test.ts");
    expect(twin?.brief).toContain("bash scripts/stress.sh --runs <N> --load 2 -t '^twin case$'\n");
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

  test("a failure seen above the load limit opens no task and says it was skipped", async () => {
    const s = await setup(true);
    // Either reading above twice the cores is enough: the start is busy, the end is not.
    await s.track("T-0001-a", logWith(TEST), 1, [TEST], [], {
      startLoad: { load1: 30, cores: 10 },
      endLoad: { load1: 1, cores: 10 },
    });
    expect(await s.flaky()).toHaveLength(0);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toBe(`flaky test "${TEST}" skipped: seen under load 30 on 10 cores`);
    const record = (await listAll(s.store, "flaky-test"))[0];
    expect((record?.data as { occurrences?: { load?: unknown }[] }).occurrences?.[0]?.load).toEqual({ load1: 30, cores: 10 });
  });

  test("a failure whose end reading is above the load limit is skipped too", async () => {
    const s = await setup(true);
    await s.track("T-0001-a", logWith(TEST), 1, [TEST], [], {
      startLoad: { load1: 1, cores: 10 },
      endLoad: { load1: 25, cores: 10 },
    });
    expect(await s.flaky()).toHaveLength(0);
    expect(s.notices[0]).toContain("seen under load 25 on 10 cores");
  });

  test("a failure below the load limit opens the flaky task as before", async () => {
    const s = await setup(true);
    await s.track("T-0001-a", logWith(TEST), 1, [TEST], [], {
      startLoad: { load1: 19, cores: 10 },
      endLoad: { load1: 0, cores: 10 },
    });
    expect(s.notices).toEqual([]);
    expect(await s.flaky()).toHaveLength(1);
  });

  test("check.flakyLoadLimit sets the limit; at it a failure still counts", async () => {
    const s = await setup(true);
    await s.track("T-0001-a", logWith(TEST), 1, [TEST], [], {
      startLoad: { load1: 40, cores: 10 },
      endLoad: { load1: 40, cores: 10 },
      loadLimit: 40,
    });
    expect(s.notices).toEqual([]);
    expect(await s.flaky()).toHaveLength(1);
  });

  test("check.flakyLoadLimit is read and validated", () => {
    expect(validateDevSettings({ name: "x" }).check.flakyLoadLimit).toBeUndefined();
    expect(validateDevSettings({ name: "x", check: { flakyLoadLimit: 6.5 } }).check.flakyLoadLimit).toBe(6.5);
    expect(() => validateDevSettings({ name: "x", check: { flakyLoadLimit: 0 } })).toThrow(/flakyLoadLimit/);
  });

  test("check.flakyPlan is read, trimmed, and refused when empty or not a string", () => {
    expect(validateDevSettings({ name: "x" }).check.flakyPlan).toBeUndefined();
    expect(validateDevSettings({ name: "x", check: { flakyPlan: " P-0001-work " } }).check.flakyPlan).toBe("P-0001-work");
    expect(() => validateDevSettings({ name: "x", check: { flakyPlan: "" } })).toThrow(/flakyPlan/);
    expect(() => validateDevSettings({ name: "x", check: { flakyPlan: 3 } })).toThrow(/flakyPlan/);
  });

  test("a failure seen under load opens no task from an earlier idle count", async () => {
    const s = await setup(true);
    // One idle failure, not yet enough for its high threshold: no task is due.
    await s.track("T-0001-a", logWith(TEST), 99);
    // A lower threshold makes that old count due, but this failure is skipped.
    await s.track("T-0002-b", logWith(TEST), 1, [TEST], [], {
      startLoad: { load1: 30, cores: 10 },
      endLoad: { load1: 30, cores: 10 },
    });
    expect(await s.flaky()).toHaveLength(0);
    expect(s.notices[0]).toContain("skipped");
    // The next idle failure still proposes exactly one task.
    await s.track("T-0003-c", logWith(TEST), 1);
    expect(await s.flaky()).toHaveLength(1);
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

describe("rerun counts", () => {
  test("the count accumulates across calls, most frequent first, then by name", async () => {
    const store = storeAt(await tempRoot());
    await recordRerunPasses(store, ["a", "b"]);
    await recordRerunPasses(store, ["b"]);
    await recordRerunPasses(store, ["b", "c"]);
    expect(await listRerunCounts(store)).toEqual([
      { name: "b", count: 3 },
      { name: "a", count: 1 },
      { name: "c", count: 1 },
    ]);
  });
});
