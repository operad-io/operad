/**
 * A flow a plugin declares from a repository's settings or its own TypeScript
 * runs in a real serve: the serve process declares the graph, and the run's
 * own process finds it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileDevFlow } from "../../dev/src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { testEnv } from "./env.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const FAKE_HARNESS = fileURLToPath(new URL("./fixtures/fake-harness.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../engine/src/index.ts", import.meta.url));

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function git(cwd: string, args: readonly string[]): string {
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
): Promise<RunResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd,
    env: { ...testEnv(), OPERAD_HOME: home },
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

/** Resolves when `check` is true, looking again on every store write. */
function waitForStore(
  storeRoot: string,
  check: () => Promise<boolean>,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const watchers: FSWatcher[] = [];
    let settled = false;
    let checking = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A watch can miss an event under load, so a look every 100 ms backs it.
    let look: ReturnType<typeof setInterval> | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      for (const watcher of watchers) watcher.close();
      if (timer !== undefined) globalThis.clearTimeout(timer);
      if (look !== undefined) globalThis.clearInterval(look);
      if (error === undefined) resolve();
      else reject(error);
    };

    const evaluate = (): void => {
      if (settled) return;
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      void (async () => {
        try {
          if (await check()) finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        } finally {
          checking = false;
          if (again && !settled) {
            again = false;
            evaluate();
          }
        }
      })();
    };

    timer = globalThis.setTimeout(() => {
      finish(new Error(`timed out waiting for ${message}`));
    }, timeoutMs);

    for (const directory of [storeRoot]) {
      mkdirSync(directory, { recursive: true });
      const watcher = watch(directory, () => evaluate());
      watcher.on("error", (error) => finish(error));
      watchers.push(watcher);
    }
    look = globalThis.setInterval(evaluate, 100);
    evaluate();
  });
}

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly repository: string;
  readonly storeRoot: string;
}

async function fixture(options: {
  readonly flows?: object;
  readonly projectFlow?: string;
}): Promise<Fixture> {
  const root = await tempRoot();
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const repository = join(root, "work");
  git(root, ["init", "--bare", "-q", origin]);
  git(root, ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "# fixture\n");
  mkdirSync(join(seed, ".operad"), { recursive: true });
  writeFileSync(
    join(seed, ".operad", "dev.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        concurrency: 1,
        worker: { use: "harness-fake/agent", args: [] },
        gate: { commands: ["true"] },
        integration: { keyCommands: ["true"] },
        ...(options.flows === undefined ? {} : { flows: options.flows }),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(seed, ".operad", "worker-brief.md"), "Do the task.\n");
  if (options.projectFlow !== undefined) {
    mkdirSync(join(seed, ".operad", "flows"), { recursive: true });
    const graph = compileDevFlow("mine", [
      { stage: "work" },
      { stage: "check" },
      { stage: "human" },
    ]);
    writeFileSync(
      join(seed, ".operad", "flows", "mine.flow.ts"),
      [
        `import { defineFlow } from ${JSON.stringify(ENGINE)};`,
        `export default defineFlow(${JSON.stringify(graph)} as never);`,
        "",
      ].join("\n"),
    );
  }
  git(seed, ["add", "-A"]);
  git(seed, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "start",
  ]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  git(root, ["clone", "-q", "-b", "main", origin, repository]);

  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    `${JSON.stringify(
      {
        plugins: {
          shell: { module: "@operad-io/shell" },
          dev: { module: "@operad-io/dev" },
          pool: { module: "@operad-io/pool" },
          "harness-fake": { module: FAKE_HARNESS },
        },
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
        http: { enabled: false },
      },
      null,
      2,
    )}\n`,
  );
  return { root, home, repository, storeRoot: join(root, "store") };
}

async function runFlowByName(
  prepared: Fixture,
  flow: { readonly name: string; readonly pattern: RegExp },
): Promise<void> {
  const { home, repository, storeRoot } = prepared;
  const cli = (args: readonly string[], input?: string) => run(home, repository, args, input);

  const added = await cli(["repo", "add", "."]);
  if (added.code !== 0) throw new Error(`repo add failed: ${added.err}`);
  const plan = await cli(
    ["plan", "add", "--slug", "flow", "--title", "Flow", "--flow", flow.name],
    "Run the whole flow once.\n",
  );
  if (plan.code !== 0) throw new Error(`plan add failed: ${plan.err}`);
  const planId = plan.out.trim();
  const task = await cli(
    ["task", "add", "--plan", planId, "--slug", "task", "--title", "Task"],
    "Change one file.\n",
  );
  if (task.code !== 0) throw new Error(`task add failed: ${task.err}`);
  const taskId = task.out.trim();
  const confirmed = await cli(["dev:confirm", planId]);
  if (confirmed.code !== 0) throw new Error(`dev:confirm failed: ${confirmed.err}`);
  const auto = await cli(["dev:auto", planId, "--level", "run"]);
  if (auto.code !== 0) throw new Error(`dev:auto failed: ${auto.err}`);

  const output = join(prepared.root, "serve.out");
  const fd = openSync(output, "w");
  const serve = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "serve"],
    cwd: repository,
    env: {
      ...testEnv(),
      OPERAD_HOME: home,
      OPERAD_SERVE_INTERVAL_MS: "100",
    },
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      serve.kill("SIGTERM");
    } catch {
      // It already ended.
    }
    await serve.exited;
  };

  const taskRow = async (): Promise<{ state?: string } | undefined> => {
    const listed = await cli(["list", "task", "--filter", "all", "--json"]);
    if (listed.code !== 0 || listed.out.length === 0) {
      throw new Error(`list task failed (code ${listed.code}): ${listed.err}`);
    }
    const page = JSON.parse(listed.out) as { rows: { id: string; state: string }[] };
    return page.rows.find((row) => row.id === taskId);
  };

  try {
    await waitForStore(
      storeRoot,
      async () => (await taskRow())?.state === "waiting",
      "the run to reach the human stage",
    );

    const flows = await cli(["flows", "--json"]);
    if (flows.code !== 0) throw new Error(`flows failed: ${flows.err}`);
    const names = (JSON.parse(flows.out) as { name: string }[]).map((entry) => entry.name);
    if (!names.some((name) => flow.pattern.test(name))) {
      let files: string[] = [];
      try {
        files = readdirSync(join(storeRoot, "plugins", "flows"));
      } catch {
        // No stored flow directory at all.
      }
      throw new Error(
        `flows did not list ${flow.pattern}: ${flows.out}\nstored flows: ${files.join(", ")}`,
      );
    }

    const merged = await cli(["dev:merge", taskId, "--yes"]);
    if (merged.code !== 0) {
      throw new Error(`dev:merge failed: ${merged.err}`);
    }
    await waitForStore(
      storeRoot,
      async () => (await taskRow())?.state === "merged",
      "the task to merge",
    );
    await waitForStore(
      storeRoot,
      async () => {
        const running = await cli(["running", "--json"]);
        if (running.code !== 0 || running.out.length === 0) {
          throw new Error(`running failed (code ${running.code}): ${running.err}`);
        }
        return (JSON.parse(running.out) as unknown[]).length === 0;
      },
      "the run to finish cleanup",
    );
  } catch (error) {
    const seen = existsSync(output) ? readFileSync(output, "utf8") : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${seen}`);
  } finally {
    await stop();
  }

  const history = await cli(["history", taskId]);
  expect(history.code).toBe(0);
  for (const line of [
    "started work",
    "check pass",
    "waiting for you",
    "you chose merge",
    "integrate merged",
    "cleanup done",
    "run done",
  ]) {
    expect(history.out).toContain(line);
  }
}

describe("a flow a plugin declares runs in a real serve", () => {
  test(
    "a dev.json flow runs its stages end to end",
    async () => {
      const prepared = await fixture({
        flows: {
          default: { stages: [{ stage: "work" }, { stage: "check" }, { stage: "human" }] },
        },
      });
      await runFlowByName(prepared, { name: "default", pattern: /^dev\/.*\/default\// });
    },
    60_000,
  );

  test(
    "a TypeScript flow runs its stages end to end",
    async () => {
      const prepared = await fixture({ projectFlow: "mine" });
      await runFlowByName(prepared, { name: "mine", pattern: /^dev\/.*\/mine\// });
    },
    60_000,
  );
});
