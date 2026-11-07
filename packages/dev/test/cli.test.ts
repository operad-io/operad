import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  loadPluginRegistry,
  openConfigLog,
  openPluginStore,
  parseObjectKey,
  readConfig,
  readStoredStart,
  Runner,
  serve,
  storeRootOf,
} from "@operad-io/engine";
import { withRepositoryLock } from "../src/lock.ts";
import { bareId, listAll } from "../src/model.ts";
import { setTaskPhase } from "../src/service.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const CLI_ENTRY = fileURLToPath(new URL("../../cli/bin/operad.ts", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../src/index.ts", import.meta.url));

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function setup(): Promise<{
  readonly root: string;
  readonly home: string;
  readonly repository: string;
}> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    `${JSON.stringify(
      {
        plugins: [PLUGIN],
        store: { backend: "jsonl", path: join(root, "store") },
      },
      null,
      2,
    )}\n`,
  );
  const repository = await makeGitRepository(root);
  return { root, home, repository };
}

async function run(
  home: string,
  cwd: string,
  args: readonly string[],
  input?: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd,
    env: { ...process.env, OPERAD_HOME: home, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

describe("operad with the dev plugin", () => {
  test("the real binary registers, plans, lists, shows and confirms", async () => {
    const { root, home, repository } = await setup();

    const added = await run(home, repository, ["repo", "add", "."]);
    expect(added.code).toBe(0);
    expect(added.out).toContain(`added ${repository.split("/").pop()}`);
    expect(
      JSON.parse(
        readFileSync(join(repository, ".operad", "dev.json"), "utf8"),
      ),
    ).toMatchObject({ name: repository.split("/").pop() });
    expect(
      readFileSync(join(repository, ".git", "info", "exclude"), "utf8"),
    ).toContain(".operad-worktrees/");

    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "alpha", "--title", "Alpha"],
      "Do the thing.\n",
    );
    expect(plan.code).toBe(0);
    const planId = plan.out.trim();
    expect(planId).toBe("P-0001-alpha");

    const task = await run(
      home,
      repository,
      [
        "task",
        "add",
        "--plan",
        planId,
        "--slug",
        "first",
        "--title",
        "First task",
      ],
      "# Brief\n\nUse the store.\n",
    );
    expect(task.code).toBe(0);
    const taskId = task.out.trim();
    expect(taskId).toBe("T-0001-first");

    const listed = await run(home, repository, ["list", "task"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(`${taskId}  proposed  First task`);

    const brief = await run(home, repository, [
      "show",
      taskId,
      "--section",
      "brief",
    ]);
    expect(brief.code).toBe(0);
    expect(brief.out).toContain("Use the store.");
    expect(brief.out).not.toContain("## Changes");

    const confirmed = await run(home, repository, ["dev:confirm", planId]);
    expect(confirmed.code).toBe(0);
    const ready = await run(home, repository, ["list", "task"]);
    expect(ready.out).toContain(`${taskId}  ready  First task`);

    const second = await run(home, repository, ["dev:confirm", planId]);
    expect(second.code).toBe(3);
    expect(second.err).toContain("is confirmed; dev:confirm needs draft");

    const changes = await run(home, repository, [
      "show",
      taskId,
      "--section",
      "changes",
      "--raw",
    ]);
    expect(changes.code).toBe(0);
    expect(changes.out).toContain("- created");
    expect(changes.out).toContain("- ready");
  });

  test("show and dev:confirm take an old id, and an id is matched exactly", async () => {
    const { root, home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const other = await makeGitRepository(root, "other");
    expect((await run(home, other, ["repo", "add", "."])).code).toBe(0);
    const repositoryName = repository.split("/").pop() ?? "";
    const otherName = other.split("/").pop() ?? "";
    const store = openPluginStore({
      backend: "jsonl",
      root: join(root, "store"),
    });
    store.put(
      "plan",
      `${repositoryName}/PL0001-old`,
      {
        repository: repositoryName,
        title: "Old plan",
        request: "old request",
        status: "draft",
        auto: "off",
        priority: "P3",
        concurrency: 1,
        taskCount: 1,
        mergedCount: 0,
        cancelledCount: 0,
      },
      "seed",
    );
    store.put(
      "task",
      `${repositoryName}/TK0001-old`,
      {
        repository: repositoryName,
        plan: "PL0001-old",
        title: "Old task",
        brief: "Old brief",
        after: [],
        phase: "proposed",
        attempts: 0,
        run: null,
      },
      "seed",
    );
    store.put(
      "plan",
      `${otherName}/PL0001-old`,
      {
        repository: otherName,
        title: "Other old plan",
        request: "other request",
        status: "draft",
        auto: "off",
        priority: "P3",
        concurrency: 1,
        taskCount: 1,
        mergedCount: 0,
        cancelledCount: 0,
      },
      "seed",
    );
    store.put(
      "task",
      `${otherName}/TK0001-old`,
      {
        repository: otherName,
        plan: "PL0001-old",
        title: "Other old task",
        brief: "Other old brief",
        after: [],
        phase: "proposed",
        attempts: 0,
        run: null,
      },
      "seed",
    );

    const shown = await run(home, repository, ["show", "TK0001-old"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("TK0001-old  proposed  Old task");
    expect(shown.out).not.toContain("Other old task");

    const confirmed = await run(home, repository, [
      "dev:confirm",
      "PL0001-old",
    ]);
    expect(confirmed.code).toBe(0);
    const ready = await run(home, repository, ["show", "TK0001-old"]);
    expect(ready.out).toContain("TK0001-old  ready  Old task");

    const fuzzy = await run(home, repository, ["show", "T-0001-old"]);
    // An id is matched exactly: the other form of it is a different id, and
    // the answer names the ids that are close.
    expect(fuzzy.code).not.toBe(0);
    expect(fuzzy.err).toContain('no object "T-0001-old"');
    expect(fuzzy.err).toContain("TK0001-old");
    expect(fuzzy.out).not.toContain("Old task");
  });

  test("dev:reject from the CLI records, and serve runs the next step", async () => {
    const { home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "serve", "--title", "Serve"],
      "do it\n",
    );
    const planId = plan.out.trim();
    const added = await run(
      home,
      repository,
      [
        "task",
        "add",
        "--plan",
        planId,
        "--slug",
        "one",
        "--title",
        "One",
      ],
      "brief\n",
    );
    const taskId = added.out.trim();
    expect((await run(home, repository, ["dev:confirm", planId])).code).toBe(0);

    const config = await readConfig(home);
    const storeRoot = storeRootOf(config);
    const store = new FilePluginStore({ root: join(storeRoot, "plugins") });
    const taskObject = (await listAll(store, "task")).find(
      (object) => bareId(object.id) === taskId,
    );
    if (taskObject === undefined) throw new Error("the task is missing");

    const log = openConfigLog(config);
    const registry = await loadPluginRegistry({
      home,
      cwd: repository,
      store,
      onLog: () => undefined,
    });
    try {
      // A run at the person wait, with the task agreeing that it is waiting.
      const waiting = await log.startRun("dev", `task:${taskObject.id}`);
      await log.append(waiting.runId, 0, [
        { kind: "run_started", payload: { flow: "dev" }, cause: "seed" },
        {
          kind: "step_entered",
          payload: { step: "wait", visit: 1, kind: "wait_person" },
          cause: 1,
        },
        {
          kind: "waiting_for_person",
          payload: {
            waitId: "wait:1",
            step: "wait",
            prompt: "merge or reject",
            choices: ["merge", "reject"],
            waitKind: "step",
            effectId: null,
          },
          cause: 2,
        },
      ]);
      await setTaskPhase(store, taskObject.id, "waiting", {
        run: waiting.runId,
      });

      // serve runs in this process, but its sleep is manual so the test can let
      // the CLI record first and hold the repository lock for the next step.
      const controller = new AbortController();
      let wake: (() => void) | undefined;
      let asleep: (() => void) | undefined;
      const sleeping = new Promise<void>((resolve) => {
        asleep = resolve;
      });
      const sleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
        new Promise((resolve) => {
          wake = (): void => {
            wake = undefined;
            resolve();
          };
          asleep?.();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });

      const served = serve({
        home,
        log,
        registry,
        lockRoot: storeRoot,
        storeRoot,
        intervalMs: 10,
        signal: controller.signal,
        sleep,
        spawnRun: async (runId, options) => {
          const found = registry.flow("dev");
          if (found === undefined) throw new Error("the dev flow is missing");
          const info = (await log.runs()).find((item) => item.runId === runId);
          if (info === undefined) throw new Error(`no run ${runId}`);
          const object = parseObjectKey(info.object);
          const startInput = readStoredStart(storeRoot, runId);
          await new Runner({
            log,
            flow: found.flow,
            runId,
            registry,
            lockRoot: storeRoot,
            recover: options.recover,
            ...(object === undefined ? {} : { object }),
            ...(startInput === undefined ? {} : { startInput }),
          }).run();
        },
      });
      await sleeping;

      // The CLI answers and returns while serve still sleeps; it did not run
      // the next step.
      const rejected = await run(home, repository, [
        "dev:reject",
        taskId,
        "--note",
        "do it again",
      ]);
      expect(rejected.code).toBe(0);
      expect(rejected.out).not.toContain("recorded;");

      const stepStarted = new Promise<number>((resolve) => {
        const unsubscribe = log.subscribe?.(() => {
          void (async () => {
            for await (const fact of log.read(waiting.runId)) {
              if (
                fact.kind === "step_started" &&
                (fact.payload as { step?: unknown }).step === "worktree"
              ) {
                unsubscribe?.();
                resolve((fact.payload as { pid?: number }).pid ?? -1);
                return;
              }
            }
          })();
        });
      });
      const bounded = new Promise<number>((resolve) => {
        const timer = setTimeout(() => resolve(-2), 10_000);
        timer.unref?.();
      });

      // Hold the repository lock so the worktree step starts (and records its
      // pid) but cannot end until the test releases it.
      await withRepositoryLock(repository, async () => {
        wake?.();
        const pid = await Promise.race([stepStarted, bounded]);
        expect(pid).toBe(process.pid);
      });

      controller.abort();
      await served;
    } finally {
      await log.close();
    }
  });

  test("two task adds in two processes get distinct ids and lose nothing", async () => {
    const { home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "race", "--title", "Race"],
      "a request\n",
    );
    const planId = plan.out.trim();

    const [first, second] = await Promise.all([
      run(
        home,
        repository,
        ["task", "add", "--plan", planId, "--slug", "same", "--title", "One"],
        "first brief\n",
      ),
      run(
        home,
        repository,
        ["task", "add", "--plan", planId, "--slug", "same", "--title", "Two"],
        "second brief\n",
      ),
    ]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.out.trim()).not.toBe(second.out.trim());
    const listed = await run(home, repository, ["list", "task", "--json"]);
    const page = JSON.parse(listed.out) as { rows: unknown[] };
    expect(page.rows.length).toBe(2);
  });

  test("dev:auto and dev:priority take --level on the command line", async () => {
    const { home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "level", "--title", "Level"],
      "a request\n",
    );
    const planId = plan.out.trim();

    const auto = await run(home, repository, [
      "dev:auto",
      planId,
      "--level",
      "merge",
    ]);
    expect(auto.code).toBe(0);

    const priority = await run(home, repository, [
      "dev:priority",
      planId,
      "--level",
      "P1",
    ]);
    expect(priority.code).toBe(0);

    const bad = await run(home, repository, [
      "dev:auto",
      planId,
      "--level",
      "sometimes",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('"off", "run", "merge"');

    const missing = await run(home, repository, ["dev:auto", planId]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("is required");
  });

  test("a command outside the repository takes --repo and edit opens $EDITOR", async () => {
    const { root, home, repository } = await setup();
    const name = repository.split("/").pop() ?? "repository";
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);

    const plan = await run(
      home,
      home,
      ["plan", "add", "--slug", "remote", "--title", "Remote", "--repo", name],
      "a request\n",
    );
    expect(plan.code).toBe(0);
    const planId = plan.out.trim();

    const task = await run(
      home,
      repository,
      ["task", "add", "--plan", planId, "--slug", "edit", "--title", "Edit"],
      "Old body\n",
    );
    const taskId = task.out.trim();

    const editor = join(root, "editor.sh");
    writeFileSync(
      editor,
      "#!/bin/sh\nprintf '# Edited\\n\\nNew body\\n' > \"$1\"\n",
      "utf8",
    );
    chmodSync(editor, 0o755);
    const edited = await run(home, repository, ["task", "edit", taskId], undefined, {
      EDITOR: editor,
    });
    expect(edited.code).toBe(0);

    const brief = await run(home, repository, [
      "show",
      taskId,
      "--section",
      "brief",
    ]);
    expect(brief.out).toContain("New body");
    expect(brief.out).not.toContain("Old body");
  });

  test("show and an action take --repo for a bare id from outside any repository", async () => {
    const { root, home, repository } = await setup();
    const name = repository.split("/").pop() ?? "repository";
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const other = await makeGitRepository(root, "other");
    expect((await run(home, other, ["repo", "add", "."])).code).toBe(0);
    // The same plan id in both repositories: only a named repository can pick one.
    for (const where of [repository, other]) {
      const plan = await run(
        home,
        where,
        ["plan", "add", "--slug", "p", "--title", where === other ? "In other" : "In first"],
        "a request\n",
      );
      expect(plan.out.trim()).toBe("P-0001-p");
    }

    const bare = await run(home, home, ["show", "P-0001-p"]);
    expect(bare.code).not.toBe(0);

    const first = await run(home, home, ["show", "P-0001-p", "--repo", name]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("In first");
    const second = await run(home, home, ["show", "P-0001-p", "--repo", "other"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("In other");

    const acted = await run(home, home, ["dev:confirm", "P-0001-p", "--repo", "other", "--yes"]);
    expect(acted.err).not.toContain("--repo");
    expect(acted.err).not.toContain("ambiguous");
  });

  test("outside every repository: the error says where, the qualified id and a unique bare id resolve, an ambiguous one lists both", async () => {
    const { root, home, repository } = await setup();
    const name = repository.split("/").pop() ?? "repository";
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });

    const none = await run(home, outside, ["start", "T-0001-x"]);
    expect(none.code).not.toBe(0);
    expect(none.err).toContain(`no registered repository contains`);
    expect(none.err).toContain("operad repo add <path>");

    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const other = await makeGitRepository(root, "other");
    expect((await run(home, other, ["repo", "add", "."])).code).toBe(0);

    const hint = await run(home, outside, ["plan", "add", "--slug", "p", "--title", "P"], "r\n");
    expect(hint.code).not.toBe(0);
    expect(hint.err).toContain(`no registered repository contains ${outside}`);
    expect(hint.err).toContain("or pass --repo <name>:");
    expect(hint.err).toContain(`  ${name}  `);
    expect(hint.err).toContain("  other  ");

    const addTask = async (where: string, slug: string): Promise<string> => {
      const made = await run(
        home,
        where,
        ["task", "add", "--plan", "P-0001-p", "--slug", slug, "--title", "T"],
        "b\n",
      );
      return made.out.trim();
    };
    for (const where of [repository, other]) {
      await run(home, where, ["plan", "add", "--slug", "p", "--title", "P"], "r\n");
    }
    expect(await addTask(repository, "same")).toBe("T-0001-same");
    expect(await addTask(repository, "only")).toBe("T-0002-only");
    expect(await addTask(other, "same")).toBe("T-0001-same");

    // The qualified form names the repository for an action, from anywhere.
    for (const repo of [name, "other"]) {
      const confirmed = await run(home, outside, ["dev:confirm", `${repo}/P-0001-p`, "--yes"]);
      expect(confirmed.err).toBe("");
      expect(confirmed.code).toBe(0);
    }

    // A unique bare id resolves from outside.
    const shown = await run(home, outside, ["show", "T-0002-only"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("T-0002-only");
    const started = await run(home, outside, ["start", "T-0002-only"]);
    expect(started.err).toBe("");
    expect(started.out).toContain("start requested for T-0002-only");

    // The qualified form works from anywhere, for start and show.
    const qshown = await run(home, outside, ["show", "other/T-0001-same"]);
    expect(qshown.code).toBe(0);
    const qstart = await run(home, outside, ["start", "other/T-0001-same"]);
    expect(qstart.out).toContain("start requested for T-0001-same");
    // The same bare id in two repositories is ambiguous and lists both.
    const ambiguous = await run(home, outside, ["show", "T-0001-same"]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain(`${name}/T-0001-same`);
    expect(ambiguous.err).toContain("other/T-0001-same");
    const twice = await run(home, outside, ["start", "T-0001-same"]);
    expect(twice.code).not.toBe(0);
    expect(twice.err).toContain(`${name}/T-0001-same`);
    expect(twice.err).toContain("other/T-0001-same");

    // An id nowhere reports where the command ran and what is registered.
    for (const args of [["show", "T-0099-nope"], ["dev:confirm", "T-0099-nope", "--yes"]]) {
      const missing = await run(home, outside, args);
      expect(missing.code).not.toBe(0);
      expect(missing.err).toContain(`no registered repository contains ${outside}`);
      expect(missing.err).toContain("  other  ");
    }
    // A qualified id names a repository that must be registered.
    for (const args of [["show", "nowhere/T-0001-x"], ["dev:confirm", "nowhere/P-0001-p", "--yes"]]) {
      const unknown = await run(home, outside, args);
      expect(unknown.code).not.toBe(0);
      expect(unknown.err).toContain('no registered repository "nowhere"');
      expect(unknown.err).toContain("  other  ");
    }
  });

  test("a qualified id with an unknown repository, or a conflicting --repo, is refused", async () => {
    const { root, home, repository } = await setup();
    const name = repository.split("/").pop() ?? "repository";
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const other = await makeGitRepository(root, "other");
    expect((await run(home, other, ["repo", "add", "."])).code).toBe(0);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });

    const unknown = await run(home, outside, ["start", "nowhere/T-0001-x"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain(`no registered repository "nowhere"`);
    expect(unknown.err).toContain(`  ${name}  `);
    expect(unknown.err).toContain("  other  ");

    const conflict = await run(home, outside, ["start", `${name}/T-0001-x`, "--repo", "other"]);
    expect(conflict.code).not.toBe(0);
    expect(conflict.err).toContain(name);
    expect(conflict.err).toContain("other");
    const shownConflict = await run(home, outside, ["show", `${name}/T-0001-x`, "--repo", "other"]);
    expect(shownConflict.code).not.toBe(0);
    expect(shownConflict.err).toContain("--repo");
    expect(shownConflict.err).toContain(`"${name}"`);

    // A repository whose path is gone stays listed, marked missing.
    rmSync(other, { recursive: true, force: true });
    const missing = await run(home, outside, ["start", "T-0001-x"]);
    expect(missing.err).toMatch(/ {2}other {2}.*\(missing\)/);
  });

  test("task edit and update resolve the repository like every other command", async () => {
    const { root, home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const other = await makeGitRepository(root, "other");
    expect((await run(home, other, ["repo", "add", "."])).code).toBe(0);

    const plan = await run(
      home,
      other,
      ["plan", "add", "--slug", "p", "--title", "P"],
      "a request\n",
    );
    const task = await run(
      home,
      other,
      [
        "task",
        "add",
        "--plan",
        plan.out.trim(),
        "--slug",
        "t",
        "--title",
        "T",
      ],
      "a brief\n",
    );
    const taskId = task.out.trim();

    const wrongEdit = await run(home, repository, ["task", "edit", taskId]);
    expect(wrongEdit.code).toBe(1);
    expect(wrongEdit.err).toContain(`no task "${taskId}"`);

    const wrong = await run(home, repository, [
      "task",
      "update",
      taskId,
      "--title",
      "Wrong",
    ]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain(`no task "${taskId}"`);

    const outside = await run(home, home, [
      "task",
      "update",
      "T-0099-none",
      "--title",
      "Nowhere",
    ]);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("--repo");
    expect(outside.err).toContain("  other  ");

    const updated = await run(home, home, [
      "task",
      "update",
      taskId,
      "--title",
      "Renamed",
      "--repo",
      "other",
    ]);
    expect(updated.code).toBe(0);
    expect(updated.out.trim()).toBe(taskId);
  });

  test("task add and update set, show and clear the area", async () => {
    const { home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "p", "--title", "P"],
      "a request\n",
    );
    const task = await run(
      home,
      repository,
      ["task", "add", "--plan", plan.out.trim(), "--slug", "t", "--title", "T", "--area", "engine-core"],
      "a brief\n",
    );
    expect(task.code).toBe(0);
    const taskId = task.out.trim();

    const listed = await run(home, repository, ["list", "task"]);
    expect(listed.out).toContain("area: engine-core");
    const shown = await run(home, repository, ["show", taskId, "--section", "brief"]);
    expect(shown.out).toContain("Area: engine-core");

    const changed = await run(home, repository, ["task", "update", taskId, "--area", "docs"]);
    expect(changed.code).toBe(0);
    expect((await run(home, repository, ["list", "task"])).out).toContain("area: docs");

    const cleared = await run(home, repository, ["task", "update", taskId, "--area", ""]);
    expect(cleared.code).toBe(0);
    expect((await run(home, repository, ["list", "task"])).out).not.toContain("area:");

    const bad = await run(home, repository, ["task", "update", taskId, "--area", "x".repeat(65)]);
    expect(bad.code).toBe(1);
  });

  test("a bare id resolves in the repository of the current directory", async () => {
    const { root, home, repository } = await setup();
    const other = await makeGitRepository(root, "other");
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    expect((await run(home, other, ["repo", "add", "."])).code).toBe(0);

    const planA = await run(
      home,
      repository,
      ["plan", "add", "--slug", "work", "--title", "A"],
      "request A\n",
    );
    const taskA = await run(
      home,
      repository,
      [
        "task",
        "add",
        "--plan",
        planA.out.trim(),
        "--slug",
        "work",
        "--title",
        "A task",
      ],
      "brief A\n",
    );
    expect(taskA.out.trim()).toBe("T-0001-work");

    const planB = await run(
      home,
      other,
      ["plan", "add", "--slug", "work", "--title", "B"],
      "request B\n",
    );
    const taskB = await run(
      home,
      other,
      [
        "task",
        "add",
        "--plan",
        planB.out.trim(),
        "--slug",
        "work",
        "--title",
        "B task",
      ],
      "brief B\n",
    );
    expect(taskB.out.trim()).toBe("T-0001-work");

    const shown = await run(home, repository, [
      "show",
      "T-0001-work",
      "--section",
      "brief",
      "--raw",
    ]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("brief A");
    expect(shown.out).not.toContain("brief B");

    const confirmed = await run(home, repository, [
      "dev:confirm",
      "P-0001-work",
    ]);
    expect(confirmed.code).toBe(0);
    const shownA = await run(home, repository, ["show", "T-0001-work"]);
    expect(shownA.out).toContain("T-0001-work  ready  A task");
    const shownB = await run(home, other, ["show", "T-0001-work"]);
    expect(shownB.out).toContain("T-0001-work  proposed  B task");

    const ambiguous = await run(home, home, ["show", "T-0001-work"]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain("ambiguous");
  });

  test("show without an id lists the ten latest changes; an unknown id lists the five closest", async () => {
    const { home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "work", "--title", "Work"],
      "request\n",
    );
    const planId = plan.out.trim();
    for (let index = 1; index <= 12; index += 1) {
      const added = await run(
        home,
        repository,
        ["task", "add", "--plan", planId, "--slug", `job${index}`, "--title", `Job ${index}`],
        "brief\n",
      );
      expect(added.code).toBe(0);
    }

    const recent = await run(home, repository, ["show"]);
    expect(recent.code).toBe(0);
    const lines = recent.out.trim().split("\n");
    // Ten objects, then the hint.
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("operad show <id>");
    // The plan changed with each task it gained; the newest change comes first.
    expect(lines[0]).toMatch(/^(plan|task)\s{2}\S+\s{2}\S+\s{2}/);
    expect(lines.join("\n")).not.toContain("T-0001-job1  ");

    const unknown = await run(home, repository, ["show", "T-0003-job"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain('no object "T-0003-job"');
    const near = unknown.err.split("\n").filter((line) => line.startsWith("  "));
    expect(near).toHaveLength(5);
    expect(near[0]).toContain("T-0003-job3");
  }, 20_000);

  test("a plan shows its auto level and priority, and its history shows who confirmed and set it", async () => {
    const { home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "work", "--title", "Work"],
      "request\n",
    );
    const planId = plan.out.trim();
    await run(
      home,
      repository,
      ["task", "add", "--plan", planId, "--slug", "one", "--title", "One"],
      "brief\n",
    );
    const confirm = await run(home, repository, ["dev:confirm", planId]);
    expect(confirm.err).toBe("");
    expect(confirm.code).toBe(0);
    expect(
      (await run(home, repository, ["dev:auto", planId, "--level", "merge"])).code,
    ).toBe(0);
    expect(
      (await run(home, repository, ["dev:priority", planId, "--level", "P1"])).code,
    ).toBe(0);

    const listed = await run(home, repository, ["list", "plan"]);
    expect(listed.out).toContain("auto: merge  P1");
    const shown = await run(home, repository, ["show", planId]);
    expect(shown.out).toContain("auto: merge  P1");
    const json = JSON.parse(
      (await run(home, repository, ["show", planId, "--json"])).out,
    ) as { row: { note: string } };
    expect(json.row.note).toContain("auto: merge  P1");
    const listJson = JSON.parse(
      (await run(home, repository, ["list", "plan", "--json"])).out,
    ) as { rows: { note: string }[] };
    expect(listJson.rows[0]?.note).toContain("auto: merge  P1");

    const history = await run(home, repository, [
      "show",
      planId,
      "--section",
      "history",
    ]);
    expect(history.out).not.toContain("No history yet");
    expect(history.out).toMatch(/dev:confirm \(via cli, as \S+\)/);
    expect(history.out).toMatch(/dev:auto \(via cli, as \S+\)/);
    expect(history.out).toMatch(/dev:priority \(via cli, as \S+\)/);

    // A plan has no run; `history` prints the same actions.
    const bare = await run(home, repository, ["history", planId]);
    expect(bare.code).toBe(0);
    expect(bare.out).toMatch(/dev:confirm \(via cli/);
  });

  test("a refused action says where the task is and where it must be, and exits non-zero", async () => {
    const { home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "work", "--title", "Work"],
      "request\n",
    );
    const planId = plan.out.trim();
    const task = await run(
      home,
      repository,
      ["task", "add", "--plan", planId, "--slug", "one", "--title", "One"],
      "brief\n",
    );
    const taskId = task.out.trim();
    expect((await run(home, repository, ["dev:confirm", planId])).code).toBe(0);

    const refused = await run(home, repository, ["dev:confirm", taskId]);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain(`${taskId} is ready; dev:confirm needs proposed`);
    const merge = await run(home, repository, ["dev:merge", taskId, "--yes"]);
    expect(merge.code).toBe(3);
    expect(merge.err).toContain(`${taskId} is ready; dev:merge needs waiting`);
  });

  test("a task that never ran has a history, and sections for its log, diff and metrics", async () => {
    const { home, repository } = await setup();
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    const plan = await run(
      home,
      repository,
      ["plan", "add", "--slug", "work", "--title", "Work"],
      "request\n",
    );
    const planId = plan.out.trim();
    const task = await run(
      home,
      repository,
      ["task", "add", "--plan", planId, "--slug", "one", "--title", "One"],
      "brief\n",
    );
    const taskId = task.out.trim();
    const cancelled = await run(home, repository, ["dev:cancel", taskId, "--yes"]);
    expect(cancelled.err).toBe("");

    const history = await run(home, repository, ["history", taskId]);
    expect(history.code).toBe(0);
    expect(history.out).toMatch(/dev:cancel \(via cli, as \S+\)/);

    const shown = await run(home, repository, ["show", taskId]);
    expect(shown.out).toContain("sections: Brief, Changes, Log (live), Diff, Metrics, History");
    const log = await run(home, repository, ["show", taskId, "--section", "log"]);
    expect(log.out).toContain("No worker log yet.");
    const metrics = await run(home, repository, ["show", taskId, "--section", "metrics"]);
    expect(metrics.out).toContain("No attempts yet.");
    const diff = await run(home, repository, ["show", taskId, "--section", "diff"]);
    expect(diff.code).toBe(0);
    expect(diff.out).toContain("No diff");
  });

  test("lists name the repository once more than one is registered", async () => {
    const { root, home, repository } = await setup();
    const other = await makeGitRepository(root, "other");
    expect((await run(home, repository, ["repo", "add", "."])).code).toBe(0);
    await run(home, repository, ["plan", "add", "--slug", "work", "--title", "A"], "r\n");
    const single = await run(home, repository, ["list", "plan"]);
    expect(single.out).toMatch(/^P-0001-work /);

    expect((await run(home, other, ["repo", "add", "."])).code).toBe(0);
    await run(home, other, ["plan", "add", "--slug", "work", "--title", "B"], "r\n");
    const both = await run(home, repository, ["list", "plan"]);
    expect(both.out).toContain("repository/P-0001-work");
    expect(both.out).toContain("other/P-0001-work");
    const json = JSON.parse(
      (await run(home, repository, ["list", "plan", "--json"])).out,
    ) as { rows: { scope?: string }[] };
    expect(json.rows.map((row) => row.scope).sort()).toEqual(["other", "repository"]);
  });
});
