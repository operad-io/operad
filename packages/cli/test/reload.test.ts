import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPERVISED_ENV } from "../src/code-reload.ts";
import { networkInterfaces } from "node:os";
import { readHttpToken, readLockPid } from "../../engine/src/index.ts";
import { waitForChange } from "../../engine/src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

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
      store: { backend: "jsonl", path: join(root, "store") },
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
    } finally {
      closeStream?.();
      await stopServe(s);
      await serve.exited;
    }
  }, 60_000);

  test("a bind that keeps failing leaves the old code serving both addresses, with one line in the log", async () => {
    const port = await freePort();
    const second = secondAddress();
    const s = await setup({ port, listen: ["127.0.0.1", second] });
    s.env.OPERAD_BIND_RETRY_MS = "800";
    s.env.OPERAD_BIND_RETRY_STEP_MS = "50";
    const serve = spawnOperad(s, ["serve"]);
    const output = new Output(serve.stdout, serve.stderr);
    let blocker: ReturnType<typeof Bun.serve> | undefined;
    try {
      await output.until(/serving /);
      const supervisorPid = serve.pid;
      writeFileSync(s.plugin, pluginSource("v2", s.work));
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
      expect(await answers(urlOf("127.0.0.1", port))).toBe(true);
      expect(await answers(urlOf(second, port))).toBe(true);
      expect(output.text.match(/the old code tries every address again/g)).toHaveLength(1);
      expect(serve.pid).toBe(supervisorPid);
      expect(serve.exitCode).toBeNull();
    } finally {
      await blocker?.stop(true);
      await stopServe(s);
      expect(await serve.exited).toBe(0);
    }
  }, 60_000);
});
