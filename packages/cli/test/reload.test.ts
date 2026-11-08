import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLockPid } from "../../engine/src/index.ts";
import { waitForChange } from "../../engine/src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { waitForFile } from "../../shell/test/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../engine/src/index.ts", import.meta.url));
const PLATFORM = fileURLToPath(new URL("../../engine/src/platform/index.ts", import.meta.url));

/** The plugin of every test: `hold` waits for a file, `stamp` writes the version of its code. */
function pluginSource(version: string, work: string): string {
  return `
import { defineFlow, definePlugin } from ${JSON.stringify(ENGINE)};
import { waitForChange } from ${JSON.stringify(PLATFORM)};
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const VERSION = ${JSON.stringify(version)};
const WORK = ${JSON.stringify(work)};

const flow = defineFlow({
  name: "twostep",
  entry: "hold",
  steps: [
    { id: "hold", kind: "plugin", params: { use: "reloadflow/hold", params: {} }, replay: "safe", next: { ready: "stamp" } },
    { id: "stamp", kind: "plugin", params: { use: "reloadflow/stamp", params: {} }, replay: "safe", next: { ready: "done" } },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

export default definePlugin({
  name: "reloadflow",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "job" }],
  flows: [flow],
  steps: [
    {
      name: "hold",
      results: ["ready"],
      async run() {
        writeFileSync(WORK + "/hold-started", VERSION);
        const release = WORK + "/release";
        while (!existsSync(release)) await waitForChange(dirname(release), basename(release), 200);
        writeFileSync(WORK + "/hold-finished", VERSION);
        return { result: "ready" };
      },
    },
    {
      name: "stamp",
      results: ["ready"],
      async run() {
        writeFileSync(WORK + "/stamp", VERSION);
        return { result: "ready" };
      },
    },
  ],
});
`;
}

/** The output of a process, as text that tests wait on instead of sleeping. */
class Output {
  text = "";
  private readonly waiters: Array<() => void> = [];

  constructor(...streams: ReadableStream<Uint8Array>[]) {
    for (const stream of streams) {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          this.text += decoder.decode(chunk, { stream: true });
          for (const wake of this.waiters.splice(0)) wake();
        }
      })();
    }
  }

  /** Resolves with the count of matches once `pattern` matches at least `count` times. */
  async until(pattern: RegExp, count = 1): Promise<void> {
    const global = new RegExp(pattern.source, "g");
    while ((this.text.match(global)?.length ?? 0) < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Resolves once the file holds text that matches. */
async function waitForText(path: string, pattern: RegExp): Promise<void> {
  for (;;) {
    try {
      if (pattern.test(readFileSync(path, "utf8"))) return;
    } catch {
      // Not there yet.
    }
    await waitForChange(dirname(path), basename(path), 200);
  }
}

interface Setup {
  readonly home: string;
  readonly work: string;
  readonly plugin: string;
  readonly env: Record<string, string>;
}

async function setup(): Promise<Setup> {
  const root = await tempRoot();
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const plugin = join(home, "reloadflow.ts");
  writeFileSync(plugin, pluginSource("v1", work));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [plugin],
      store: { backend: "jsonl", path: join(root, "store") },
      http: { enabled: false },
    }),
  );
  writeFileSync(
    join(home, "triggers.json"),
    JSON.stringify([
      { source: "cron", type: "tick", start: { flow: "twostep" }, object: "job:1", mode: "auto" },
    ]),
  );
  return {
    home,
    work,
    plugin,
    env: {
      OPERAD_HOME: home,
      OPERAD_SERVE_INTERVAL_MS: "100",
      OPERAD_RELOAD_QUIET_MS: "100",
      OPERAD_RELOAD_POLL_MS: "500",
    },
  };
}

function spawnOperad(setupValue: Setup, args: readonly string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: setupValue.home,
    env: { ...(process.env as Record<string, string>), ...setupValue.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function operad(setupValue: Setup, args: readonly string[]): Promise<string> {
  const child = spawnOperad(setupValue, args);
  const [, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return out;
}

/** `operad trigger` prints the run id and then stays; the test ends it. */
async function trigger(setupValue: Setup): Promise<string> {
  const child = spawnOperad(setupValue, ["trigger", "cron", "t1", "--type", "tick"]);
  const output = new Output(child.stdout);
  await output.until(/started \S+\n/);
  child.kill("SIGTERM");
  await child.exited;
  return /started (\S+)/.exec(output.text)?.[1] ?? "";
}

async function stopServe(setupValue: Setup): Promise<void> {
  await operad(setupValue, ["serve", "stop"]);
}

describe("a serve picks up changed code", () => {
  test("a running step finishes on the old code; the next step runs the new code", async () => {
    const s = await setup();
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    try {
      await output.until(/serving /);
      const firstPid = readLockPid(join(s.home, "serve.lock"));
      const runId = await trigger(s);
      await waitForFile(join(s.work, "hold-started"));
      expect(readFileSync(join(s.work, "hold-started"), "utf8")).toBe("v1");

      writeFileSync(s.plugin, pluginSource("v2", s.work));
      await output.until(/reloading: /);
      await output.until(/serving /, 2);
      const secondPid = readLockPid(join(s.home, "serve.lock"));
      expect(secondPid).not.toBe(firstPid);

      // The step that was running when the file changed goes on and ends on v1.
      expect(existsSync(join(s.work, "hold-finished"))).toBe(false);
      writeFileSync(join(s.work, "release"), "go\n");
      await waitForFile(join(s.work, "stamp"));
      expect(readFileSync(join(s.work, "hold-finished"), "utf8")).toBe("v1");
      expect(readFileSync(join(s.work, "stamp"), "utf8")).toBe("v2");

      const history = await operad(s, ["history", runId]);
      expect(history.split("\n").filter((line) => line.includes("continuing on updated code"))).toHaveLength(1);
    } finally {
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);

  test("code that does not load leaves the old code running; fixing it reloads", async () => {
    const s = await setup();
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    try {
      await output.until(/serving /);
      const pid = readLockPid(join(s.home, "serve.lock"));
      const runId = await trigger(s);
      await waitForFile(join(s.work, "hold-started"));

      writeFileSync(s.plugin, "export default {{ not typescript\n");
      await output.until(/does not load; the old code keeps running/);
      expect(readLockPid(join(s.home, "serve.lock"))).toBe(pid);
      expect(output.text).not.toContain("reloading:");

      // The run's process sees the same files: it does not take the next step
      // on code that does not load, and says why.
      writeFileSync(join(s.work, "release"), "go\n");
      const runLog = join(s.home, "..", "store", "logs", "runs", `${runId}.out`);
      await waitForText(runLog, /does not load; the old code keeps running/);
      expect(existsSync(join(s.work, "stamp"))).toBe(false);
      expect(readLockPid(join(s.home, "serve.lock"))).toBe(pid);

      writeFileSync(s.plugin, pluginSource("v3", s.work));
      await output.until(/reloading: /);
      await output.until(/serving /, 2);
      expect(readLockPid(join(s.home, "serve.lock"))).not.toBe(pid);

      // The run goes on from the next step with the fixed code.
      await waitForFile(join(s.work, "stamp"));
      expect(readFileSync(join(s.work, "hold-finished"), "utf8")).toBe("v1");
      expect(readFileSync(join(s.work, "stamp"), "utf8")).toBe("v3");

    } finally {
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);

  test("a settings file that does not read during a change is read again when it is fixed", async () => {
    const s = await setup();
    const configPath = join(s.home, "config.json");
    const config = readFileSync(configPath, "utf8");
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    try {
      await output.until(/serving /);
      const pid = readLockPid(join(s.home, "serve.lock"));
      const runId = await trigger(s);
      await waitForFile(join(s.work, "hold-started"));

      // New code and a config.json that does not parse: nothing can load.
      writeFileSync(configPath, "{ not json");
      writeFileSync(s.plugin, pluginSource("v2", s.work));
      await output.until(/does not load; the old code keeps running/);
      expect(readLockPid(join(s.home, "serve.lock"))).toBe(pid);

      writeFileSync(join(s.work, "release"), "go\n");
      const runLog = join(s.home, "..", "store", "logs", "runs", `${runId}.out`);
      await waitForText(runLog, /does not load; the old code keeps running/);
      expect(existsSync(join(s.work, "stamp"))).toBe(false);

      // The same text, written again: the code did not change, the settings did.
      writeFileSync(configPath, config);
      await output.until(/reloading: /);
      await output.until(/serving /, 2);
      await waitForFile(join(s.work, "stamp"));
      expect(readFileSync(join(s.work, "stamp"), "utf8")).toBe("v2");
      expect(readLockPid(join(s.home, "serve.lock"))).not.toBe(pid);
    } finally {
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);
});
