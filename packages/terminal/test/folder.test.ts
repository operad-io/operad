import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChatPlugin } from "@operad-io/chat";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  createDevPlugin,
  recreateGateWorktree,
  type DevSettings,
} from "@operad-io/dev";
import { PluginRegistry, SqlitePluginStore } from "@operad-io/engine";
import { releaseFolder } from "@operad-io/engine/platform";
import { createShellPlugin } from "@operad-io/shell";
import { FOLDER_REMOVED_REASON } from "../src/index.ts";
import { leftJob } from "../../engine/test/platform/left-job.ts";
import { addWorktree, closeAll, git, lingering, makeWorld, serve, type Served, type World } from "./support.ts";

afterEach(closeAll);

/** A repeating check the test runs by hand. */
function manualRepeat() {
  let check = (): void => undefined;
  return {
    repeat: (run: () => void) => {
      check = run;
      return () => {
        check = () => undefined;
      };
    },
    run: () => check(),
  };
}

/** A terminal whose command ended and left a job running in another process group. */
async function endedWithJob(served: Served, world: World, folder: string, name: string) {
  const job = leftJob(join(world.root, `left-${name}`));
  const terminal = await served.start({ command: `${job.line} read line`, folder });
  await job.up;
  await served.input(terminal.id, "\r");
  expect(await served.ended(terminal.id)).toMatchObject({ exitCode: 0, reason: null });
  expect(job.ended()).toBe(false);
  return { job, terminal };
}

describe("what an ended terminal left running", () => {
  test("is stopped when the terminal is closed", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const { job, terminal } = await endedWithJob(served, world, world.repository, "close");
    expect((await served.request("POST", `/v1/terminal/${terminal.id}/close`, {})).status).toBe(200);
    await job.gone;
  });

  test("is stopped when serve stops", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const { job } = await endedWithJob(served, world, world.repository, "stop");
    await served.stop();
    await job.gone;
  });

  test("is stopped when its folder is released", async () => {
    const world = await makeWorld();
    const worktree = addWorktree(world, "TK4");
    const served = await serve(world, { plugin: { repeat: manualRepeat().repeat } });
    const { job } = await endedWithJob(served, world, worktree, "release");
    expect(await releaseFolder(world.home, worktree)).toBe(1);
    await job.gone;
  });

  test("is stopped when its folder is removed by anything else", async () => {
    const world = await makeWorld();
    const worktree = addWorktree(world, "TK5");
    const checks = manualRepeat();
    const served = await serve(world, { plugin: { repeat: checks.repeat } });
    const { job } = await endedWithJob(served, world, worktree, "removed");
    checks.run();
    git(world.repository, "worktree", "remove", "--force", worktree);
    checks.run();
    await job.gone;
  });
});

describe("a removed folder", () => {
  test("releasing a worktree stops its terminals, and they say why", async () => {
    const world = await makeWorld();
    const worktree = addWorktree(world, "TK1");
    // The check for removed folders never runs: the release alone stops them.
    const served = await serve(world, { plugin: { repeat: manualRepeat().repeat } });
    const job = lingering(world, "dev-server");
    const inWorktree = await served.start({ command: `bash -c "${job.command}"; true`, folder: worktree });
    const inMain = await served.start({ command: "read x", folder: world.repository });
    await job.up;
    const stream = await served.stream(inWorktree.id);

    expect(await releaseFolder(world.home, worktree)).toBe(1);
    await job.gone;
    git(world.repository, "worktree", "remove", "--force", worktree);

    const exit = await stream.until((event) => event.name === "exit");
    expect(exit.data.reason).toBe(FOLDER_REMOVED_REASON);
    expect(await served.ended(inWorktree.id)).toMatchObject({
      state: "ended",
      reason: "stopped because its folder was removed",
      exitCode: 137,
    });
    expect((await served.list()).terminals.find((t) => t.id === inMain.id)?.state).toBe("running");
  });

  test("a worktree removed by anything else is noticed and its terminals stopped", async () => {
    const world = await makeWorld();
    const worktree = addWorktree(world, "TK2");
    const checks = manualRepeat();
    const served = await serve(world, { plugin: { repeat: checks.repeat } });
    const job = lingering(world, "by-hand");
    const terminal = await served.start({ command: job.command, folder: worktree });
    const inMain = await served.start({ command: "read x", folder: world.repository });
    await job.up;
    checks.run();
    expect(job.ended()).toBe(false);

    git(world.repository, "worktree", "remove", "--force", worktree);
    checks.run();

    await job.gone;
    expect(await served.ended(terminal.id)).toMatchObject({ reason: FOLDER_REMOVED_REASON });
    expect((await served.list()).terminals.find((t) => t.id === inMain.id)?.state).toBe("running");
  });

  test("dev making a checking worktree again stops its terminals first", async () => {
    const world = await makeWorld();
    const gate = addWorktree(world, "TK6-gate");
    const served = await serve(world, { plugin: { repeat: manualRepeat().repeat } });
    const job = lingering(world, "in-gate");
    const terminal = await served.start({ command: job.command, folder: gate });
    await job.up;
    const settings = { worktreeRoot: ".operad-worktrees" } as DevSettings;
    expect(await recreateGateWorktree(world.home, world.repository, gate, "HEAD", settings)).toBeUndefined();
    await job.gone;
    expect(await served.ended(terminal.id)).toMatchObject({ reason: FOLDER_REMOVED_REASON });
  });

  test("a folder removed and made again is not the folder the terminal started in", async () => {
    const world = await makeWorld();
    const worktree = addWorktree(world, "TK3");
    const checks = manualRepeat();
    const served = await serve(world, { plugin: { repeat: checks.repeat } });
    const terminal = await served.start({ command: "read x", folder: worktree });
    git(world.repository, "worktree", "remove", "--force", worktree);
    git(world.repository, "worktree", "add", "-q", "--detach", worktree);
    checks.run();
    expect(await served.ended(terminal.id)).toMatchObject({ reason: FOLDER_REMOVED_REASON });
  });

  test.each([
    ["names $OPERAD_WORKTREE", 'git worktree remove --force "$OPERAD_WORKTREE"', ': "$OPERAD_WORKTREE"'],
    [
      "runs git worktree remove",
      'for d in .operad-worktrees/*; do case "$d" in *-gate) ;; *) git worktree remove --force "$d" ;; esac; done',
      ": git worktree remove",
    ],
  ])("dev's cleanup stops both worktrees' terminals before a hook that %s", async (_, removal, mention) => {
    const world = await makeWorld();
    const served = await serve(world, { plugin: { repeat: manualRepeat().repeat } });
    const pidFile = join(world.root, "terminal-pid");
    // The first hook fails when the terminal's shell still runs as it starts.
    const stillRuns = `case "$(ps -o stat= -p "$(cat '${pidFile}')")" in ""|Z*) ;; *) exit 9;; esac; ${mention}`;
    mkdirSync(join(world.repository, ".operad"));
    writeFileSync(
      join(world.repository, ".operad", "dev.json"),
      JSON.stringify({
        name: "repository",
        mainBranch: "main",
        hooks: { afterMerge: [stillRuns, removal] },
      }),
    );

    // A task with a real worktree, as dev makes one.
    const store = new SqlitePluginStore({ root: join(world.root, "dev-store") });
    const repository = await addRepository(store, { path: world.repository, name: "repository" });
    const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "work" });
    const task = await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Work." });
    await confirmPlan(store, plan.id);
    const registry = new PluginRegistry([createChatPlugin(), createDevPlugin(), createShellPlugin()], {
      home: world.home,
      cwd: world.repository,
      store,
    });
    const object = { type: "task", id: task.id, data: {} };
    const prepared = await registry.runStep("dev/worktree", {}, { runId: "worktree-run", object });
    expect(prepared.result).toBe("ready");
    const worktree = join(world.repository, ".operad-worktrees", task.id.slice(task.id.indexOf("/") + 1));

    // The two meet only in the home they share.
    const inTask = await served.start({
      command: `echo $$ > '${pidFile}'; echo "ready-$((1+1))"; read x`,
      folder: worktree,
    });
    const inMain = await served.start({ command: "read x", folder: world.repository });
    await (await served.stream(inTask.id)).shows(inTask.id, /ready-2/);
    const gate = `${worktree}-gate`;
    git(world.repository, "worktree", "add", "-q", "--detach", gate);
    const inGate = await served.start({ command: "read x", folder: gate });

    const result = await registry.runStep("dev/cleanup", {}, { runId: "cleanup-run", object });

    expect(result.data).toMatchObject({ failures: 0 });
    expect(existsSync(worktree)).toBe(false);
    expect(await served.ended(inTask.id)).toMatchObject({
      reason: FOLDER_REMOVED_REASON,
      exitCode: 137,
    });
    expect(await served.ended(inGate.id)).toMatchObject({ reason: FOLDER_REMOVED_REASON });
    expect((await served.list()).terminals.find((t) => t.id === inMain.id)?.state).toBe("running");
    store.close();
  });
});
