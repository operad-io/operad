import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
