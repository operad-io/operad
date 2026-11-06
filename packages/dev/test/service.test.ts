import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addPlan,
  addRepository,
  addRework,
  addTask,
  cancelPlan,
  cancelTask,
  confirmPlan,
  confirmTask,
  devTestHooks,
  editTaskBrief,
  findRepository,
  getPlan,
  getTask,
  listRepositories,
  removeRepository,
  resolveRepository,
  setAuto,
  setPriority,
  setTaskPhase,
  updateTask,
  withRepositoryLock,
} from "../src/service.ts";
import {
  bareId,
  briefBody,
  changesBody,
  storeKey,
  taskData,
  type RepositoryData,
} from "../src/model.ts";
import { cleanupTempRoots, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

async function setup(): Promise<{
  readonly root: string;
  readonly repositoryPath: string;
  readonly repository: RepositoryData;
  readonly store: ReturnType<typeof storeAt>;
}> {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath });
  return { root, repositoryPath, repository, store };
}

describe("dev repositories", () => {
  test("add writes settings and excludes, list reads it, remove refuses open tasks", async () => {
    const { repositoryPath, repository, store } = await setup();
    expect(repository.name).toBe("repository");
    expect(repository.path).toBe(repositoryPath);
    const settings = JSON.parse(
      readFileSync(join(repositoryPath, ".operad", "dev.json"), "utf8"),
    ) as { name: string };
    expect(settings.name).toBe("repository");
    const exclude = readFileSync(
      join(repositoryPath, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).toContain(".operad-worktrees/");
    expect(exclude).toContain(".radian-sandbox/");

    expect((await listRepositories(store)).map((item) => item.name)).toEqual([
      "repository",
    ]);
    expect((await findRepository(store, "repository"))?.id).toBe("repository");

    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
      request: "do it",
    });
    await addTask(store, {
      plan: plan.id,
      slug: "one",
      title: "One",
      brief: "Body",
    });
    await expect(removeRepository(store, "repository")).rejects.toThrow(
      /open task/,
    );

    const task = (await store.list("task"))[0];
    if (task === undefined) throw new Error("missing task");
    await setTaskPhase(store, task.id, "merged");
    await removeRepository(store, "repository");
    expect(await listRepositories(store)).toHaveLength(0);
  });

  test("add refuses a directory that is not a git work tree, or has no remote", async () => {
    const { root, store } = await setup();
    const plain = join(root, "plain");
    Bun.spawnSync({ cmd: ["mkdir", "-p", plain] });
    await expect(
      addRepository(store, { path: plain }),
    ).rejects.toThrow(/git work tree/);

    const noRemote = join(root, "no-remote");
    Bun.spawnSync({ cmd: ["git", "init", "-q", noRemote] });
    await expect(
      addRepository(store, { path: noRemote }),
    ).rejects.toThrow(/has no remote/);
  });

  test("the current directory selects its repository, or --repo names one", async () => {
    const { repositoryPath, repository, store } = await setup();
    const found = await resolveRepository(store, {
      cwd: join(repositoryPath, "src"),
    });
    expect(found.name).toBe(repository.name);
    expect((await resolveRepository(store, { name: "repository" })).path).toBe(
      repositoryPath,
    );
    await expect(
      resolveRepository(store, { cwd: "/" }),
    ).rejects.toThrow(/--repo/);
  });

  test("add is idempotent for the exclude lines", async () => {
    const { repositoryPath, store } = await setup();
    await removeRepository(store, "repository");
    await addRepository(store, { path: repositoryPath });
    const exclude = readFileSync(
      join(repositoryPath, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude.match(/\.operad-worktrees\//g)).toHaveLength(1);
    expect(exclude.match(/\.radian-sandbox\//g)).toHaveLength(1);
  });
});

describe("dev plans and tasks", () => {
  test("validation errors name the field", async () => {
    const { repository, store } = await setup();
    await expect(
      addPlan(store, { repository, slug: "Bad Slug", title: "Bad" }),
    ).rejects.toThrow(/^slug:/);
    await expect(
      addTask(store, { plan: "PL9999-nope", slug: "one", title: "One" }),
    ).rejects.toThrow(/^plan:/);
    const empty = await addPlan(store, { repository, slug: "empty", title: "Empty" });
    await expect(confirmPlan(store, empty.id)).rejects.toThrow(/^confirm:/);
  });

  test("a plan starts as a draft with the defaults", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "storage",
      title: "Storage",
      request: "write it",
    });
    expect(bareId(plan.id)).toBe("PL0001-storage");
    expect(plan.data).toMatchObject({
      repository: "repository",
      title: "Storage",
      request: "write it",
      status: "draft",
      auto: "off",
      priority: "P3",
      concurrency: 1,
      taskCount: 0,
      mergedCount: 0,
    });
    expect(
      bareId(
        (
          await addPlan(store, {
            repository,
            slug: "storage",
            title: "Second",
          })
        ).id,
      ),
    ).toBe("PL0002-storage");
  });

  test("confirming a plan readies its proposed tasks; an empty plan is refused", async () => {
    const { repository, store } = await setup();
    const empty = await addPlan(store, {
      repository,
      slug: "empty",
      title: "Empty",
    });
    await expect(confirmPlan(store, empty.id)).rejects.toThrow(/has no tasks/);

    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    const first = await addTask(store, {
      plan: plan.id,
      slug: "first",
      title: "First",
    });
    const second = await addTask(store, {
      plan: plan.id,
      slug: "second",
      title: "Second",
    });
    expect(taskData(first.data).phase).toBe("proposed");
    await confirmPlan(store, plan.id);
    expect(taskData((await getPlan(store, plan.id)).data).status).toBe(
      "confirmed",
    );
    expect(taskData((await getTask(store, first.id)).data).phase).toBe("ready");
    expect(taskData((await getTask(store, second.id)).data).phase).toBe("ready");
    await expect(confirmPlan(store, plan.id)).rejects.toThrow(
      /already confirmed/,
    );
  });

  test("a task added to a confirmed plan waits for its own confirm", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await confirmPlan(store, plan.id);
    const late = await addTask(store, {
      plan: plan.id,
      slug: "late",
      title: "Late",
    });
    expect(taskData(late.data).phase).toBe("proposed");
    await confirmTask(store, late.id);
    expect(taskData((await getTask(store, late.id)).data).phase).toBe("ready");
    await expect(confirmTask(store, late.id)).rejects.toThrow(/already ready/);
  });

  test("after is checked for existence, plan or merge, and cycles", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    const other = await addPlan(store, {
      repository,
      slug: "other",
      title: "Other",
    });
    const external = await addTask(store, {
      plan: other.id,
      slug: "external",
      title: "External",
    });
    await expect(
      addTask(store, {
        plan: plan.id,
        slug: "bad",
        title: "Bad",
        after: [bareId(external.id)],
      }),
    ).rejects.toThrow(/not merged/);

    await setTaskPhase(store, external.id, "merged");
    const first = await addTask(store, {
      plan: plan.id,
      slug: "first",
      title: "First",
      after: [bareId(external.id)],
    });
    const second = await addTask(store, {
      plan: plan.id,
      slug: "second",
      title: "Second",
      after: [bareId(first.id)],
    });
    await expect(
      updateTask(store, first.id, { after: [bareId(second.id)] }),
    ).rejects.toThrow(/cycle/);
    expect(taskData((await getTask(store, first.id)).data).after).toEqual([
      bareId(external.id),
    ]);
  });

  test("a task's brief keeps the body while rework and changes grow", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    const task = await addTask(store, {
      plan: plan.id,
      slug: "one",
      title: "One",
      brief: "Original body",
    });
    expect(taskData(task.data).brief).toContain("## Changes\n- created");
    expect(briefBody(taskData(task.data).brief)).toBe("Original body");
    await addRework(store, task.id, "review", "Please fix it");
    const withRework = taskData((await getTask(store, task.id)).data);
    expect(withRework.brief).toContain("## Rework 1 (review)\n\nPlease fix it");
    expect(briefBody(withRework.brief)).toBe("Original body");
    await editTaskBrief(store, task.id, "New body");
    const edited = taskData((await getTask(store, task.id)).data);
    expect(briefBody(edited.brief)).toBe("New body");
    expect(edited.brief).toContain("## Rework 1 (review)");
    expect(changesBody(edited.brief)).toContain("- rework 1 (review)");
    expect(changesBody(edited.brief)).toContain("- brief edited");
  });

  test("edit and update refuse a task after it started", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await updateTask(store, task.id, { title: "Changed" });
    expect(taskData((await getTask(store, task.id)).data).title).toBe("Changed");
    await setTaskPhase(store, task.id, "running", { run: "run-1" });
    await expect(editTaskBrief(store, task.id, "new")).rejects.toThrow(
      /only proposed or ready/,
    );
    await expect(
      updateTask(store, task.id, { title: "Again" }),
    ).rejects.toThrow(/only proposed or ready/);
  });

  test("auto and priority follow their bounds", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    await setAuto(store, plan.id, "run");
    expect((await getPlan(store, plan.id)).data.auto).toBe("run");
    await setPriority(store, plan.id, "P0");
    expect((await getPlan(store, plan.id)).data.priority).toBe("P0");
  });

  test("cancelling a plan cancels a running task and asks the kernel to cancel its run", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "running", { run: "run-7" });
    const cancelled: string[] = [];
    await cancelPlan(store, plan.id, {
      runs: {
        cancel(runId) {
          cancelled.push(runId);
        },
      },
    });
    expect(cancelled).toEqual(["run-7"]);
    const after = taskData((await getTask(store, task.id)).data);
    expect(after.phase).toBe("cancelled");
    expect(after.run).toBeNull();
    expect((await getPlan(store, plan.id)).data.status).toBe("cancelled");
  });

  test("cancelling one task asks for its run too", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "waiting", { run: "run-8" });
    const cancelled: string[] = [];
    await cancelTask(store, task.id, {
      runs: { cancel: (runId) => void cancelled.push(runId) },
    });
    expect(cancelled).toEqual(["run-8"]);
    expect(taskData((await getTask(store, task.id)).data).phase).toBe(
      "cancelled",
    );
  });

  test("two task adds at once get distinct ids and lose nothing", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    const [first, second] = await Promise.all([
      addTask(store, { plan: plan.id, slug: "same", title: "First" }),
      addTask(store, { plan: plan.id, slug: "same", title: "Second" }),
    ]);
    expect(new Set([first.id, second.id]).size).toBe(2);
    const tasks = await store.list("task");
    expect(tasks).toHaveLength(2);
    expect((await getPlan(store, plan.id)).data.taskCount).toBe(2);
  });

  test("a repository lock is released after a failed job", async () => {
    const { repositoryPath } = await setup();
    await expect(
      withRepositoryLock(repositoryPath, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(join(repositoryPath, ".operad", "dev.lock"))).toBe(false);
  });
});

describe("dev per-repository ids", () => {
  test("two repositories may both hold TK0001-work under different keys", async () => {
    const root = await tempRoot();
    const firstPath = await makeGitRepository(root, "one");
    const secondPath = await makeGitRepository(root, "two");
    const store = storeAt(root);
    const first = await addRepository(store, { path: firstPath });
    const second = await addRepository(store, { path: secondPath });
    const firstPlan = await addPlan(store, {
      repository: first,
      slug: "work",
      title: "One",
    });
    const secondPlan = await addPlan(store, {
      repository: second,
      slug: "work",
      title: "Two",
    });
    const firstTask = await addTask(store, {
      plan: firstPlan.id,
      slug: "work",
      title: "First",
    });
    const secondTask = await addTask(store, {
      plan: secondPlan.id,
      slug: "work",
      title: "Second",
    });

    expect(bareId(firstTask.id)).toBe("TK0001-work");
    expect(bareId(secondTask.id)).toBe("TK0001-work");
    expect(firstTask.id).toBe(storeKey("one", "TK0001-work"));
    expect(secondTask.id).toBe(storeKey("two", "TK0001-work"));
    expect((await getTask(store, firstTask.id)).data.title).toBe("First");
    expect((await getTask(store, secondTask.id)).data.title).toBe("Second");
  });
});

describe("dev checks inside the lock", () => {
  test("task add rechecks that its plan is not cancelled", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    devTestHooks.beforeLock = async (operation) => {
      if (operation !== "task-add") return;
      devTestHooks.beforeLock = undefined;
      await cancelPlan(store, plan.id);
    };
    try {
      await expect(
        addTask(store, { plan: plan.id, slug: "late", title: "Late" }),
      ).rejects.toThrow(/cancelled/);
    } finally {
      devTestHooks.beforeLock = undefined;
    }
    expect((await store.list("task"))).toHaveLength(0);
  });

  test("repo remove rechecks that no task is open", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    devTestHooks.beforeLock = async (operation) => {
      if (operation !== "repo-remove") return;
      devTestHooks.beforeLock = undefined;
      await addTask(store, { plan: plan.id, slug: "late", title: "Late" });
    };
    try {
      await expect(removeRepository(store, "repository")).rejects.toThrow(
        /open task/,
      );
    } finally {
      devTestHooks.beforeLock = undefined;
    }
    expect((await listRepositories(store)).map((item) => item.name)).toEqual([
      "repository",
    ]);
  });

  test("a write refuses a repository that was removed", async () => {
    const { repository, store } = await setup();
    await removeRepository(store, "repository");
    await expect(
      addPlan(store, { repository, slug: "again", title: "Again" }),
    ).rejects.toThrow(/was removed/);
  });
});

describe("the dev lock survives a dead holder", () => {
  async function deadPid(): Promise<number> {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "0"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const pid = child.pid;
    await child.exited;
    return pid;
  }

  function leaveLock(repositoryPath: string, pid: number): string {
    mkdirSync(join(repositoryPath, ".operad"), { recursive: true });
    const path = join(repositoryPath, ".operad", "dev.lock");
    writeFileSync(path, JSON.stringify({ pid, start: null }), "utf8");
    return path;
  }

  test("a lock left by a dead pid is taken over", async () => {
    const { repositoryPath } = await setup();
    leaveLock(repositoryPath, await deadPid());
    let ran = false;
    await withRepositoryLock(repositoryPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(existsSync(join(repositoryPath, ".operad", "dev.lock"))).toBe(false);
  });

  test("two waiters on a dead holder never enter together", async () => {
    const { repositoryPath } = await setup();
    leaveLock(repositoryPath, await deadPid());
    let active = 0;
    let most = 0;
    let done = 0;
    const work = async (): Promise<void> => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      done += 1;
    };
    await Promise.all([
      withRepositoryLock(repositoryPath, work),
      withRepositoryLock(repositoryPath, work),
    ]);
    expect(done).toBe(2);
    expect(most).toBe(1);
  });

  test("a live holder blocks until the deadline and names its pid", async () => {
    const { repositoryPath } = await setup();
    const lock = leaveLock(repositoryPath, process.pid);
    let tick = 0;
    await expect(
      withRepositoryLock(repositoryPath, () => undefined, {
        clock: () => (tick === 0 ? 0 : 10_001),
        wait: async () => {
          tick += 1;
        },
      }),
    ).rejects.toThrow(new RegExp(`pid ${process.pid}`));
    expect(existsSync(lock)).toBe(true);
  });
});

describe("repo add never writes into the operad checkout", () => {
  test("the operad source checkout is refused", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const source = fileURLToPath(new URL("../../..", import.meta.url));
    await expect(addRepository(store, { path: source })).rejects.toThrow(
      /operad source checkout/,
    );
  });
});
