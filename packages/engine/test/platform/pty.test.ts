import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRAIN_GRACE_MS,
  enterStep,
  KILL_GRACE_MS,
  markerValue,
  reapStep,
  spawnPty,
  systemClock,
  withStepMarker,
  type Clock,
  type Pty,
  type PtyOptions,
} from "../../src/platform/index.ts";

const started: Pty[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const pty of started.splice(0)) {
    await pty.kill();
    await pty.exited;
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "operad-pty-")));
  directories.push(path);
  return path;
}

/** Starts a pseudo terminal and collects what it prints. */
function start(argv: PtyOptions["argv"], options: Partial<PtyOptions> = {}) {
  const decoder = new TextDecoder();
  let output = "";
  const waiters: Array<() => void> = [];
  const pty = spawnPty({
    argv,
    cwd: tmpdir(),
    cols: 80,
    rows: 24,
    onData: (bytes) => {
      output += decoder.decode(bytes, { stream: true });
      for (const check of [...waiters]) check();
    },
    ...options,
  });
  started.push(pty);
  /** Settles when the output so far matches. */
  const seen = (pattern: RegExp): Promise<RegExpExecArray> =>
    new Promise((resolve) => {
      const check = (): void => {
        const match = pattern.exec(output);
        if (match === null) return;
        const at = waiters.indexOf(check);
        if (at >= 0) waiters.splice(at, 1);
        resolve(match);
      };
      waiters.push(check);
      check();
    });
  return { pty, seen, output: () => output };
}

const sh = (line: string, ...args: string[]): PtyOptions["argv"] => ["sh", "-c", line, "sh", ...args];

/**
 * A grandchild that ignores TERM and HUP and holds a FIFO open for as long as
 * it lives: `up` settles once it runs, `gone` once the FIFO has no writer left,
 * which is when it ended.
 */
function grandchild() {
  const fifo = join(directory(), "alive");
  execFileSync("mkfifo", [fifo]);
  const stream = createReadStream(fifo, { encoding: "utf8" });
  const up = new Promise<void>((resolve) => stream.once("data", () => resolve()));
  const gone = new Promise<void>((resolve, reject) => {
    stream.once("end", () => resolve());
    stream.once("error", reject);
  });
  // It ends by itself after a minute, so a failing test leaves nothing behind for long.
  const line = `(trap '' TERM HUP; echo up; exec sleep 60) > "$1" &`;
  return { fifo, line, up, gone };
}

/** A clock whose sleeps end at once and are recorded. */
function instantClock(): Clock & { readonly slept: number[] } {
  const slept: number[] = [];
  return {
    ...systemClock,
    slept,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

describe("spawnPty", () => {
  test("the output of printf arrives, all of it before the exit settles", async () => {
    const run = start(["printf", "hello from the terminal"]);
    await run.pty.exited;
    expect(run.output()).toBe("hello from the terminal");
  });

  test("input written is echoed by cat", async () => {
    // The terminal's own echo is off, so what comes back was written by cat.
    const run = start(sh("stty -echo; echo ready; exec cat"));
    await run.seen(/ready/);
    run.pty.write("typed line\n");
    await run.seen(/typed line\r\n/);
    run.pty.write(new TextEncoder().encode("typed bytes\n"));
    await run.seen(/typed bytes\r\n/);
    run.pty.write("\x04");
    expect(await run.pty.exited).toEqual({ code: 0, signal: null });
  });

  test("the size is the one given, and a resize is seen by stty", async () => {
    const run = start(sh("stty size; read line; stty size"), { cols: 90, rows: 20 });
    await run.seen(/^20 90\r\n/);
    run.pty.resize(100, 30);
    run.pty.write("\n");
    await run.seen(/30 100\r\n/);
    await run.pty.exited;
  });

  test("the child starts in the directory, with the variables over this environment", async () => {
    const cwd = directory();
    const run = start(sh('pwd -P; echo "$PTY_TEST"; echo "$PATH"'), {
      cwd,
      env: { PTY_TEST: "given" },
    });
    await run.pty.exited;
    expect(run.output().split("\r\n")).toEqual([cwd, "given", process.env["PATH"] ?? "", ""]);
  });

  test("the exit code is reported", async () => {
    expect(await start(sh("exit 7")).pty.exited).toEqual({ code: 7, signal: null });
  });

  test("a child that a signal ended is reported with the signal", async () => {
    expect(await start(sh("kill -TERM $$")).pty.exited).toEqual({ code: 143, signal: "SIGTERM" });
  });

  test("the child leads a process group of its own", async () => {
    const run = start(sh("ps -o pgid= -p $$"));
    await run.pty.exited;
    expect(Number(run.output().trim())).toBe(run.pty.pid);
  });

  test("there are three stdio entries and the child gets no fourth descriptor", async () => {
    const spawn = spyOn(Bun, "spawn");
    try {
      const run = start(
        sh("for n in 3 4 5 6 7 8 9; do if (: >&$n) 2>/dev/null; then echo open $n; fi; done; echo done"),
      );
      const result = spawn.mock.results[0];
      const child = result?.value as { readonly stdio: readonly unknown[] };
      expect(child.stdio).toEqual([null, null, null]);
      await run.pty.exited;
      expect(run.output()).toBe("done\r\n");
    } finally {
      spawn.mockRestore();
    }
  });

  test("kill ends the process group, a grandchild that ignores TERM included", async () => {
    const child = grandchild();
    const clock = instantClock();
    const run = start(sh(`trap '' TERM HUP; ${child.line} wait`, child.fifo), { clock });
    await child.up;
    await run.pty.kill();
    await child.gone;
    expect(await run.pty.exited).toEqual({ code: 137, signal: "SIGKILL" });
    expect(clock.slept).toEqual([KILL_GRACE_MS]);
  });

  test("what the child left in its group is stopped when it exits", async () => {
    const child = grandchild();
    // The child leaves once a line arrives, after the grandchild is up.
    const run = start(sh(`${child.line} read line; exit 3`, child.fifo), { clock: instantClock() });
    await child.up;
    run.pty.write("\n");
    expect(await run.pty.exited).toEqual({ code: 3, signal: null });
    await child.gone;
  });

  test("after the exit, input, a resize and a kill do nothing", async () => {
    const clock = instantClock();
    const run = start(["true"], { clock });
    await run.pty.exited;
    expect(() => run.pty.write("late\n")).not.toThrow();
    expect(() => run.pty.resize(10, 10)).not.toThrow();
    await run.pty.kill();
    expect(clock.slept).toEqual([]);
  });

  test("a terminal that never reports its end is waited for only so long", async () => {
    const original = Bun.spawn;
    // The same spawn, with the end of the terminal never reported.
    const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: { terminal: object }) =>
      original(argv, { ...options, terminal: { ...options.terminal, exit: () => {} } } as never)) as never);
    try {
      let expire = (): void => {};
      let armed = (_ms: number): void => {};
      const limit = new Promise<number>((resolve) => {
        armed = resolve;
      });
      const run = start(["true"], {
        clock: {
          ...instantClock(),
          setTimeout: (handler, ms) => {
            expire = handler;
            armed(ms);
            return 0;
          },
          clearTimeout: () => {},
        },
      });
      let settled = false;
      const exited = run.pty.exited.then((exit) => {
        settled = true;
        return exit;
      });
      expect(await limit).toBe(DRAIN_GRACE_MS);
      // One turn of the event loop: an exit that did not wait would have settled.
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expire();
      expect(await exited).toEqual({ code: 0, signal: null });
    } finally {
      spawn.mockRestore();
    }
  });

  test("a program or a directory that does not exist throws", () => {
    expect(() => start(["no-such-program-operad"])).toThrow("no-such-program-operad");
    expect(() => start(["true"], { cwd: join(directory(), "missing") })).toThrow("ENOENT");
  });

  test("a Bun that gives no terminal throws and the child is killed", () => {
    const killed: string[] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      pid: 1,
      exited: Promise.resolve(0),
      kill: (signal: string) => killed.push(signal),
    })) as never);
    try {
      expect(() => start(["true"])).toThrow("no pseudo terminal");
      expect(killed).toEqual(["SIGKILL"]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("a child started by a step carries its marker and is stopped with it", async () => {
    const marker = { runId: `pty-${crypto.randomUUID()}`, step: "terminal", home: directory() };
    const leave = enterStep(marker);
    try {
      const run = withStepMarker(marker, () =>
        start(sh('echo "marker=$OPERAD_RUN."; exec sleep 60'), { clock: instantClock() }),
      );
      expect((await run.seen(/marker=(\S*)\./))[1]).toBe(markerValue(marker));
      leave();
      // No marked process is listed, so only what the step's tracker follows is found.
      const found = await reapStep(marker, undefined, { list: () => Promise.resolve([]) });
      expect(found.map((one) => one.pid)).toContain(run.pty.pid);
      await run.pty.exited;
    } finally {
      leave();
    }
  });
});
