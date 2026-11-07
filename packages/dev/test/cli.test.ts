import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  loadPluginRegistry,
  openConfigLog,
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
    expect(planId).toBe("PL0001-alpha");

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
    expect(taskId).toBe("TK0001-first");

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
    expect(second.err).toContain("not available");

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
      taskId,
      "--title",
      "Nowhere",
    ]);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("--repo");

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
    expect(taskA.out.trim()).toBe("TK0001-work");

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
    expect(taskB.out.trim()).toBe("TK0001-work");

    const shown = await run(home, repository, [
      "show",
      "TK0001-work",
      "--section",
      "brief",
      "--raw",
    ]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("brief A");
    expect(shown.out).not.toContain("brief B");

    const confirmed = await run(home, repository, [
      "dev:confirm",
      "PL0001-work",
    ]);
    expect(confirmed.code).toBe(0);
    const shownA = await run(home, repository, ["show", "TK0001-work"]);
    expect(shownA.out).toContain("TK0001-work  ready  A task");
    const shownB = await run(home, other, ["show", "TK0001-work"]);
    expect(shownB.out).toContain("TK0001-work  proposed  B task");

    const ambiguous = await run(home, home, ["show", "TK0001-work"]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain("ambiguous");
  });
});
