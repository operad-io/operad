import { afterAll, describe, expect, test } from "bun:test";
import { testEnv } from "./env.ts";
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
    env: { ...testEnv(), OPERAD_HOME: home },
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
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
        http: { enabled: true, port, listen: ["127.0.0.1"] },
      }),
    );
    const serve = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: { ...testEnv(), OPERAD_HOME: home },
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

  test("a ps that answers nothing for a live serve is asked again, then the serve is stopped", async () => {
    const { home, lock } = await makeHome();
    writeLock(lock, 4242);
    let alive = true;
    let asks = 0;
    const signalled: number[] = [];
    const written: string[] = [];
    await serveStop({
      home,
      timeoutSecs: 5,
      write: (text) => written.push(text),
      isAlive: () => alive,
      commandOf: () => (++asks <= 3 ? undefined : "bun operad.ts serve"),
      signal: (pid) => {
        signalled.push(pid);
        alive = false;
      },
      sleep: async () => {},
    });
    expect(asks).toBe(4);
    expect(signalled).toEqual([4242]);
    expect(written.join("")).toContain("stopped");
  });

  test("a ps that never answers for a live process refuses without signalling", async () => {
    const { home, lock } = await makeHome();
    writeLock(lock, 4242);
    const signalled: number[] = [];
    let asks = 0;
    let thrown = "";
    try {
      await serveStop({
        home,
        timeoutSecs: 5,
        write: () => {},
        isAlive: () => true,
        commandOf: () => {
          asks += 1;
          return undefined;
        },
        signal: (pid) => signalled.push(pid),
        sleep: async () => {},
      });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(asks).toBe(20);
    expect(thrown).toContain("ps could not say");
    expect(signalled).toEqual([]);
  });

  test("a process that dies during the empty answers is a lock with no serve, not a refusal", async () => {
    const { home, lock } = await makeHome();
    writeLock(lock, 4242);
    const written: string[] = [];
    const signalled: number[] = [];
    let asks = 0;
    await serveStop({
      home,
      timeoutSecs: 5,
      write: (text) => written.push(text),
      isAlive: () => asks < 3,
      commandOf: () => {
        asks += 1;
        return undefined;
      },
      signal: (pid) => signalled.push(pid),
      sleep: async () => {},
    });
    expect(asks).toBe(3);
    expect(signalled).toEqual([]);
    expect(written.join("")).toBe(`no operad serve runs for ${home}\n`);
  });

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
