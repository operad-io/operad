import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPending, PluginRegistry } from "@operad-io/engine";
import poolPlugin from "@operad-io/pool";
import plugin from "../../src/index.ts";
import { schedulerTestHooks } from "../../src/schedule.ts";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  getTask,
  setAuto,
  setTaskPhase,
} from "../../src/service.ts";
import { taskData, type RepositoryData } from "../../src/model.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  storeAt,
  tempRoot,
} from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const STEP_CHILD = fileURLToPath(
  new URL("../fixtures/settings-step-child.ts", import.meta.url),
);

const VALID = { gate: { commands: ["bun test"] } };
const BROKEN = { gate: { commands: [42] } };

interface Fixture {
  readonly root: string;
  readonly store: ReturnType<typeof storeAt>;
  readonly registry: PluginRegistry;
  readonly errors: string[];
}

const realError = console.error;
afterEach(() => {
  console.error = realError;
  schedulerTestHooks.write = undefined;
});

function writeSettings(path: string, value: unknown): void {
  mkdirSync(join(path, ".operad"), { recursive: true });
  writeFileSync(join(path, ".operad", "dev.json"), `${JSON.stringify(value)}\n`);
}

async function setup(
  plugins: "all" | "dev-only" = "all",
): Promise<Fixture> {
  const root = await tempRoot();
  const store = storeAt(root);
  const registry = new PluginRegistry(
    plugins === "all" ? [plugin, poolPlugin] : [plugin],
    { home: root, cwd: root, store, storeRoot: store.root },
  );
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  schedulerTestHooks.write = () => undefined;
  return { root, store, registry, errors };
}

async function addRepo(
  fixture: Fixture,
  name: string,
): Promise<{ readonly repository: RepositoryData; readonly path: string }> {
  const path = await makeGitRepository(fixture.root, name);
  const repository = await addRepository(fixture.store, { path });
  writeSettings(path, VALID);
  return { repository, path };
}

async function readyTask(
  fixture: Fixture,
  repository: RepositoryData,
  slug: string,
): Promise<string> {
  const plan = await addPlan(fixture.store, { repository, slug, title: slug });
  await setAuto(fixture.store, plan.id, "run");
  const task = await addTask(fixture.store, { plan: plan.id, slug, title: slug });
  await confirmPlan(fixture.store, plan.id);
  return task.id;
}

function settingsItems(items: readonly { readonly id: string }[]) {
  return items.filter((item) => item.id.startsWith("settings:"));
}

describe("a repository whose dev.json becomes invalid", () => {
  test("a step in its own process finishes with the old settings, the log says it once, and pending clears when fixed", async () => {
    const fixture = await setup();
    const { path } = await addRepo(fixture, "alpha");
    await fixture.registry.tick();

    const child = Bun.spawn({
      cmd: [process.execPath, STEP_CHILD, path],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const lines = child.stdout
      .pipeThrough(new TextDecoderStream())
      [Symbol.asyncIterator]();
    expect((await lines.next()).value).toBe(`started ${JSON.stringify(["bun test"])}\n`);

    // The file becomes invalid while the step runs.
    writeSettings(path, BROKEN);
    for (let index = 0; index < 4; index += 1) await fixture.registry.tick();

    child.stdin.write("go\n");
    await child.stdin.flush();
    expect((await lines.next()).value).toBe(`finished ${JSON.stringify(["bun test"])}\n`);
    await child.exited;
    expect(child.exitCode).toBe(0);

    // One line for four ticks.
    const logged = fixture.errors.filter((line) => line.includes('repository "alpha"'));
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("gate.commands[0]");

    const standing = await fixture.registry.standing();
    expect(settingsItems(standing).length).toBe(1);
    expect(standing[0]?.prompt).toContain(
      "the repository settings are not valid: gate.commands[0]",
    );
    expect(standing[0]?.prompt).toContain("the last valid settings are in use");

    // A step that starts in a new process while the file is invalid still gets the old settings.
    const fresh = Bun.spawn({
      cmd: [process.execPath, STEP_CHILD, path],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, OPERAD_HOME: fixture.root },
    });
    // Without a config.json the home keeps no copy: the fresh process has none to use.
    fresh.stdin.end();
    await fresh.exited;
    expect(fresh.exitCode).not.toBe(0);

    // The file is fixed: the item is gone and the next breakage is logged again.
    writeSettings(path, { gate: { commands: ["bun run check"] } });
    await fixture.registry.tick();
    expect(settingsItems(await fixture.registry.standing()).length).toBe(0);
    writeSettings(path, BROKEN);
    await fixture.registry.tick();
    expect(fixture.errors.filter((line) => line.includes('repository "alpha"')).length).toBe(2);

    // Another edit with the same message is another change of the file.
    writeSettings(path, { gate: { commands: [43] } });
    await fixture.registry.tick();
    await fixture.registry.tick();
    expect(fixture.errors.filter((line) => line.includes('repository "alpha"')).length).toBe(3);
  });

  test("a process that starts while the file is invalid reads the copy the home kept", async () => {
    const fixture = await setup();
    writeFileSync(join(fixture.root, "config.json"), "{}\n");
    const { path } = await addRepo(fixture, "alpha");
    const env = { ...process.env, OPERAD_HOME: fixture.root };
    const first = Bun.spawn({
      cmd: [process.execPath, STEP_CHILD, path],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env,
    });
    first.stdin.write("go\n");
    await first.stdin.flush();
    await first.exited;
    expect(first.exitCode).toBe(0);

    writeSettings(path, BROKEN);
    const second = Bun.spawn({
      cmd: [process.execPath, STEP_CHILD, path],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env,
    });
    second.stdin.write("go\n");
    await second.stdin.flush();
    const text = await new Response(second.stdout).text();
    await second.exited;
    expect(text).toContain(`started ${JSON.stringify(["bun test"])}`);
    expect(second.exitCode).toBe(0);
  });

  test("a second repository is unaffected and the running task of the broken one is left alone", async () => {
    const fixture = await setup();
    const alpha = await addRepo(fixture, "alpha");
    const beta = await addRepo(fixture, "beta");
    const running = await readyTask(fixture, alpha.repository, "busy");
    await fixture.registry.tick();
    fixture.registry.takeStartedRuns();
    // The run records itself, as its first step does.
    await setTaskPhase(fixture.store, running, "running", { run: "run-1" });
    expect(taskData((await getTask(fixture.store, running)).data).phase).toBe("running");

    writeSettings(alpha.path, BROKEN);
    const other = await readyTask(fixture, beta.repository, "other");
    await fixture.registry.tick();

    const started = fixture.registry.takeStartedRuns().map((request) => request.object?.id);
    expect(started).toEqual([other]);
    expect(taskData((await getTask(fixture.store, running)).data).phase).toBe("running");
    expect(taskData((await getTask(fixture.store, other)).data).phase).toBe("running");
    const standing = settingsItems(await fixture.registry.standing());
    expect(standing.map((item) => item.id)).toEqual(["settings:alpha"]);
  });

  test("a repository that was never valid is reported once and shown, without stopping another", async () => {
    const fixture = await setup();
    const alpha = await addRepo(fixture, "alpha");
    writeSettings(alpha.path, BROKEN);
    // A fresh path: nothing valid was ever read for it in this process.
    const beta = await addRepo(fixture, "beta");
    const task = await readyTask(fixture, beta.repository, "go");
    for (let index = 0; index < 3; index += 1) {
      await fixture.registry.tick();
      // The run records itself, so the next tick leaves the task alone.
      await setTaskPhase(fixture.store, task, "running", { run: "run-1" });
    }
    expect(fixture.registry.takeStartedRuns().map((request) => request.object?.id)).toEqual([task]);
    expect(fixture.errors.filter((line) => line.includes('repository "alpha"')).length).toBe(1);
  });

  test("the pending view lists the item with the run-less kind", async () => {
    const fixture = await setup();
    const alpha = await addRepo(fixture, "alpha");
    await fixture.registry.tick();
    writeSettings(alpha.path, BROKEN);
    const log = { runs: async () => [] } as unknown as Parameters<typeof listPending>[0];
    const items = await listPending(log, fixture.registry);
    const item = items.find((candidate) => candidate.runId === "dev:settings:alpha");
    expect(item?.kind).toBe("standing");
    expect(item?.actions).toEqual([]);
    expect(item?.prompt).toContain("the last valid settings are in use");
  });
});

describe("a plugin dev needs that the home does not load", () => {
  test("a pending item names the plugin and the command, and ready tasks stay ready", async () => {
    const fixture = await setup("dev-only");
    const alpha = await addRepo(fixture, "alpha");
    const task = await readyTask(fixture, alpha.repository, "wait");
    await fixture.registry.tick();
    expect(fixture.registry.takeStartedRuns()).toEqual([]);
    expect(taskData((await getTask(fixture.store, task)).data).phase).toBe("ready");
    const items = await fixture.registry.standing();
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe("plugin:pool");
    expect(items[0]?.prompt).toContain("plugin pool");
    expect(items[0]?.prompt).toContain("`operad plugin enable pool`");

    // Loaded again, the same task starts.
    const loaded = new PluginRegistry([plugin, poolPlugin], {
      home: fixture.root,
      cwd: fixture.root,
      store: fixture.store,
      storeRoot: fixture.store.root,
    });
    await loaded.tick();
    expect(loaded.takeStartedRuns().length).toBe(1);
    expect(await loaded.standing()).toEqual([]);
  });
});

describe("a stopped task when a plugin dev needs is missing", () => {
  test("is not started again by the repair, and is while the plugin is loaded", async () => {
    const lookup = {
      active: async () => [],
      state: async () => undefined,
      lastStep: async () => "work",
    };
    const fixture = await setup("dev-only");
    const alpha = await addRepo(fixture, "alpha");
    const task = await readyTask(fixture, alpha.repository, "stopped");
    await fixture.registry.tick();
    fixture.registry.takeStartedRuns();
    await setTaskPhase(fixture.store, task, "running", { run: "run-1" });
    await fixture.registry.tick(lookup);
    expect(fixture.registry.takeStartedRuns()).toEqual([]);
    expect(taskData((await getTask(fixture.store, task)).data).phase).toBe("running");

    const loaded = new PluginRegistry([plugin, poolPlugin], {
      home: fixture.root,
      cwd: fixture.root,
      store: fixture.store,
      storeRoot: fixture.store.root,
    });
    await loaded.tick(lookup);
    expect(loaded.takeStartedRuns().length).toBe(1);
  });
});
