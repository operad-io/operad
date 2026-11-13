/**
 * The acceptance of docs/backlog/operad-open-framework.md: a repository that
 * is not JavaScript, with no package.json, no scripts/ directory and no
 * CLAUDE.md, goes from plan to merge with only its `.operad/dev.json`. A stub
 * worker and a stub reviewer stand in for the agents; nothing sleeps.
 */

import { createPoolPlugin } from "@operad-io/pool";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin, PluginRegistry, type PluginStepResult } from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import { notCodeTestHooks } from "../../src/notcode.ts";
import { addPlan, addRepository, addTask, confirmPlan, createDevPlugin, listAll, taskData, validateDevSettings } from "../../src/index.ts";
import { appendFileSync } from "node:fs";
import { gitOrThrow, makeRemote, type RemoteSetup } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, osTempRoot, storeAt } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();
afterEach(() => {
  notCodeTestHooks.load = undefined;
  delete process.env.EXAMPLE_FLAKY;
});

const EXAMPLE = fileURLToPath(new URL("../fixtures/example-repo", import.meta.url));
const USER_DOC = fileURLToPath(new URL("../../../../docs/user/quickstart.md", import.meta.url));

/** What this repository's own conventions look like in a file or a prompt. */
const CONVENTIONS = /\bbun\b|bun\.lock|\bscripts\/|CLAUDE\.md|\bpackages\//i;

/** Every text file under a directory, except git's own and nested checkouts. */
function filesUnder(directory: string, skip: readonly string[] = [".git", ".operad-worktrees"]): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      if (skip.includes(name)) continue;
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.set(relative(directory, full), readFileSync(full, "utf8"));
    }
  };
  walk(directory);
  return found;
}

function conventionsIn(files: ReadonlyMap<string, string>): string[] {
  return [...files].filter(([, text]) => CONVENTIONS.test(text)).map(([name]) => name);
}

interface Prompts {
  readonly worker: string[];
  readonly reviewer: string[];
}

/** A worker that commits one file and a reviewer that finds nothing; each keeps the prompts it got. */
function stubs(prompts: Prompts) {
  const harness = (name: string, run: (input: { prompt: string; cwd: string; resultPath?: string }) => void) =>
    definePlugin({
      name,
      kind: "harness",
      version: "0.0.0",
      steps: [
        {
          name: "agent",
          results: ["done", "failed", "interrupted"],
          async run(_ctx, params): Promise<PluginStepResult> {
            run(params as { prompt: string; cwd: string; resultPath?: string });
            return { result: "done", data: {} };
          },
        },
      ],
    });
  const worker = harness("stub-worker", (input) => {
    prompts.worker.push(input.prompt);
    writeFileSync(join(input.cwd, "lib", "farewell.sh"), "farewell() {\n  printf 'goodbye, %s\\n' \"$1\"\n}\n");
    gitOrThrow(input.cwd, ["add", "lib/farewell.sh"]);
    gitOrThrow(input.cwd, ["-c", "user.name=w", "-c", "user.email=w@example.com", "commit", "-qm", "add farewell"]);
  });
  const reviewer = harness("stub-reviewer", (input) => {
    prompts.reviewer.push(input.prompt);
    const sha = gitOrThrow(input.cwd, ["rev-parse", "HEAD"]);
    writeFileSync(input.resultPath ?? "", JSON.stringify({ findings: [], verified: ["the diff"], sha }));
  });
  return [worker, reviewer];
}

/** The example repository as a git clone with an origin, its dev.json plus the two stubs. */
async function exampleFixture() {
  const root = await osTempRoot();
  const remote: RemoteSetup = await makeRemote(root);
  cpSync(EXAMPLE, remote.seed, { recursive: true, filter: (path) => !path.endsWith(`${"example-repo"}/.operad`) && !path.includes("/.operad/") });
  gitOrThrow(remote.seed, ["add", "."]);
  gitOrThrow(remote.seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "the example"]);
  gitOrThrow(remote.seed, ["push", "origin", "main"]);
  gitOrThrow(remote.repository, ["pull", "--ff-only", "origin", "main"]);

  // The settings stay local to the clone; the stubs are the only keys added to the example's own.
  const given = JSON.parse(readFileSync(join(EXAMPLE, ".operad", "dev.json"), "utf8")) as Record<string, unknown>;
  mkdirSync(join(remote.repository, ".operad"), { recursive: true });
  writeFileSync(
    join(remote.repository, ".operad", "dev.json"),
    JSON.stringify({
      ...given,
      worker: { use: "stub-worker/agent", args: [] },
      reviewer: { use: "stub-reviewer/agent", args: [] },
    }),
  );
  appendFileSync(join(remote.repository, ".git", "info", "exclude"), ".operad/\n");

  const store = storeAt(root);
  const repository = await addRepository(store, { path: remote.repository, name: "greeter" });
  const plan = await addPlan(store, { repository, slug: "farewell", title: "Farewell", request: "say goodbye" });
  const task = await addTask(store, { plan: plan.id, slug: "farewell", title: "Add a farewell", brief: "Add lib/farewell.sh." });
  await confirmPlan(store, plan.id);
  const prompts: Prompts = { worker: [], reviewer: [] };
  const registry = new PluginRegistry(
    [createDevPlugin(), createShellPlugin(), createPoolPlugin(), ...stubs(prompts)],
    { home: root, cwd: remote.repository, store },
  );
  const object = { type: "task", id: task.id, data: {} };
  const step = (name: string, runId: string) => registry.runStep(`dev/${name}`, {}, { runId, object, emit: () => undefined });
  const taskId = task.id.slice(task.id.indexOf("/") + 1);
  const checkouts = join(remote.repository, ".operad-worktrees");
  return { root, remote, store, registry, prompts, step, worktree: join(checkouts, taskId), gate: join(checkouts, `${taskId}-gate`) };
}

describe("a repository that is not JavaScript", () => {
  test("the example has no package.json, scripts/ directory or CLAUDE.md, and its dev.json is valid", () => {
    const files = filesUnder(EXAMPLE, [".git"]);
    expect([...files.keys()].filter((name) => /package\.json|CLAUDE\.md|^scripts\//.test(name))).toEqual([]);
    expect(conventionsIn(files)).toEqual([]);
    const settings = validateDevSettings(JSON.parse(files.get(join(".operad", "dev.json")) ?? "{}"));
    expect(settings.gate.commands).toHaveLength(1);
  });

  test("a plan and a task go from add through work, check, review and merge without bun or its conventions", async () => {
    const state = await exampleFixture();
    expect(await state.step("worktree", "worktree-run")).toMatchObject({ result: "ready" });
    // `prepare` ran in the checkout the worker uses.
    expect(readFileSync(join(state.worktree, ".prepared"), "utf8")).toBe("prepared\n");

    expect((await state.step("work", "work-run")).result).toBe("done");
    expect((await state.step("verify", "verify-run")).result).toBe("pass");
    expect(readFileSync(join(state.gate, ".prepared"), "utf8")).toBe("prepared\n");
    expect((await state.step("review", "review-run")).result).toBe("pass");

    const checkouts = [state.worktree, state.gate];
    for (const checkout of checkouts) expect(conventionsIn(filesUnder(checkout))).toEqual([]);
    expect(conventionsIn(new Map([...state.prompts.worker, ...state.prompts.reviewer].map((text, i) => [`prompt ${i}`, text])))).toEqual([]);
    expect(state.prompts.worker).toHaveLength(1);
    expect(state.prompts.reviewer).toHaveLength(1);

    expect((await state.step("integrate", "integrate-run")).result).toBe("merged");
    const merged = taskData((await state.store.get("task", (await listAll(state.store, "task"))[0]?.id ?? ""))?.data ?? {});
    expect(merged.phase).toBe("merged");

    // The merged main clone has the new file, ran `prepare` after the fast-forward, and shows no convention.
    const clone = state.remote.repository;
    expect(existsSync(join(clone, "lib", "farewell.sh"))).toBe(true);
    expect(readFileSync(join(clone, ".prepared"), "utf8")).toBe("prepared\n");
    expect(conventionsIn(filesUnder(clone))).toEqual([]);
    expect((await state.step("cleanup", "cleanup-run")).result).not.toBe("failed");
  });

  test("a check that failed and then passed gives a flaky brief with the repository's own command and rule", async () => {
    notCodeTestHooks.load = () => ({ load1: 0, cores: 10 });
    const state = await exampleFixture();
    await state.step("worktree", "worktree-run");
    await state.step("work", "work-run");
    // Only a run of all the tests fails it; the rerun by name passes.
    process.env.EXAMPLE_FLAKY = "cart_totals";
    const first = await state.step("verify", "verify-1");
    expect(first.result).toBe("pass");
    expect(String(first.data?.note)).toContain("passed on rerun: cart_totals");
    await state.step("verify", "verify-2");

    const flaky = (await listAll(state.store, "task")).filter((object) => taskData(object.data).title.startsWith("Fix the flaky test"));
    expect(flaky).toHaveLength(1);
    const brief = taskData(flaky[0]?.data ?? {});
    expect(brief.title).toBe("Fix the flaky test: cart_totals");
    expect(brief.area).toBeUndefined();
    expect(brief.brief).toContain("FAIL: cart_totals");
    expect(brief.brief).toContain("sh check.sh --repeat 20 'cart_totals'");
    expect(brief.brief).toContain("not hide the failure with a longer wait or a retry");
    expect(conventionsIn(new Map([["brief", brief.brief]]))).toEqual([]);
  });

  test("the quickstart shows the same dev.json as the example", () => {
    const text = readFileSync(USER_DOC, "utf8");
    const section = text.slice(text.indexOf("## A repository that is not JavaScript"));
    const block = /<!-- schema: dev\.schema\.json -->\s*\n```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(block).toBeDefined();
    expect(JSON.parse(block ?? "")).toEqual(JSON.parse(readFileSync(join(EXAMPLE, ".operad", "dev.json"), "utf8")));
  });
});
