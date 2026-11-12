import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry } from "@operad-io/engine";
import { createPoolPlugin } from "@operad-io/pool";
import { createShellPlugin } from "@operad-io/shell";
import {
  addPlan,
  addRepository,
  addTask,
  compileDevFlow,
  confirmPlan,
  createDevPlugin,
  flowNameFor,
  planData,
  schedulerTestHooks,
  setAuto,
  storeKey,
  taskData,
  validateDevSettings,
  type DevStage,
} from "../../src/index.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

function nextOf(steps: ReturnType<typeof compileDevFlow>["steps"], id: string): Readonly<Record<string, string>> {
  const found = steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return (found.next ?? {}) as Readonly<Record<string, string>>;
}

function stepOf(steps: ReturnType<typeof compileDevFlow>["steps"], id: string) {
  const found = steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

test("the built-in default keeps today's ids and edges", () => {
  const flow = compileDevFlow("dev", [
    { stage: "work" },
    { stage: "check" },
    { stage: "review" },
    { stage: "human" },
  ]);
  expect(flow.entry).toBe("worktree");
  expect(nextOf(flow.steps, "work")).toMatchObject({
    done: "verify",
    unavailable: "work_retry",
  });
  expect(nextOf(flow.steps, "verify")).toEqual({
    pass: "review",
    fail: "rework",
    not_code: "announce_verify_not_code",
    cancelled: "end_cancelled",
  });
  expect(nextOf(flow.steps, "review")).toMatchObject({
    pass: "announce_ready",
    fail: "rework",
    unavailable: "review_retry",
  });
  expect(nextOf(flow.steps, "rework")).toEqual({
    again: "worktree",
    ask: "announce_rework",
    cancelled: "end_cancelled",
  });
  expect(nextOf(flow.steps, "wait")).toMatchObject({
    merge: "integrate",
    reverify: "reverify",
  });
});

test("a flow with no review skips review", () => {
  const flow = compileDevFlow("quick", [
    { stage: "work" },
    { stage: "check" },
    { stage: "human" },
  ]);
  expect(flow.steps.some((step) => step.id.startsWith("review"))).toBe(false);
  expect(nextOf(flow.steps, "check").pass).toBe("human");
  expect(nextOf(flow.steps, "human").merge).toBe("integrate");
});

test("a failed review returns to the nearest work stage before it", () => {
  const flow = compileDevFlow("twice", [
    { stage: "work" },
    { stage: "check" },
    { stage: "work" },
    { stage: "review" },
    { stage: "human" },
  ]);
  expect(nextOf(flow.steps, "work").done).toBe("check");
  expect(nextOf(flow.steps, "check").pass).toBe("work_2");
  expect(nextOf(flow.steps, "work_2").done).toBe("review");
  expect(nextOf(flow.steps, "review").fail).toBe("rework_review");
  expect(nextOf(flow.steps, "rework_review").again).toBe("work_2");
});

test("a failed check with no work stage waits for a person", () => {
  const flow = compileDevFlow("no-work", [{ stage: "check" }, { stage: "human" }]);
  expect(nextOf(flow.steps, "check").fail).toBe("wait");
  expect(stepOf(flow.steps, "wait").kind).toBe("wait_person");
});

test("a flow with no human stage is valid and ends at integrate", () => {
  const stages: readonly DevStage[] = [{ stage: "work" }, { stage: "check" }];
  expect(() => validateDevSettings({ flows: { gated: { stages } } })).not.toThrow();
  const flow = compileDevFlow("gated", stages);
  expect(nextOf(flow.steps, "check").pass).toBe("integrate");
  expect(flow.steps.some((step) => step.id === "wait")).toBe(true);
});

test("[human, check] loads and compiles human -> check -> integrate", () => {
  const stages: readonly DevStage[] = [{ stage: "human" }, { stage: "check" }];
  expect(() => validateDevSettings({ flows: { ask: { stages } } })).not.toThrow();
  const flow = compileDevFlow("ask", stages);
  expect(nextOf(flow.steps, "human").merge).toBe("check");
  expect(nextOf(flow.steps, "check").pass).toBe("integrate");
});

test("a flow with no gate is refused by name", () => {
  expect(() =>
    validateDevSettings({
      flows: { gate: { stages: [{ stage: "work" }, { stage: "work" }] } },
    }),
  ).toThrow(/flows\.gate\.stages: needs at least one check, review or human stage/);
});

test("a flow's stage settings are read and unknown fields refused", () => {
  const settings = validateDevSettings({
    flows: {
      default: {
        stages: [
          {
            stage: "work",
            use: "claude/agent",
            args: ["--model", "sonnet"],
            brief: "Keep the diff small.",
            beforeAttempt: "merge-main",
          },
          { stage: "check", commands: ["bun test"], rerun: 0 },
          { stage: "review", use: "pi/agent", later: ["--fast"] },
          { stage: "human" },
        ],
      },
    },
  });
  expect(settings.flows.default?.stages[0]).toEqual({
    stage: "work",
    use: "claude/agent",
    args: ["--model", "sonnet"],
    brief: "Keep the diff small.",
    beforeAttempt: "merge-main",
  });
  expect(settings.flows.default?.stages[1]).toEqual({
    stage: "check",
    commands: ["bun test"],
    rerun: 0,
  });
  expect(() =>
    validateDevSettings({
      flows: { default: { stages: [{ stage: "human", args: ["x"] }] } },
    }),
  ).toThrow(/flows\.default\.stages\[0\]\.args: is not a stage setting/);
  expect(() =>
    validateDevSettings({
      flows: {
        default: { stages: [{ stage: "work", beforeAttempt: "rebase" }, { stage: "check" }] },
      },
    }),
  ).toThrow(/flows\.default\.stages\[0\]\.beforeAttempt: must be "merge-main" or "none"/);
});

test("stage parameters reach the compiled steps", () => {
  const flow = compileDevFlow("params", [
    { stage: "work", use: "claude/agent", args: ["--model", "x"], brief: "short" },
    { stage: "check", commands: ["bun test"], rerun: 0 },
    { stage: "review", use: "pi/agent", args: ["--fast"], later: ["--slow"], grading: "strict" },
    { stage: "human" },
  ]);
  expect(stepOf(flow.steps, "work").params).toEqual({
    use: "dev/work",
    params: {
      flowUse: "claude/agent",
      flowArgs: ["--model", "x"],
      flowBrief: "short",
    },
  });
  expect(stepOf(flow.steps, "check").params).toEqual({
    use: "dev/verify",
    params: { commands: ["bun test"], rerun: 0 },
  });
  expect(stepOf(flow.steps, "review").params).toEqual({
    use: "dev/review",
    params: {
      use: "pi/agent",
      args: ["--fast"],
      later: ["--slow"],
      grading: "strict",
    },
  });
});

test("a ready task starts the repository's default flow by its registered name", async () => {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath, name: "repo" });
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan" });
  await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Do it." });
  await setAuto(store, plan.id, "run");
  await confirmPlan(store, plan.id);
  const stages: readonly DevStage[] = [{ stage: "work" }, { stage: "check" }, { stage: "human" }];
  writeFileSync(
    join(repositoryPath, ".operad", "dev.json"),
    JSON.stringify({ name: "repo", flows: { default: { stages } } }),
  );
  schedulerTestHooks.write = () => undefined;
  const registry = new PluginRegistry(
    [createDevPlugin(), createPoolPlugin(), createShellPlugin()],
    { home: root, cwd: repositoryPath, store, storeRoot: store.root },
  );
  await registry.tick();
  const name = flowNameFor("repo", "default", { stages });
  expect(registry.flow(name)?.flow.name).toBe(name);
  expect(registry.takeStartedRuns()[0]?.flow).toBe(name);
});

test("a work stage's beforeAttempt reaches the worktree and the work step", () => {
  const flow = compileDevFlow("prep", [
    { stage: "work", beforeAttempt: "none" },
    { stage: "check" },
  ]);
  expect(stepOf(flow.steps, "worktree").params).toEqual({
    use: "dev/worktree",
    params: { beforeAttempt: "none" },
  });
  expect(stepOf(flow.steps, "work").params).toMatchObject({
    params: { beforeAttempt: "none" },
  });
});

test("a plan's flow selects a named repository flow", async () => {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath, name: "repo" });
  const plan = await addPlan(store, {
    repository,
    slug: "plan",
    title: "Plan",
    flow: "quick",
  });
  await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Do it." });
  await setAuto(store, plan.id, "run");
  await confirmPlan(store, plan.id);
  const quick: readonly DevStage[] = [{ stage: "work" }, { stage: "check" }, { stage: "human" }];
  const usual: readonly DevStage[] = [
    { stage: "work" },
    { stage: "check" },
    { stage: "review" },
    { stage: "human" },
  ];
  writeFileSync(
    join(repositoryPath, ".operad", "dev.json"),
    JSON.stringify({ flows: { default: { stages: usual }, quick: { stages: quick } } }),
  );
  schedulerTestHooks.write = () => undefined;
  const registry = new PluginRegistry(
    [createDevPlugin(), createPoolPlugin(), createShellPlugin()],
    { home: root, cwd: repositoryPath, store, storeRoot: store.root },
  );
  await registry.tick();
  const name = flowNameFor("repo", "quick", { stages: quick });
  expect(registry.flow(name)?.flow.name).toBe(name);
  expect(registry.takeStartedRuns()[0]?.flow).toBe(name);
});

test("plan add --flow and task add --flow store the choice and refuse an unknown one", async () => {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath, name: "repo" });
  const stages: readonly DevStage[] = [{ stage: "work" }, { stage: "check" }, { stage: "human" }];
  writeFileSync(
    join(repositoryPath, ".operad", "dev.json"),
    JSON.stringify({ flows: { quick: { stages } } }),
  );
  const registry = new PluginRegistry([createDevPlugin()], {
    home: root,
    cwd: repositoryPath,
    store,
    storeRoot: store.root,
  });
  const planned = await registry.runCommand(
    ["dev", "plan", "add", "--slug", "p", "--title", "P", "--flow", "quick"],
    { cwd: repositoryPath, input: "request\n" },
  );
  const planId = String(planned?.value);
  const planObject = await store.get("plan", storeKey("repo", planId));
  expect(planData(planObject?.data ?? {}).flow).toBe("quick");

  const made = await registry.runCommand(
    ["dev", "task", "add", "--plan", planId, "--slug", "t", "--title", "T", "--flow", "default"],
    { cwd: repositoryPath, input: "brief\n" },
  );
  const taskId = String(made?.value);
  const taskObject = await store.get("task", storeKey("repo", taskId));
  expect(taskData(taskObject?.data ?? {}).flow).toBe("default");

  await expect(
    registry.runCommand(
      ["dev", "plan", "add", "--slug", "q", "--title", "Q", "--flow", "missing"],
      { cwd: repositoryPath, input: "request\n" },
    ),
  ).rejects.toThrow(/no flow "missing" in repository "repo"/);
});

test("changing dev.json leaves a running attempt on the graph it started with", async () => {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath, name: "repo" });
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan" });
  const task = await addTask(store, {
    plan: plan.id,
    slug: "task",
    title: "Task",
    brief: "Do it.",
  });
  const firstStages: readonly DevStage[] = [
    { stage: "work" },
    { stage: "check" },
    { stage: "human" },
  ];
  const secondStages: readonly DevStage[] = [
    { stage: "work" },
    { stage: "review" },
    { stage: "human" },
  ];
  const first = compileDevFlow(flowNameFor("repo", "default", { stages: firstStages }), firstStages);
  await store.put(
    "task",
    task.id,
    { ...taskData((await store.get("task", task.id))?.data ?? {}), phase: "waiting", flowName: first.name, flowGraph: first },
    "test:started",
  );
  mkdirSync(join(repositoryPath, ".operad"), { recursive: true });
  writeFileSync(
    join(repositoryPath, ".operad", "dev.json"),
    JSON.stringify({ flows: { default: { stages: firstStages } } }),
  );
  const registry = new PluginRegistry([createDevPlugin()], {
    home: root,
    cwd: repositoryPath,
    store,
    storeRoot: store.root,
  });
  await registry.tick();
  expect(registry.flow(first.name)?.flow).toBeDefined();

  writeFileSync(
    join(repositoryPath, ".operad", "dev.json"),
    JSON.stringify({ flows: { default: { stages: secondStages } } }),
  );
  await registry.tick();
  const secondName = flowNameFor("repo", "default", { stages: secondStages });
  expect(secondName).not.toBe(first.name);
  expect(registry.flow(secondName)?.flow).toBeDefined();
  // The attempt's graph still resolves, and the new settings added a new one.
  expect(registry.flow(first.name)?.flow.steps.some((step) => step.id.startsWith("review"))).toBe(false);
  expect(registry.flow(secondName)?.flow.steps.some((step) => step.id.startsWith("review"))).toBe(true);
});
