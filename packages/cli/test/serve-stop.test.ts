import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive } from "@operad-io/engine";
import {
  isServeCommand,
  parseStopTimeout,
  serveStop,
} from "../src/serve-stop.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const IGNORE_TERM = fileURLToPath(new URL("./fixtures/ignore-term.ts", import.meta.url));

async function makeHome(): Promise<{ root: string; home: string; lock: string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home, lock: join(home, "serve.lock") };
}

function writeLock(path: string, pid: number): void {
  writeFileSync(path, `${JSON.stringify({ pid, at: 1 })}\n`);
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function operad(home: string, args: readonly string[]): Promise<Result> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: home,
    env: { ...(process.env as Record<string, string>), OPERAD_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

async function until(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  text: string,
): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(text)) {
    const read = await reader.read();
    if (read.done) throw new Error(`the child ended before it printed "${text}": ${seen}`);
    seen += decoder.decode(read.value, { stream: true });
  }
  reader.releaseLock();
}

function spawnReady(cmd: string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

describe("operad serve stop", () => {
  test("no lock: says so and exits 0", async () => {
    const { home } = await makeHome();
    const result = await operad(home, ["serve", "stop"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`no operad serve runs for ${home}\n`);
  });

  test("a stale lock: says so, exits 0, signals nothing and leaves the file", async () => {
    const { home, lock } = await makeHome();
    const gone = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    writeLock(lock, gone.pid);
    const result = await operad(home, ["serve", "stop"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`no operad serve runs for ${home}\n`);
    expect(existsSync(lock)).toBe(true);

    // The stop path itself is never reached: no signal goes out.
    const sent: number[] = [];
    const lines: string[] = [];
    await serveStop({
      home,
      timeoutSecs: 1,
      write: (text) => lines.push(text),
      signal: (pid) => sent.push(pid),
    });
    expect(sent).toEqual([]);
  });

  test("stops a real serve: the lock is gone and the process has exited", async () => {
    const { root, home, lock } = await makeHome();
    const port = await freePort();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [],
        store: { backend: "jsonl", path: join(root, "store") },
        http: { enabled: true, port, listen: ["127.0.0.1"] },
      }),
    );
    const serve = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: { ...(process.env as Record<string, string>), OPERAD_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await until(serve, "serving");
      const result = await operad(home, ["serve", "stop"]);
      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      expect(result.out).toBe(`stopping operad serve (pid ${serve.pid})\nstopped\n`);
      expect(existsSync(lock)).toBe(false);
      await serve.exited;
      expect(pidAlive(serve.pid)).toBe(false);
    } finally {
      if (serve.exitCode === null) {
        serve.kill("SIGTERM");
        await serve.exited;
      }
    }
  }, 30_000);

  test("refuses a live process that is not a serve, and never signals it", async () => {
    const { home, lock } = await makeHome();
    const other = Bun.spawn({ cmd: ["sleep", "300"], stdout: "ignore", stderr: "ignore" });
    try {
      writeLock(lock, other.pid);
      const result = await operad(home, ["serve", "stop"]);
      expect(result.code).toBe(3);
      expect(result.err).toContain(`process ${other.pid}`);
      expect(result.err).toContain("not an operad serve");
      expect(result.out).toBe("");
      expect(other.exitCode).toBeNull();
      expect(pidAlive(other.pid)).toBe(true);
      expect(existsSync(lock)).toBe(true);
    } finally {
      other.kill("SIGTERM");
      await other.exited;
    }
  });

  test("--timeout: a serve that ignores SIGTERM is an error that says how to force it", async () => {
    const { home, lock } = await makeHome();
    const stubborn = spawnReady([process.execPath, IGNORE_TERM, "serve"]);
    try {
      await until(stubborn, "ready");
      writeLock(lock, stubborn.pid);
      const result = await operad(home, ["serve", "stop", "--timeout", "1"]);
      expect(result.code).toBe(3);
      expect(result.out).toBe(`stopping operad serve (pid ${stubborn.pid})\n`);
      expect(result.err).toContain("did not stop within 1 seconds");
      expect(result.err).toContain(`kill -9 ${stubborn.pid}`);
      expect(stubborn.exitCode).toBeNull();
    } finally {
      stubborn.kill("SIGKILL");
      await stubborn.exited;
    }
  }, 30_000);

  test("--timeout takes a whole number of seconds, at least 1", async () => {
    const { home } = await makeHome();
    for (const args of [
      ["--timeout", "0"],
      ["--timeout"],
      ["--timeout", "soon"],
      ["--timeout", "1.5"],
      ["--timeout", "-3"],
      ["--bogus"],
    ]) {
      const result = await operad(home, ["serve", "stop", ...args]);
      expect(result.code).toBe(2);
      expect(result.err).toContain("serve stop");
      expect(result.out).toBe("");
    }
    expect((await operad(home, ["serve", "stop", "--timeout=5"])).code).toBe(0);
  });

  test("the command-line check wants serve as a word", () => {
    expect(isServeCommand("/usr/bin/bun /x/operad.ts serve")).toBe(true);
    expect(isServeCommand("bun operad.ts serve --x")).toBe(true);
    expect(isServeCommand("sleep 300")).toBe(false);
    expect(isServeCommand("/opt/observe/bin/run")).toBe(false);
    expect(parseStopTimeout("30")).toBe(30);
    expect(() => parseStopTimeout("0")).toThrow();
  });

  test("a bare serve still takes no arguments", async () => {
    const { home } = await makeHome();
    const result = await operad(home, ["serve", "now"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("serve takes no arguments");
  });
});
