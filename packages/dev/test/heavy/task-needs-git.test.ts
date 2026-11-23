import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createChatPlugin } from "@operad-io/chat";
import { PluginRegistry } from "@operad-io/engine";
import { addPlan, addRepository, addTask, createDevPlugin } from "../../src/index.ts";
import { prepareWorktree } from "../../src/steps.ts";
import { DEFAULT_DEV_SETTINGS } from "../../src/settings.ts";
import { repositoryData } from "../../src/model.ts";
import { realGitFinderHost } from "@operad-io/engine/platform";
import { gitStateTestHooks } from "../../src/git-state.ts";
import { git } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, runInProcess, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const PLUGIN = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const CHAT = fileURLToPath(new URL("../../../chat/src/index.ts", import.meta.url));
const POOL = fileURLToPath(new URL("../../../pool/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../../../shell/src/index.ts", import.meta.url));

const NOT_UNDER_GIT = "This folder is not under git yet, and a task needs it.";
const NO_COMMIT = "Git is set up here but has no commit yet, and a task needs one.";
const NO_PROGRAM = "Creating a task needs git, and git is not installed on this machine.";

async function rig() {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = storeAt(root);
  const folder = join(root, "plain");
  mkdirSync(folder, { recursive: true });
  await addRepository(store, { path: folder, name: "plain" });
  const registry = new PluginRegistry([createChatPlugin(), createDevPlugin()], {
    home: root,
    cwd: folder,
    store,
    onLog: () => undefined,
  });
  return { root, home, store, folder, registry };
}
type Rig = Awaited<ReturnType<typeof rig>>;

async function plans(r: Rig): Promise<number> {
  return (await r.store.list("plan")).objects.length;
}
async function tasks(r: Rig): Promise<number> {
  return (await r.store.list("task")).objects.length;
}

async function planAction(r: Rig): Promise<string> {
  try {
    await r.registry.runAction("dev/plan", { title: "A plan", slug: "plan" }, {
      object: { type: "repo", id: "plain", data: (await r.store.get("repo", "plain"))?.data ?? {} },
      actor: { via: "cli", id: "me" },
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("a task needs git", () => {
  test("no repository: dev:plan and dev plan add refuse in plain words and leave nothing", async () => {
    const r = await rig();
    expect(await planAction(r)).toContain(NOT_UNDER_GIT);
    expect(await plans(r)).toBe(0);
  });

  test("no commit: the refusal asks for the first commit", async () => {
    const r = await rig();
    git(r.folder, ["init", "-q"]);
    const message = await planAction(r);
    expect(message).toContain(NO_COMMIT);
    expect(await plans(r)).toBe(0);
  });

  test("a subfolder names the root and the command", async () => {
    const r = await rig();
    git(r.root, ["init", "-q"]);
    const message = await planAction(r);
    expect(message).toContain(`inside the git repository at`);
    expect(message).toContain(`operad dev repo add ${realpathSync(r.root)}`);
    expect(await plans(r)).toBe(0);
  });

  test("no git program: the refusal says how to get it", async () => {
    const r = await rig();
    gitStateTestHooks.finder = { ...realGitFinderHost(), platform: "linux", env: { PATH: "" }, which: () => null, exists: () => false };
    try {
      expect(await planAction(r)).toContain(NO_PROGRAM);
    } finally {
      gitStateTestHooks.finder = undefined;
    }
    expect(await plans(r)).toBe(0);
  });

  test("dev:task and task add refuse when git went away after the plan was made", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const path = await makeGitRepository(root);
    await addRepository(store, { path, name: "repository" });
    const repository = await store.get("repo", "repository");
    if (repository === undefined) throw new Error("no repository");
    const plan = await addPlan(store, { repository: repositoryData(repository.data), slug: "plan", title: "Plan" });
    rmSync(join(path, ".git"), { recursive: true, force: true });
    const registry = new PluginRegistry([createChatPlugin(), createDevPlugin()], { home: root, cwd: path, store, onLog: () => undefined });
    let message = "";
    try {
      await registry.runAction("dev/task", { title: "T", slug: "t" }, {
        object: { type: "plan", id: plan.id, data: plan.data },
        actor: { via: "cli", id: "me" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(NOT_UNDER_GIT);
    await expect(addTask(store, { plan: plan.id, slug: "t", title: "T" })).rejects.toThrow(NOT_UNDER_GIT);
    expect((await store.list("task")).objects).toHaveLength(0);
  });

  test("the worktree step refuses with the same sentence", async () => {
    const r = await rig();
    const repository = await r.store.get("repo", "plain");
    if (repository === undefined) throw new Error("no repository");
    const prepared = prepareWorktree(repositoryData(repository.data), DEFAULT_DEV_SETTINGS, "T-0001-x");
    expect(JSON.stringify(prepared)).toContain(NOT_UNDER_GIT);
  });

  test("dev plan add and dev task add refuse through the command line", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ plugins: [CHAT, PLUGIN, POOL, SHELL], store: { backend: "sqlite", path: join(root, "store", "log.sqlite") } }),
    );
    const plain = join(root, "plain");
    mkdirSync(plain);
    const repo = await makeGitRepository(root);
    expect((await runInProcess(home, root, ["dev", "repo", "add", plain, "--name", "plain"])).code).toBe(0);
    expect((await runInProcess(home, root, ["dev", "repo", "add", repo, "--name", "repo"])).code).toBe(0);
    const noPlan = await runInProcess(home, plain, ["dev", "plan", "add", "--repo", "plain", "--slug", "p", "--title", "P"]);
    expect(noPlan.code).not.toBe(0);
    expect(noPlan.err).toContain(NOT_UNDER_GIT);
    const made = await runInProcess(home, repo, ["dev", "plan", "add", "--repo", "repo", "--slug", "p", "--title", "P"]);
    expect(made.code).toBe(0);
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const noTask = await runInProcess(home, repo, ["dev", "task", "add", "--repo", "repo", "--plan", made.out.trim(), "--slug", "t", "--title", "T"]);
    expect(noTask.code).not.toBe(0);
    expect(noTask.err).toContain(NOT_UNDER_GIT);
  });
});
