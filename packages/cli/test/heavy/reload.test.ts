import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPERVISED_ENV } from "../../src/code-reload.ts";
import { networkInterfaces } from "node:os";
import { readHttpToken, readLockPid } from "../../../engine/src/index.ts";
import { waitForChange } from "../../../engine/src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));
const PLATFORM = fileURLToPath(new URL("../../../engine/src/platform/index.ts", import.meta.url));
const SUPERVISE = fileURLToPath(new URL("../fixtures/supervise-serve.ts", import.meta.url));
const LSOF = Bun.which("lsof");

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
  async onTick() {
    if (existsSync(WORK + "/tick-fails")) throw new Error("tick broke");
    if (existsSync(WORK + "/tick-block")) {
      writeFileSync(WORK + "/tick-entered", "");
      while (!existsSync(WORK + "/tick-release")) await waitForChange(WORK, "tick-release", 200);
    }
  },
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

/**
 * A plugin that keeps the serve process alive after its stop and, on request,
 * reports the signal handlers the process has at that moment.
 */
function heldPluginSource(work: string): string {
  return `
import { definePlugin } from ${JSON.stringify(ENGINE)};
import { existsSync, renameSync, writeFileSync } from "node:fs";

const WORK = ${JSON.stringify(work)};

// The serve's stop ends the kernel's work, not this handle: a terminal or a
// supervisor still holds the process afterwards. Each turn answers a probe
// with the signal handlers the process listens with.
setInterval(() => {
  if (!existsSync(WORK + "/probe")) return;
  // Written aside and renamed, so a reader that sees the file sees all of it.
  writeFileSync(WORK + "/listeners.tmp", process.listenerCount("SIGINT") + " " + process.listenerCount("SIGTERM"));
  renameSync(WORK + "/listeners.tmp", WORK + "/listeners");
}, 20);

export default definePlugin({ name: "heldserve", kind: "domain", version: "0.0.1" });
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
    for (;;) {
      if ((this.text.match(global)?.length ?? 0) >= count) return;
      const remaining = waitDeadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for output matching ${pattern} (${count}x); got:\n${this.text}`);
      }
      // A chunk wakes the wait; the timer only enforces the deadline, so no
      // test pays a poll interval while it waits for output.
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve();
        };
        timer = setTimeout(wake, remaining);
        this.waiters.push(wake);
      });
    }
  }
}

/** A test's whole wait budget, so a later wait cannot reach bun's test timeout first. */
const WAIT_LIMIT_MS = 45_000;
let waitDeadline = 0;
beforeEach(() => {
  waitDeadline = Date.now() + WAIT_LIMIT_MS;
});

/** Resolves once the file exists. */
async function waitForFileNamed(path: string): Promise<void> {
  while (!existsSync(path)) {
    if (Date.now() > waitDeadline) throw new Error(`timed out waiting for file ${path}`);
    await waitForChange(dirname(path), basename(path), 200);
  }
}

/** Resolves once the file is gone. */
async function waitForFileGone(path: string): Promise<void> {
  while (existsSync(path)) {
    if (Date.now() > waitDeadline) throw new Error(`timed out waiting for ${path} to go`);
    await waitForChange(dirname(path), basename(path), 200);
  }
}

/** Resolves once the file holds text that matches. */
async function waitForText(path: string, pattern: RegExp): Promise<void> {
  for (;;) {
    if (Date.now() > waitDeadline) throw new Error(`timed out waiting for text ${pattern} in ${path}`);
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

interface HttpSetup {
  readonly port: number;
  readonly listen: readonly string[];
}

async function setup(http?: HttpSetup): Promise<Setup> {
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
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      http: http === undefined ? { enabled: false } : { enabled: true, port: http.port, listen: http.listen },
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

/** The environment of a serve under test: a test run from inside a supervised serve must not make it think it is supervised. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...(process.env as Record<string, string>), ...extra };
  delete env[SUPERVISED_ENV];
  return env;
}

function spawnOperad(setupValue: Setup, args: readonly string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: setupValue.home,
    env: childEnv(setupValue.env),
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

/** The files a process has open, when the system can list them. */
function openFiles(pid: number): string[] {
  if (LSOF === null) return [];
  const result = Bun.spawnSync({
    cmd: [LSOF, "-p", String(pid), "-Fn"],
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

async function runFirstCase(): Promise<void> {
  const s = await setup();
  const serve = spawnOperad(s, ["serve"]);
  const output = new Output(serve.stdout, serve.stderr);
  try {
    await output.until(/serving /);
    const firstPid = readLockPid(join(s.home, "serve.lock"));
    const runId = await trigger(s);
    await waitForText(join(s.work, "hold-started"), /^v1$/);
    expect(readFileSync(join(s.work, "hold-started"), "utf8")).toBe("v1");

    writeFileSync(s.plugin, pluginSource("v2", s.work));
    await output.until(/reloading: /);
    await output.until(/serving /, 2);
    const secondPid = readLockPid(join(s.home, "serve.lock"));
    expect(secondPid).not.toBe(firstPid);
    // The process that was started is still the one running: the restart
    // happened under it, so a terminal or supervisor still holds it.
    expect(serve.exitCode).toBeNull();

    // The step that was running when the file changed goes on and ends on v1.
    expect(existsSync(join(s.work, "hold-finished"))).toBe(false);
    writeFileSync(join(s.work, "release"), "go\n");
    await waitForText(join(s.work, "stamp"), /^v2$/);
    expect(readFileSync(join(s.work, "hold-finished"), "utf8")).toBe("v1");
    expect(readFileSync(join(s.work, "stamp"), "utf8")).toBe("v2");

    const history = await operad(s, ["history", runId]);
    expect(history.split("\n").filter((line) => line.includes("continuing on updated code"))).toHaveLength(1);

    // A serve that came from a reload reloads again, under the same process.
    writeFileSync(s.plugin, pluginSource("v4", s.work));
    await output.until(/serving /, 3);
    expect(readLockPid(join(s.home, "serve.lock"))).not.toBe(secondPid);
    expect(serve.exitCode).toBeNull();
  } finally {
    await stopServe(s);
    expect(await serve.exited).toBe(0);
  }
}

test.skipIf(LSOF === null)("the process that becomes the supervisor closes the old plugin store on reload", async () => {
  const s = await setup();
  const serve = spawnOperad(s, ["serve"]);
  const output = new Output(serve.stdout, serve.stderr);
  try {
    await output.until(/serving /);
    const pid = serve.pid;
    if (pid === undefined) throw new Error("serve has no pid");
    expect(readLockPid(join(s.home, "serve.lock"))).toBe(pid);

    writeFileSync(s.plugin, pluginSource("v2", s.work));
    await output.until(/reloading: /);
    await output.until(/serving /, 2);
    expect(serve.exitCode).toBeNull();

    // This process is now the supervisor. Its old serve context held the
    // plugin store open; the new child needs the file to itself.
    const files = openFiles(pid);
    expect(files.filter((path) => path.includes("/plugins.sqlite"))).toEqual([]);
  } finally {
    await stopServe(s);
    await serve.exited;
  }
}, 60_000);

describe("a serve picks up changed code", () => {
  test("a running step finishes on the old code; the next step runs the new code", async () => {
    await runFirstCase();
  }, 60_000);

  test("the same case passes when the test itself runs inside a supervised serve", async () => {
    const before = process.env[SUPERVISED_ENV];
    process.env[SUPERVISED_ENV] = "1";
    try {
      await runFirstCase();
    } finally {
      if (before === undefined) delete process.env[SUPERVISED_ENV];
      else process.env[SUPERVISED_ENV] = before;
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
      await waitForFileNamed(join(s.work, "hold-started"));

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
      await waitForText(join(s.work, "stamp"), /^v3$/);
      expect(readFileSync(join(s.work, "hold-finished"), "utf8")).toBe("v1");
      expect(readFileSync(join(s.work, "stamp"), "utf8")).toBe("v3");

    } finally {
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);

  test("the older-code notice is cleared when serve starts and when it stops", async () => {
    const s = await setup();
    const notice = join(s.home, "serve-older.json");
    // A notice a serve that crashed left behind.
    writeFileSync(notice, `${JSON.stringify({ pid: 1 })}\n`);
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    try {
      await output.until(/serving /);
      expect(existsSync(notice)).toBe(false);
      writeFileSync(s.plugin, "export default {{ not typescript\n");
      await output.until(/does not load; the old code keeps running/);
      await waitForFileNamed(notice);
    } finally {
      await stopServe(s);
      expect(await serve.exited).toBe(0);
    }
    expect(existsSync(notice)).toBe(false);
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
      await waitForFileNamed(join(s.work, "hold-started"));

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
      await waitForText(join(s.work, "stamp"), /^v2$/);
      expect(readFileSync(join(s.work, "stamp"), "utf8")).toBe("v2");
      expect(readLockPid(join(s.home, "serve.lock"))).not.toBe(pid);
    } finally {
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);

  test("a failure the running code logged does not make code that does not load pass", async () => {
    const s = await setup();
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    try {
      await output.until(/serving /);
      const pid = readLockPid(join(s.home, "serve.lock"));
      writeFileSync(join(s.work, "tick-fails"), "");
      await output.until(/plugin "reloadflow": onTick failed/);

      writeFileSync(s.plugin, "export default {{ not typescript\n");
      await output.until(/does not load; the old code keeps running/);
      expect(readLockPid(join(s.home, "serve.lock"))).toBe(pid);
      expect(output.text).not.toContain("reloading:");
    } finally {
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);

  test("a triggers.json that did not read at start does not make code that loads look broken", async () => {
    const s = await setup();
    writeFileSync(
      join(s.home, "triggers.json"),
      JSON.stringify([
        { source: "cron", type: "tick", start: { flow: "nope" }, object: "job:1", mode: "auto" },
      ]),
    );
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    try {
      await output.until(/unknown flow "nope"/);
      await output.until(/serving /);
      writeFileSync(s.plugin, pluginSource("v2", s.work));
      await output.until(/reloading: /);
      await output.until(/serving /, 2);
      expect(output.text).not.toContain("does not load");
    } finally {
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);

  test("a stop signal that arrives twice after a reload still stops the serve gracefully", async () => {
    const s = await setup();
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    await output.until(/serving /);
    writeFileSync(s.plugin, pluginSource("v2", s.work));
    await output.until(/serving /, 2);
    // The terminal sends Ctrl-C to the group and the supervisor passes it on,
    // so the serve gets it more than once while it is still stopping: its
    // step is held in a tick until the test has sent them all.
    writeFileSync(join(s.work, "tick-block"), "");
    await waitForFileNamed(join(s.work, "tick-entered"));
    for (let count = 0; count < 20; count += 1) {
      serve.kill("SIGINT");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    writeFileSync(join(s.work, "tick-release"), "");
    expect(await serve.exited).toBe(0);
    expect(existsSync(join(s.home, "serve.lock"))).toBe(false);
  }, 60_000);
});

describe("a supervised serve that has stopped", () => {
  test("still listens for SIGINT and SIGTERM", async () => {
    const s = await setup();
    writeFileSync(s.plugin, heldPluginSource(s.work));
    writeFileSync(join(s.home, "triggers.json"), "[]\n");
    // The real supervisor starts the serve child, which carries the flag that
    // keeps the stop handlers after its stop is done.
    const serve = Bun.spawn({
      cmd: [process.execPath, SUPERVISE, "serve"],
      cwd: s.home,
      env: childEnv(s.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Output(serve.stdout, serve.stderr);
    let childPid: number | undefined;
    try {
      await output.until(/serving /);
      childPid = readLockPid(join(s.home, "serve.lock"));
      if (childPid === undefined) throw new Error("the serve lock has no pid");
      expect(childPid).not.toBe(serve.pid);
      // The terminal signals the group; here the serve child itself gets it.
      process.kill(childPid, "SIGINT");
      // The lock is released after the stop handlers were released, and the
      // plugin keeps the process alive, as a terminal still holding it would.
      await waitForFileGone(join(s.home, "serve.lock"));
      writeFileSync(join(s.work, "probe"), "go\n");
      await waitForFileNamed(join(s.work, "listeners"));
      expect(readFileSync(join(s.work, "listeners"), "utf8").trim()).toBe("1 1");
      expect(serve.exitCode).toBeNull();
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // It already ended.
        }
      }
      if (serve.exitCode === null) serve.kill("SIGKILL");
      await serve.exited;
    }
  }, 60_000);
});

/** The second address: the machine's private one when it has one (a phone's), else ::1 (127.0.0.2 is not bound on macOS). */
function secondAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal && /^(10\.|192\.168\.)/.test(entry.address)) {
        return entry.address;
      }
    }
  }
  return "::1";
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

function urlOf(address: string, port: number): string {
  return address.includes(":") ? `http://[${address}]:${port}` : `http://${address}:${port}`;
}

/** True when an operad server answers at the url (it asks for a token). */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/v1/types`);
    return response.status === 401;
  } catch {
    return false;
  }
}

/** Opens an event stream with the home's token and waits for its first bytes. */
async function openEvents(home: string, url: string): Promise<() => void> {
  const token = await readHttpToken(home);
  if (token === undefined) throw new Error("no token");
  const controller = new AbortController();
  const response = await fetch(`${url}/v1/events`, {
    headers: { authorization: `Bearer ${token.token}` },
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no stream");
  await reader.read();
  return () => controller.abort();
}

describe("a reload with two listen addresses", () => {
  test("ends with the new code serving both, while an event stream is open on the second", async () => {
    const port = await freePort();
    const second = secondAddress();
    const s = await setup({ port, listen: ["127.0.0.1", second] });
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    let closeStream: (() => void) | undefined;
    try {
      await output.until(/serving /);
      const firstPid = readLockPid(join(s.home, "serve.lock"));
      closeStream = await openEvents(s.home, urlOf(second, port));
      writeFileSync(s.plugin, pluginSource("v2", s.work));
      await output.until(/reloading: /);
      await output.until(/serving /, 2);
      expect(readLockPid(join(s.home, "serve.lock"))).not.toBe(firstPid);
      expect(await answers(urlOf("127.0.0.1", port))).toBe(true);
      expect(await answers(urlOf(second, port))).toBe(true);
      expect(output.text).not.toContain("Failed to start server");
      // The new code took over: serve runs what is on disk, so nothing is pending about it.
      expect(await operad(s, ["pending", "--json"])).not.toContain("serve runs older code");
    } finally {
      closeStream?.();
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);

  for (const changed of ["plugin", "engine"] as const) {
    test(`a bind that keeps failing after a ${changed} change leaves the old code serving both addresses; the next real change reloads`, async () => {
      const port = await freePort();
      const second = secondAddress();
      const s = await setup({ port, listen: ["127.0.0.1", second] });
      s.env.OPERAD_BIND_RETRY_MS = "800";
      s.env.OPERAD_BIND_RETRY_STEP_MS = "50";
      const serve = spawnOperad(s, ["serve"]);
      const output = new Output(serve.stdout, serve.stderr);
      let blocker: ReturnType<typeof Bun.serve> | undefined;
      // A file of the engine package that no module imports: it counts as engine code.
      const marker = fileURLToPath(new URL("../../../engine/zz-reload-test-marker.txt", import.meta.url));
      try {
        await output.until(/serving /);
        const supervisorPid = serve.pid;
        if (changed === "plugin") writeFileSync(s.plugin, pluginSource("v2", s.work));
        else writeFileSync(marker, "changed\n");
        await output.until(/reloading: /);
        // Take the second address the moment the old code lets it go, and keep it.
        while (blocker === undefined) {
          try {
            blocker = Bun.serve({ hostname: second, port, fetch: () => new Response("") });
          } catch {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        await output.until(/the old code tries every address again/);
        // The new code is gone; free the address for the old code to take back.
        await blocker.stop(true);
        blocker = undefined;
        await output.until(/serving /, 2);
        // The restored serve imported the plugin again, so only an engine change
        // leaves it on older code; it does not try that change again.
        if (changed === "engine") {
          await waitForFileNamed(join(s.home, "serve-older.json"));
          expect(await operad(s, ["pending", "--json"])).toContain("serve runs older code than the files on disk");
        } else {
          expect(await operad(s, ["pending", "--json"])).not.toContain("serve runs older code");
        }
        expect(output.text.match(/reloading: /g)).toHaveLength(1);
        expect(await answers(urlOf("127.0.0.1", port))).toBe(true);
        expect(await answers(urlOf(second, port))).toBe(true);
        expect(output.text.match(/the old code tries every address again/g)).toHaveLength(1);
        expect(serve.pid).toBe(supervisorPid);
        expect(serve.exitCode).toBeNull();

        // The next real change goes through the load check and reloads.
        writeFileSync(s.plugin, pluginSource("v3", s.work));
        await output.until(/reloading: /, 2);
        await output.until(/serving /, 3);
        // The second line is the plugin change.
        const lines = output.text.split("\n").filter((line) => line.startsWith("reloading: "));
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain("plugin reloadflow");
        expect(serve.exitCode).toBeNull();
        expect(await answers(urlOf("127.0.0.1", port))).toBe(true);
      } finally {
        rmSync(marker, { force: true });
        await blocker?.stop(true);
        await stopServe(s);
        expect(await serve.exited).toBe(0);
      }
    }, 60_000);
  }
});
