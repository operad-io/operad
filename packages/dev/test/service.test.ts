import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
} from "../src/service.ts";
import {
  bareId,
  briefBody,
  changesBody,
  listAll,
  storeKey,
  taskData,
  type RepositoryData,
} from "../src/model.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";
import { DEV_SETTINGS_SCHEMA } from "../src/settings.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

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
    ) as { name: string; $schema?: string };
    expect(settings.name).toBe("repository");
    expect(settings.$schema).toBe(DEV_SETTINGS_SCHEMA);
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

    const [task] = await listAll(store, "task");
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
    // A refused add writes nothing: no registration and no settings file.
    expect(await findRepository(store, "no-remote")).toBeUndefined();
    expect(existsSync(join(noRemote, ".operad", "dev.json"))).toBe(false);
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
      addTask(store, { plan: "P-9999-nope", slug: "one", title: "One" }),
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
    expect(bareId(plan.id)).toBe("P-0001-storage");
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
    ).toBe("P-0002-storage");
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
    expect(taskData(task.data).brief).toMatch(/## Changes\n- \[[^\]]+\] created/);
    expect(briefBody(taskData(task.data).brief)).toBe("Original body");
    await addRework(store, task.id, "review", "Please fix it");
    const withRework = taskData((await getTask(store, task.id)).data);
    expect(withRework.brief).toContain("## Rework 1 (review)\n\nPlease fix it");
    expect(briefBody(withRework.brief)).toBe("Original body");
    await editTaskBrief(store, task.id, "New body");
    const edited = taskData((await getTask(store, task.id)).data);
    expect(briefBody(edited.brief)).toBe("New body");
    expect(edited.brief).toContain("## Rework 1 (review)");
    expect(changesBody(edited.brief)).toContain("] rework 1 — review: Please fix it");
    expect(changesBody(edited.brief)).toContain("] brief edited");
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
    const tasks = await listAll(store, "task");
    expect(tasks).toHaveLength(2);
    expect((await getPlan(store, plan.id)).data.taskCount).toBe(2);
  });
});

describe("dev per-repository ids", () => {
  test("two repositories may both hold T-0001-work under different keys", async () => {
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

    expect(bareId(firstTask.id)).toBe("T-0001-work");
    expect(bareId(secondTask.id)).toBe("T-0001-work");
    expect(firstTask.id).toBe(storeKey("one", "T-0001-work"));
    expect(secondTask.id).toBe(storeKey("two", "T-0001-work"));
    expect((await getTask(store, firstTask.id)).data.title).toBe("First");
    expect((await getTask(store, secondTask.id)).data.title).toBe("Second");
  });

  test("ids count up across different slugs in one repository", async () => {
    const { repository, store } = await setup();
    const alpha = await addPlan(store, {
      repository,
      slug: "alpha",
      title: "Alpha",
    });
    const beta = await addPlan(store, {
      repository,
      slug: "beta",
      title: "Beta",
    });
    expect(bareId(alpha.id)).toBe("P-0001-alpha");
    expect(bareId(beta.id)).toBe("P-0002-beta");

    const first = await addTask(store, {
      plan: beta.id,
      slug: "one",
      title: "One",
    });
    const second = await addTask(store, {
      plan: beta.id,
      slug: "two",
      title: "Two",
    });
    expect(bareId(first.id)).toBe("T-0001-one");
    expect(bareId(second.id)).toBe("T-0002-two");
  });

  test("new ids count past old ids in either form", async () => {
    const { repository, store } = await setup();
    store.put(
      "plan",
      storeKey("repository", "PL0003-x"),
      {
        repository: "repository",
        title: "Old plan",
        request: "old request",
        status: "confirmed",
        auto: "off",
        priority: "P3",
        concurrency: 1,
        taskCount: 0,
        mergedCount: 0,
        cancelledCount: 0,
      },
      "seed",
    );
    store.put(
      "task",
      storeKey("repository", "TK0007-y"),
      {
        repository: "repository",
        plan: "PL0003-x",
        title: "Old task",
        brief: "Old brief",
        after: [],
        phase: "merged",
        attempts: 1,
        run: null,
      },
      "seed",
    );

    const plan = await addPlan(store, {
      repository,
      slug: "new",
      title: "New plan",
    });
    expect(bareId(plan.id)).toBe("P-0004-new");
    const task = await addTask(store, {
      plan: plan.id,
      slug: "new",
      title: "New task",
    });
    expect(bareId(task.id)).toBe("T-0008-new");
  });

  test("after accepts an old id and a new id, exactly", async () => {
    const { repository, store } = await setup();
    const plan = await addPlan(store, {
      repository,
      slug: "work",
      title: "Work",
    });
    const planId = bareId(plan.id);
    store.put(
      "task",
      storeKey("repository", "TK0001-old"),
      {
        repository: "repository",
        plan: planId,
        title: "Old task",
        brief: "Old brief",
        after: [],
        phase: "merged",
        attempts: 1,
        run: null,
      },
      "seed",
    );
    const newer = await addTask(store, {
      plan: plan.id,
      slug: "newer",
      title: "Newer task",
    });
    expect(bareId(newer.id)).toBe("T-0002-newer");

    const afterOld = await addTask(store, {
      plan: plan.id,
      slug: "after-old",
      title: "After old",
      after: ["TK0001-old"],
    });
    expect(taskData(afterOld.data).after).toEqual(["TK0001-old"]);

    const afterNew = await addTask(store, {
      plan: plan.id,
      slug: "after-new",
      title: "After new",
      after: [bareId(newer.id)],
    });
    expect(taskData(afterNew.data).after).toEqual([bareId(newer.id)]);

    await expect(
      addTask(store, {
        plan: plan.id,
        slug: "fuzzy",
        title: "Fuzzy",
        after: ["T-0001-old"],
      }),
    ).rejects.toThrow(/no task "T-0001-old"/);
  });
});

describe("git that succeeds without printing", () => {
  function realGit(cwd: string, args: readonly string[]) {
    const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
    return {
      ok: result.exitCode === 0,
      out: result.stdout.toString().trim(),
      err: result.stderr.toString().trim(),
    };
  }

  test("repo add runs a query again when git exits 0 and prints nothing", async () => {
    const root = await tempRoot();
    const path = await makeGitRepository(root, "quiet");
    const store = storeAt(root);
    const silent = new Map<string, number>();
    devTestHooks.gitQuery = (cwd, args) => {
      const key = args.join(" ");
      const seen = silent.get(key) ?? 0;
      silent.set(key, seen + 1);
      return seen < 2 ? { ok: true, out: "", err: "" } : realGit(cwd, args);
    };
    try {
      const repository = await addRepository(store, { path });
      expect(repository.name).toBe("quiet");
      expect([...silent.values()].every((count) => count === 3)).toBe(true);
      expect(silent.size).toBeGreaterThanOrEqual(3);
    } finally {
      devTestHooks.gitQuery = undefined;
    }
  });

  test("repo add still refuses when git never prints", async () => {
    const root = await tempRoot();
    const path = await makeGitRepository(root, "mute");
    const store = storeAt(root);
    let calls = 0;
    devTestHooks.gitQuery = () => {
      calls += 1;
      return { ok: true, out: "", err: "" };
    };
    try {
      await expect(addRepository(store, { path })).rejects.toThrow(/is not a git work tree/);
      expect(calls).toBe(5);
    } finally {
      devTestHooks.gitQuery = undefined;
    }
  });
});

describe("repo add reports git's stderr", () => {
  test("a failing rev-parse puts its stderr in the refusal", async () => {
    const root = await tempRoot();
    const path = await makeGitRepository(root, "broken");
    const store = storeAt(root);
    devTestHooks.gitQuery = () => ({ ok: false, out: "", err: "fatal: simulated git failure" });
    try {
      await expect(addRepository(store, { path })).rejects.toThrow(
        /is not a git work tree: fatal: simulated git failure/,
      );
    } finally {
      devTestHooks.gitQuery = undefined;
    }
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
    expect(await listAll(store, "task")).toHaveLength(0);
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
