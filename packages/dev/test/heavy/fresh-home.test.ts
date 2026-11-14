import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRemote } from "../git-support.ts";
import { cleanupTempRoots, osTempRoot } from "../support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../../cli/bin/operad.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function operad(
  home: string,
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<RunResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd,
    env: { ...process.env, OPERAD_HOME: home },
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

/** A worker that fails at once, so nothing after the start runs. */
function workerSource(): string {
  return [
    `import { definePlugin } from ${JSON.stringify(ENGINE)};`,
    `export default definePlugin({`,
    `  name: "fake", kind: "harness", version: "0.0.0",`,
    `  steps: [{ name: "agent", results: ["done", "failed", "interrupted"],`,
    `    async run() { return { result: "failed", data: {} }; } }],`,
    `});`,
    ``,
  ].join("\n");
}

/** Reads a stream until its text holds the line; a stream that ends first gives what it said. */
async function untilLine(stream: ReadableStream<Uint8Array>, line: string): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of stream) {
    seen += decoder.decode(chunk, { stream: true });
    if (seen.includes(line)) break;
  }
  return seen;
}

describe("a fresh home follows the Quickstart", () => {
  test("operad init, then the Quickstart's commands in order, start the task", async () => {
    const root = await osTempRoot();
    const home = join(root, "home");
    const repository = (await makeRemote(root)).repository;
    const workerPath = join(root, "fake-worker.ts");
    writeFileSync(workerPath, workerSource());

    const init = await operad(home, repository, ["init"]);
    // init exits 1 when a plugin check fails, such as a harness missing from this machine's PATH;
    // the config is written either way, and the checks are not what this test is about.
    expect(init.out).toContain("created");
    const configPath = join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugins: Record<string, unknown>;
      http: Record<string, unknown>;
    };
    // Step 1: dev runs its workers through pool, so init installs pool, before dev.
    const names = Object.keys(config.plugins);
    expect(names).toContain("pool");
    expect(names.indexOf("pool")).toBeLessThan(names.indexOf("dev"));
    config.plugins.fake = { module: workerPath, enabled: true };
    // The default port may be in use on the machine that runs the test.
    config.http = { ...config.http, enabled: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const add = await operad(home, repository, ["dev", "repo", "add", "."]);
    expect(add.code).toBe(0);
    writeFileSync(
      join(repository, ".operad", "dev.json"),
      `${JSON.stringify({
        name: "repository",
        workers: { fake: { use: "fake/agent" } },
        gate: { commands: ["true"], commandTimeoutSecs: 60 },
        reviewer: { use: "fake/agent" },
      })}\n`,
    );
    const plan = await operad(
      home,
      repository,
      ["dev", "plan", "add", "--slug", "hello", "--title", "Add a greeting"],
      "Say hello.\n",
    );
    expect(plan.code).toBe(0);
    expect(plan.out.trim()).toBe("P-0001-hello");
    const task = await operad(
      home,
      repository,
      ["dev", "task", "add", "--plan", "P-0001-hello", "--slug", "greet", "--title", "Print the greeting"],
      "Print hello.\n",
    );
    expect(task.code).toBe(0);
    expect((await operad(home, repository, ["dev:confirm", "P-0001-hello"])).code).toBe(0);
    // Step 2: a new plan's auto level is off, so the Quickstart starts the plan's tasks itself.
    const auto = await operad(home, repository, ["dev:auto", "P-0001-hello", "--level", "run"]);
    expect(auto.code).toBe(0);

    const serve = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: repository,
      env: { ...process.env, OPERAD_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain stderr so a chatty serve cannot fill the pipe and stall.
    void new Response(serve.stderr).text();
    try {
      // serve prints each change of a task's phase; the task leaves ready when it starts.
      // The bound only ends a wait that never gets its line, so serve is stopped below.
      const said = await Promise.race([
        untilLine(serve.stdout, "T-0001-greet ready -> running"),
        Bun.sleep(20_000).then(() => "no start in 20 seconds"),
      ]);
      expect(said).toContain("T-0001-greet ready -> running");
      const pending = await operad(home, repository, ["pending"]);
      expect(pending.out).not.toContain("plugin pool is not loaded");
    } finally {
      serve.kill();
      await serve.exited;
    }
  }, 60_000);
});
