/**
 * The end-to-end test: a real CLI, a real git remote, a real worker child and a
 * fake harness. It is opt-in with `OPERAD_TEST_E2E=1` because it starts
 * processes and takes a few seconds.
 *
 * A task runs worktree, work, verify (fails once), rework, verify, review, a
 * person wait, merge, integrate and cleanup. The run process is killed while
 * the first review is in flight, and the loop recovers it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupTempRoots,
  tempRoot,
} from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(
  new URL("../../cli/bin/operad.ts", import.meta.url),
);
const FAKE_HARNESS = fileURLToPath(
  new URL("./fixtures/fake-harness.ts", import.meta.url),
);

const INTERNAL_WORDS = [
  "graph",
  "node",
  "fact",
  "effect",
  "decide",
  "evolve",
  "runner",
  "backend",
];

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function runGit(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
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

/** Resolves when the file exists, without asking repeatedly: watches the directory. */
function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const handle = watch(path.slice(0, path.lastIndexOf("/")), () => {
      if (!existsSync(path)) return;
      handle.close();
      resolve();
    });
    handle.on("error", (error) => {
      handle.close();
      reject(error);
    });
    if (existsSync(path)) {
      handle.close();
      resolve();
    }
  });
}

/**
 * Waits for an external process to reach a state. The loop can only observe
 * the state by running the CLI, so it checks again shortly; every test run is
 * bounded.
 */
async function waitFor(
  check: () => Promise<boolean> | boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 50);
    });
  }
  throw new Error(`timed out waiting for ${message}`);
}

function pidOfRun(storeRoot: string, runId: string): number | undefined {
  const path = join(storeRoot, "locks", "runs", `${runId}.lock`);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" ? raw.pid : undefined;
  } catch {
    return undefined;
  }
}

function killRun(storeRoot: string, runId: string): void {
  const pid = pidOfRun(storeRoot, runId);
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

const e2eTest = process.env.OPERAD_TEST_E2E === "1" ? test : test.skip;

describe("dogfood end to end", () => {
  e2eTest(
    "a task survives a killed run and reaches a merge with a history of every step",
    async () => {
      const root = await tempRoot();
      const state = join(root, "state");
      mkdirSync(state, { recursive: true });

      // A bare origin, a seed checkout that pushes main, and a clone.
      const origin = join(root, "origin.git");
      runGit(root, ["init", "--bare", "-q", origin]);
      const seed = join(root, "seed");
      runGit(root, ["init", "-q", "-b", "main", seed]);
      mkdirSync(join(seed, "scripts"), { recursive: true });
      mkdirSync(join(seed, ".operad"), { recursive: true });
      writeFileSync(join(seed, "README.md"), "# fixture\n");
      writeFileSync(
        join(seed, "scripts", "verify.sh"),
        [
          "#!/bin/sh",
          "set -eu",
          'state="${FAKE_VERIFY_STATE:?FAKE_VERIFY_STATE is not set}"',
          'mkdir -p "$state"',
          'if [ ! -e "$state/failed-once" ]; then',
          '  touch "$state/failed-once"',
          '  echo "the first gate run fails" >&2',
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(seed, ".operad", "dev.json"),
        `${JSON.stringify(
          {
            name: "fixture",
            concurrency: 1,
            maxAutoRework: 2,
            worker: { use: "harness-fake/agent", args: [] },
            reviewer: {
              use: "harness-fake/agent",
              args: [],
              timeoutSecs: 60,
              fixLevel: "major",
            },
            gate: { commands: ["bash scripts/verify.sh"] },
            integration: { keyCommands: ["bash scripts/verify.sh"] },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(seed, ".operad", "worker-brief.md"),
        "Do the task. Commit the whole piece. Run bash scripts/verify.sh.\n",
      );
      runGit(seed, ["add", "-A"]);
      runGit(seed, [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "start",
      ]);
      runGit(seed, ["remote", "add", "origin", origin]);
      runGit(seed, ["push", "-q", "-u", "origin", "main"]);

      const repository = join(root, "work");
      runGit(root, ["clone", "-q", origin, repository]);

      const home = join(root, "home");
      const storeRoot = join(root, "store");
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "config.json"),
        `${JSON.stringify(
          {
            plugins: {
              shell: { module: "@operad-io/shell" },
              dev: { module: "@operad-io/dev" },
              "harness-fake": { module: FAKE_HARNESS },
            },
            store: { backend: "jsonl", path: storeRoot },
          },
          null,
          2,
        )}\n`,
      );

      const userOutput: string[] = [];
      const remember = (result: RunResult): RunResult => {
        userOutput.push(result.out);
        if (result.err.length > 0) userOutput.push(result.err);
        return result;
      };

      const added = remember(await run(home, repository, ["repo", "add", "."]));
      expect(added.code).toBe(0);

      const plan = remember(
        await run(
          home,
          repository,
          ["plan", "add", "--slug", "e2e", "--title", "End to end"],
          "Run the whole flow once.\n",
        ),
      );
      expect(plan.code).toBe(0);
      const planId = plan.out.trim();

      const task = remember(
        await run(
          home,
          repository,
          [
            "task",
            "add",
            "--plan",
            planId,
            "--slug",
            "flow",
            "--title",
            "The whole flow",
          ],
          "Change one file, then let the gate check it.\n",
        ),
      );
      expect(task.code).toBe(0);
      const taskId = task.out.trim();

      const confirmed = remember(
        await run(home, repository, ["dev:confirm", planId]),
      );
      expect(confirmed.code).toBe(0);

      const auto = remember(
        await run(home, repository, ["dev:auto", planId, "--level", "run"]),
      );
      expect(auto.code).toBe(0);

      const serveOutput = join(root, "serve.out");      const fd = openSync(serveOutput, "w");
      const serve = Bun.spawn({
        cmd: [process.execPath, CLI_ENTRY, "serve"],
        cwd: repository,
        env: {
          ...process.env,
          OPERAD_HOME: home,
          OPERAD_SERVE_INTERVAL_MS: "1000",
          FAKE_HARNESS_DIR: state,
          FAKE_VERIFY_STATE: state,
        },
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
      });
      closeSync(fd);

      let runId: string | undefined;
      try {
        // The first review has started and is waiting to be killed.
        await waitForFile(join(state, "review-once"));
        const running = remember(await run(home, repository, ["running", "--json"]));
        const runs = JSON.parse(running.out) as { runId: string }[];
        runId = runs[0]?.runId;
        expect(runId).toBeString();

        const pid = pidOfRun(storeRoot, runId ?? "");
        expect(pid).toBeNumber();
        process.kill(pid as number, "SIGKILL");

        // The loop starts the run again from its last recorded step.
        await waitFor(async () => {
          const pending = await run(home, repository, ["pending", "--json"]);
          const items = JSON.parse(pending.out) as { runId: string }[];
          return items.some((item) => item.runId === runId);
        }, "the recovered run to wait for a person");

        const pending = remember(await run(home, repository, ["pending"]));
        expect(pending.out).toContain("merge");
        expect(pending.out).toContain("reject");

        const merged = remember(
          await run(home, repository, ["dev:merge", taskId, "--yes"]),
        );
        expect(merged.code).toBe(0);

        await waitFor(async () => {
          const listed = await run(home, repository, ["list", "task", "--json"]);
          const page = JSON.parse(listed.out) as {
            rows: { id: string; state: string }[];
          };
          const row = page.rows.find((candidate) => candidate.id === taskId);
          return row?.state === "merged";
        }, "the task to merge");

        // The run ends after cleanup; stop the loop only then.
        await waitFor(async () => {
          const runningNow = await run(home, repository, ["running", "--json"]);
          return (JSON.parse(runningNow.out) as unknown[]).length === 0;
        }, "the run to finish cleanup");

        const history = remember(
          await run(home, repository, ["history", taskId]),
        );
        if (history.code !== 0) {
          throw new Error(`history failed: ${history.err}`);
        }
        expect(history.code).toBe(0);
        for (const line of [
          "started worktree",
          "started work",
          "verify fail",
          "rework again",
          "verify pass",
          "started review",
          "re-running review after a crash",
          "review pass",
          "waiting for you",
          "you chose merge",
          "integrate merged",
          "cleanup done",
          "run done",
        ]) {
          expect(history.out).toContain(line);
        }

        const shown = remember(
          await run(home, repository, ["show", taskId, "--json"]),
        );
        expect(shown.code).toBe(0);

        // A user of the kernel never reads an internal name.
        const text = userOutput.join("\n");
        for (const word of INTERNAL_WORDS) {
          expect(text).not.toMatch(new RegExp(`\\b${word}s?\\b`, "i"));
        }

        // The merge landed on the remote main and cleanup removed the branch.
        const remoteMain = runGit(origin, ["rev-parse", "refs/heads/main"]);
        expect(remoteMain).toMatch(/^[0-9a-f]{40}$/);
        expect(
          runGit(origin, ["for-each-ref", "--format=%(refname)", "refs/heads"]),
        ).not.toContain(`work/${taskId}`);
      } finally {
        serve.kill("SIGTERM");
        await serve.exited;
        if (runId !== undefined) killRun(storeRoot, runId);
      }
    },
    120_000,
  );
});
