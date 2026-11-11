import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  loadProjectFlows,
  schedulerTestHooks,
  setAuto,
  validateDevSettings,
} from "../src/index.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const ENGINE = fileURLToPath(new URL("../../engine/src/index.ts", import.meta.url));

type Step = { readonly id: string; readonly next?: Record<string, string> };

/** A project flow file: dev's steps for [work, check, human], through defineFlow. */
function flowFile(change: (steps: Step[]) => Step[] = (steps) => steps): string {
  const flow = compileDevFlow("mine", [{ stage: "work" }, { stage: "check" }, { stage: "human" }]);
  const steps = change(flow.steps.map((step) => ({ ...step }) as Step));
  return [
    `import { defineFlow } from ${JSON.stringify(ENGINE)};`,
    `export default defineFlow(${JSON.stringify({ ...flow, steps })} as never);`,
    "",
  ].join("\n");
}

/** The same flow with the integrate step cut out: the person's merge ends it. */
function withoutIntegrate(steps: Step[]): Step[] {
  return steps
    .filter((step) => step.id !== "integrate" && step.id !== "cleanup")
    .map((step) =>
      step.next === undefined
        ? step
        : {
            ...step,
            next: Object.fromEntries(
              Object.entries(step.next).map(([key, to]) => [
                key,
                to === "integrate" || to === "cleanup" ? "end_done" : to,
              ]),
            ),
          },
    );
}

async function repositoryWith(files: Record<string, string>, devJson: object = {}) {
  const root = await tempRoot();
  const path = await makeGitRepository(root);
  mkdirSync(join(path, ".operad", "flows"), { recursive: true });
  writeFileSync(join(path, ".operad", "dev.json"), JSON.stringify({ name: "repo", ...devJson }));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(path, ".operad", "flows", name), text);
  }
  return { root, path };
}

test("a TS flow loads under its file name", async () => {
  const { path } = await repositoryWith({ "mine.flow.ts": flowFile() });
  const found = await loadProjectFlows(path, "repo", validateDevSettings({}));
  expect([...found.refused]).toEqual([]);
  expect(found.flows.get("mine")?.name).toMatch(/^dev\/repo\/mine\/[0-9a-f]{12}$/);
});

test("a ready task of a plan that names a TS flow starts it", async () => {
  const { root, path } = await repositoryWith({ "mine.flow.ts": flowFile() });
  const store = storeAt(root);
  const repository = await addRepository(store, { path, name: "repo" });
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", flow: "mine" });
  await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Do it." });
  await setAuto(store, plan.id, "run");
  await confirmPlan(store, plan.id);
  schedulerTestHooks.write = () => undefined;
  const registry = new PluginRegistry(
    [createDevPlugin(), createPoolPlugin(), createShellPlugin()],
    { home: root, cwd: path, store, storeRoot: store.root },
  );
  await registry.tick();
  const started = registry.takeStartedRuns()[0]?.flow ?? "";
  expect(started).toMatch(/^dev\/repo\/mine\//);
  expect(registry.flow(started)?.flow.entry).toBe("worktree");
});

test("a TS flow whose last step before the end is not integrate is refused", async () => {
  const { path } = await repositoryWith({ "mine.flow.ts": flowFile(withoutIntegrate) });
  const found = await loadProjectFlows(path, "repo", validateDevSettings({}));
  expect(found.flows.size).toBe(0);
  expect(found.refused.get("mine")).toMatch(
    /\.operad\/flows\/mine\.flow\.ts: (has no integrate step|ends without integrate)/,
  );
});

test("a TS flow that leads to the end from another step than integrate is refused", async () => {
  const { path } = await repositoryWith({
    "mine.flow.ts": flowFile((steps) =>
      steps.map((step) =>
        step.id === "check" ? { ...step, next: { ...step.next, pass: "end_done" } } : step,
      ),
    ),
  });
  const found = await loadProjectFlows(path, "repo", validateDevSettings({}));
  expect(found.refused.get("mine")).toContain('ends without integrate: step "check"');
});

test("a TS flow with no check, review or human step is refused", async () => {
  const { path } = await repositoryWith({
    "mine.flow.ts": flowFile((steps) =>
      steps
        .filter((step) => step.id !== "check" && step.id !== "human" && step.id !== "wait")
        .map((step) => ({
          ...step,
          ...(step.next === undefined
            ? {}
            : {
                next: Object.fromEntries(
                  Object.entries(step.next).map(([key, to]) => [
                    key,
                    to === "check" || to === "human" || to === "wait" ? "integrate" : to,
                  ]),
                ),
              }),
        })),
    ),
  });
  const found = await loadProjectFlows(path, "repo", validateDevSettings({}));
  expect(found.refused.get("mine")).toContain("needs at least one check, review or human step");
});

test("a name defined in dev.json and as a TS file is refused, and plan add says so", async () => {
  const devJson = { flows: { mine: { stages: [{ stage: "work" }, { stage: "human" }] } } };
  const { root, path } = await repositoryWith({ "mine.flow.ts": flowFile() }, devJson);
  const found = await loadProjectFlows(path, "repo", validateDevSettings(devJson));
  expect(found.flows.size).toBe(0);
  expect(found.refused.get("mine")).toContain('flow "mine" is defined in dev.json and in .operad/flows/mine.flow.ts');
  const store = storeAt(root);
  await addRepository(store, { path, name: "repo" });
  const registry = new PluginRegistry([createDevPlugin()], {
    home: root,
    cwd: path,
    store,
    storeRoot: store.root,
  });
  await expect(
    registry.runCommand(
      ["dev", "plan", "add", "--slug", "p", "--title", "P", "--flow", "mine"],
      { cwd: path, input: "request\n" },
    ),
  ).rejects.toThrow(/defined in dev\.json and in \.operad\/flows\/mine\.flow\.ts/);
});

test("a TS flow's review step reads the grading of the flow's name unless it names one", async () => {
  const flow = compileDevFlow("docs", [{ stage: "work" }, { stage: "review" }, { stage: "human" }]);
  const text = (grading?: string): string =>
    [
      `import { defineFlow } from ${JSON.stringify(ENGINE)};`,
      `const flow = ${JSON.stringify(flow)};`,
      `const steps = flow.steps.map((s: { id: string; params: object }) => s.id === "review" ? { ...s, params: { ...s.params, params: { ${grading === undefined ? "" : `grading: ${JSON.stringify(grading)}`} } } } : s);`,
      "export default defineFlow({ ...flow, steps } as never);",
      "",
    ].join("\n");
  const { path } = await repositoryWith({ "docs.flow.ts": text(), "own.flow.ts": text("strict") });
  const found = await loadProjectFlows(path, "repo", validateDevSettings({}));
  const gradingOf = (name: string): unknown =>
    (found.flows.get(name)?.steps.find((s) => s.id === "review")?.params as { params: { grading?: string } }).params.grading;
  expect(gradingOf("docs")).toBe("docs");
  expect(gradingOf("own")).toBe("strict");
});

test("--flow default is refused when a TS default flow clashes with dev.json", async () => {
  const devJson = { flows: { default: { stages: [{ stage: "work" }, { stage: "human" }] } } };
  const { root, path } = await repositoryWith({ "default.flow.ts": flowFile() }, devJson);
  const store = storeAt(root);
  await addRepository(store, { path, name: "repo" });
  const registry = new PluginRegistry([createDevPlugin()], { home: root, cwd: path, store, storeRoot: store.root });
  await expect(
    registry.runCommand(
      ["dev", "plan", "add", "--slug", "p", "--title", "P", "--flow", "default"],
      { cwd: path, input: "request\n" },
    ),
  ).rejects.toThrow(/defined in dev\.json and in \.operad\/flows\/default\.flow\.ts/);
});
