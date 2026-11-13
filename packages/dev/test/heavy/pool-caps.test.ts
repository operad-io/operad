import { createShellPlugin } from "@operad-io/shell";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry } from "@operad-io/engine";
import poolPlugin from "@operad-io/pool";
import plugin from "../../src/index.ts";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  getTask,
  setAuto,
} from "../../src/service.ts";
import { taskViews } from "../../src/views.ts";
import { schedulerTestHooks } from "../../src/schedule.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  schedulerTestHooks.write = undefined;
});
guardLockHandles();

const WORKERS = {
  claude: { use: "claude/agent", count: 1 },
  codex: { use: "harness-codex/agent", count: 1 },
};
const POOLS = { default: ["claude"], image: ["codex"] };
const FLOWS = {
  default: { stages: [{ stage: "work" }, { stage: "check", commands: ["true"] }, { stage: "human" }] },
  image: { stages: [{ stage: "work", pool: "image" }, { stage: "human" }] },
};

async function setup(extra: Record<string, unknown> = {}) {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const registry = new PluginRegistry([plugin, poolPlugin, createShellPlugin()], {
    home: root,
    cwd: repositoryPath,
    store,
    storeRoot: store.root,
    onAnswer: async () => {},
    onCancelRun: () => {},
  });
  const repository = await addRepository(store, { path: repositoryPath });
  writeFileSync(
    join(repositoryPath, ".operad", "dev.json"),
    `${JSON.stringify({
      name: repository.name,
      workers: WORKERS,
      pools: POOLS,
      flows: FLOWS,
      ...extra,
    })}\n`,
  );
  schedulerTestHooks.write = () => undefined;
  return { store, registry, repository };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function tasks(fixture: Fixture, specs: readonly { slug: string; flow: string }[]) {
  const plan = await addPlan(fixture.store, { repository: fixture.repository, slug: "p", title: "p", concurrency: 10 });
  await setAuto(fixture.store, plan.id, "run");
  const keys = new Map<string, string>();
  for (const spec of specs) {
    const task = await addTask(fixture.store, { plan: plan.id, slug: spec.slug, title: spec.slug, flow: spec.flow });
    keys.set(spec.slug, task.id);
  }
  await confirmPlan(fixture.store, plan.id);
  return keys;
}

async function startedSlugs(fixture: Fixture, keys: ReadonlyMap<string, string>): Promise<string[]> {
  await fixture.registry.tick();
  const ids = new Set(fixture.registry.takeStartedRuns().map((request) => request.object?.id));
  return [...keys].filter(([, key]) => ids.has(key)).map(([slug]) => slug);
}

describe("each pool counts its own running tasks (T-0379)", () => {
  test("a full code pool does not stop an image task, and the other way round", async () => {
    const fixture = await setup({ plan: undefined });
    const keys = await tasks(fixture, [
      { slug: "code1", flow: "default" },
      { slug: "code2", flow: "default" },
      { slug: "image1", flow: "image" },
      { slug: "image2", flow: "image" },
    ]);
    // Both pools hold one worker: one code task and one image task start, the
    // second of each waits for its own pool.
    expect((await startedSlugs(fixture, keys)).sort()).toEqual(["code1", "image1"]);
  });

  test("an image task starts while the code pool is full, and a code task while the image pool is", async () => {
    const fixture = await setup();
    const keys = await tasks(fixture, [
      { slug: "code1", flow: "default" },
      { slug: "code2", flow: "default" },
      { slug: "code3", flow: "default" },
    ]);
    expect(await startedSlugs(fixture, keys)).toEqual(["code1"]);
    const plan = await addPlan(fixture.store, { repository: fixture.repository, slug: "q", title: "q", concurrency: 10 });
    await setAuto(fixture.store, plan.id, "run");
    const image = await addTask(fixture.store, { plan: plan.id, slug: "img", title: "img", flow: "image" });
    await confirmPlan(fixture.store, plan.id);
    await fixture.registry.tick();
    const ids = fixture.registry.takeStartedRuns().map((request) => request.object?.id);
    expect(ids).toContain(image.id);
    expect(ids).not.toContain(keys.get("code2"));
    expect(ids).not.toContain(keys.get("code3"));
  });

  test("the wait names the pool that is full", async () => {
    const fixture = await setup();
    const keys = await tasks(fixture, [
      { slug: "code1", flow: "default" },
      { slug: "code2", flow: "default" },
      { slug: "image1", flow: "image" },
    ]);
    await startedSlugs(fixture, keys);
    const second = keys.get("code2");
    const first = keys.get("code1");
    if (second === undefined || first === undefined) throw new Error("tasks");
    const note = taskViews.row(await getTask(fixture.store, second)).note ?? "";
    expect(note).toContain("waiting for the default pool's slot");
    expect(note).toContain(first.slice(first.indexOf("/") + 1));
  });

  test("a pool's concurrency limits it below its workers' counts", async () => {
    const fixture = await setup({
      workers: { codex: { use: "harness-codex/agent", count: 3 }, claude: WORKERS.claude },
      pools: { default: ["claude"], image: { workers: ["codex"], concurrency: 2 } },
    });
    const keys = await tasks(fixture, [
      { slug: "i1", flow: "image" },
      { slug: "i2", flow: "image" },
      { slug: "i3", flow: "image" },
    ]);
    expect((await startedSlugs(fixture, keys)).sort()).toEqual(["i1", "i2"]);
  });

  test("the repository's concurrency caps all pools together", async () => {
    const fixture = await setup({ concurrency: 1 });
    const keys = await tasks(fixture, [
      { slug: "code1", flow: "default" },
      { slug: "image1", flow: "image" },
    ]);
    expect(await startedSlugs(fixture, keys)).toHaveLength(1);
  });
});
