import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { watch } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ControlReader,
  createGroupStop,
  exitFromStatus,
  runLine,
  type Clock,
} from "../../src/platform/index.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "operad-process-test-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** Resolves when the file exists, without asking repeatedly: watches the directory. */
function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

interface ManualClock extends Clock {
  /** How many grace waits were requested. */
  readonly sleeps: number;
}

/** A clock a test drives: a grace wait returns at once. */
function manualClock(): ManualClock {
  let sleeps = 0;
  return {
    setTimeout() {
      return {};
    },
    clearTimeout() {},
    sleep() {
      sleeps += 1;
      return Promise.resolve();
    },
    get sleeps() {
      return sleeps;
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for an observable condition with a bounded poll. Only the test that
 * exercises a real signal uses it: the line's own shell reporting the TERM is
 * what the order assertion needs, not a fixed sleep.
 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for a condition");
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, stepMs));
  }
}

describe("process groups", () => {
  test("a finished line is stopped at once, while its group still exists", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "leader.pid");
    let groupsSeen: boolean | undefined;
    let sleeps = 0;
    const clock: Clock = {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      sleep: async () => {
        sleeps += 1;
      },
    };

    const outcome = await runLine({
      line: `echo $PPID > '${pidFile}'`,
      cwd: root,
      signal: new AbortController().signal,
      clock,
      // At the moment of the stop's SIGKILL, the sentinel is still the leader,
      // so the numeric group id cannot have been reused by another command.
      killGroup: (pgid, signal) => {
        if (signal === "SIGKILL") {
          try {
            process.kill(-pgid, 0);
            groupsSeen = true;
          } catch {
            groupsSeen = false;
          }
        }
        try {
          process.kill(-pgid, signal);
          return true;
        } catch {
          return false;
        }
      },
    });

    expect(outcome.exitCode).toBe(0);
    // A line that already reported its status does not wait out the grace.
    expect(sleeps).toBe(0);
    expect(groupsSeen).toBe(true);
  });

  test("a finished line is stopped with a single SIGKILL", async () => {
    const root = await tempRoot();
    const signals: (string | number)[] = [];
    const clock = manualClock();
    const outcome = await runLine({
      line: "true",
      cwd: root,
      signal: new AbortController().signal,
      clock,
      // Record the signals and forward them, so the real sentinel this run
      // started does not outlive the test.
      killGroup: (pgid, signal) => {
        signals.push(signal);
        try {
          process.kill(-pgid, signal);
          return true;
        } catch {
          return false;
        }
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(clock.sleeps).toBe(0);
    expect(signals).toEqual(["SIGKILL"]);
  });

  test("a cancelled line still takes SIGTERM, the grace and SIGKILL", async () => {
    const root = await tempRoot();
    const marker = join(root, "started");
    const signals: (string | number)[] = [];
    const clock = manualClock();
    const controller = new AbortController();
    const running = runLine({
      line: `echo $$ > '${marker}'; sleep 60`,
      cwd: root,
      signal: controller.signal,
      clock,
      killGroup: (pgid, signal) => {
        signals.push(signal);
        try {
          process.kill(-pgid, signal);
          return true;
        } catch {
          return false;
        }
      },
    });
    await waitForFile(marker);
    controller.abort();

    const outcome = await running;
    expect(outcome.cancelled).toBe(true);
    expect(clock.sleeps).toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("the sentinel does not outlive the run", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "sentinel.pid");
    const outcome = await runLine({
      line: `echo $PPID > '${pidFile}'`,
      cwd: root,
      signal: new AbortController().signal,
      clock: manualClock(),
    });

    expect(outcome.exitCode).toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(pid)).toBe(false);
  });

  test("the sentinel survives the stop's SIGTERM", async () => {
    const root = await tempRoot();
    const sentinelFile = join(root, "sentinel.pid");
    const marker = join(root, "got-term");
    let releaseGrace: (() => void) | undefined;
    const grace = new Promise<void>((resolve) => {
      releaseGrace = resolve;
    });
    const clock: Clock = {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      // The test decides when the grace ends, so the sentinel is observed
      // while the SIGTERM is the only signal it has received.
      sleep: async () => {
        await grace;
      },
    };
    const controller = new AbortController();
    const signals: (string | number)[] = [];
    const running = runLine({
      line: `trap 'echo got-term > "${marker}"' TERM; echo $PPID > '${sentinelFile}'; sleep 60`,
      cwd: root,
      signal: controller.signal,
      clock,
      killGroup: (pgid, signal) => {
        signals.push(signal);
        try {
          process.kill(-pgid, signal);
          return true;
        } catch {
          return false;
        }
      },
    });

    let sentinelPid: number | undefined;
    try {
      await waitForFile(sentinelFile);
      sentinelPid = Number(readFileSync(sentinelFile, "utf8").trim());
      controller.abort();

      // Wait for the line's own shell to report the TERM. The signal is only
      // delivered after this point, so the check on the sentinel below is not
      // a same-tick race.
      await waitUntil(() => existsSync(marker));
      expect(signals).toEqual(["SIGTERM"]);
      expect(alive(sentinelPid)).toBe(true);

      releaseGrace?.();
      await running;
      expect(alive(sentinelPid)).toBe(false);
    } finally {
      releaseGrace?.();
      await running.catch(() => undefined);
      if (sentinelPid !== undefined && alive(sentinelPid)) {
        try {
          process.kill(-sentinelPid, "SIGKILL");
        } catch {
          // The group ended after all.
        }
      }
    }
  });

  test("a stop before ready waits for the sentinel's trap", async () => {
    const root = await tempRoot();
    const sentinelFile = join(root, "sentinel.pid");
    const readyFile = join(root, "ready");
    // The sentinel records its pid at once, then delays the trap and the
    // announcement, so the stop below starts before `ready` can arrive.
    const sentinelScript = [
      `echo $$ > '${sentinelFile}'`,
      "sleep 0.3",
      "trap ':' TERM",
      `touch '${readyFile}'`,
      "printf 'ready\\n' >&2",
      'sh -c "$1" 2>&1',
      "status=$?",
      "printf 'end %s\\n' \"$status\" >&2",
      "while :; do sleep 1; done",
    ].join("\n");
    const controller = new AbortController();
    const signals: { readonly signal: string | number; readonly ready: boolean }[] = [];
    const running = runLine({
      line: "sleep 60",
      cwd: root,
      signal: controller.signal,
      sentinelScript,
      killGroup: (pgid, signal) => {
        signals.push({ signal, ready: existsSync(readyFile) });
        try {
          process.kill(-pgid, signal);
          return true;
        } catch {
          return false;
        }
      },
    });
    // runLine is at its startup await now: the stop starts before the
    // sentinel's delayed `ready`.
    controller.abort();

    const outcome = await running;
    expect(outcome.cancelled).toBe(true);
    expect(signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    // Every signal was sent only after the sentinel had installed its trap and
    // announced `ready`; the signal that follows the announcement reaches a
    // sentinel that ignores it.
    expect(signals.every((entry) => entry.ready)).toBe(true);
    const sentinelPid = Number(readFileSync(sentinelFile, "utf8").trim());
    expect(alive(sentinelPid)).toBe(false);
  });

  test("nothing is signaled after the sentinel exits", async () => {
    const signals: (string | number)[] = [];
    let exited = false;
    const stop = createGroupStop({
      clock: manualClock(),
      killGroup: (_pgid, signal) => {
        signals.push(signal);
        // The sentinel ends right after the first signal (TERM).
        exited = true;
        return true;
      },
      pid: () => 4242,
      sentinelExited: () => exited,
      readySeen: () => true,
      ready: Promise.resolve(),
    });
    await stop();
    // TERM went out; the group's leader then ended, so no SIGKILL follows: its
    // group id may belong to someone else by now.
    expect(signals).toEqual(["SIGTERM"]);

    const quiet: (string | number)[] = [];
    await createGroupStop({
      clock: manualClock(),
      killGroup: (_pgid, signal) => {
        quiet.push(signal);
        return true;
      },
      pid: () => 4242,
      sentinelExited: () => true,
      readySeen: () => true,
      ready: Promise.resolve(),
    })();
    expect(quiet).toEqual([]);
  });
});

describe("the control reader", () => {
  test("destroy resolves a pending read", async () => {
    const stream = new Readable({ read() {} });
    const reader = new ControlReader(stream);
    const pending = reader.next();
    reader.destroy();
    await expect(pending).resolves.toBeNull();
    await expect(reader.next()).resolves.toBeNull();
  });

  test("a close resolves a pending read", async () => {
    const stream = new Readable({ read() {} });
    const reader = new ControlReader(stream);
    const pending = reader.next();
    stream.push(null);
    await expect(pending).resolves.toBeNull();
  });
});

describe("exit status", () => {
  test("a status above 128 keeps its code and names the signal beside it", () => {
    expect(exitFromStatus(130)).toEqual({ code: 130, signal: "SIGINT" });
    expect(exitFromStatus(137)).toEqual({ code: 137, signal: "SIGKILL" });
    expect(exitFromStatus(7)).toEqual({ code: 7, signal: null });
    expect(exitFromStatus(null)).toEqual({ code: null, signal: null });
  });
});

describe("the sentinel's host", () => {
  test("a sentinel whose host was killed ends when its line finishes", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "sentinel.pid");
    const release = join(root, "release");
    const fixture = fileURLToPath(
      new URL("../fixtures/run-line-orphan.ts", import.meta.url),
    );
    const child = Bun.spawn({
      cmd: [process.execPath, fixture, root, pidFile, release],
      stdout: "ignore",
      stderr: "ignore",
    });
    let sentinelPid: number | undefined;
    try {
      await waitForFile(pidFile);
      sentinelPid = Number(readFileSync(pidFile, "utf8").trim());
      // We started this host, so its death is ours to cause.
      process.kill(child.pid, "SIGKILL");
      await child.exited;
      // The line can now finish; the sentinel must not outlive its host.
      writeFileSync(release, "go");
      await waitUntil(() => sentinelPid === undefined || !alive(sentinelPid));
      expect(sentinelPid > 0).toBe(true);
      expect(alive(sentinelPid)).toBe(false);
    } finally {
      try {
        writeFileSync(release, "go");
      } catch {
        // The path may already be gone.
      }
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // The host is gone.
      }
      if (sentinelPid !== undefined && sentinelPid > 0 && alive(sentinelPid)) {
        try {
          process.kill(-sentinelPid, "SIGKILL");
        } catch {
          // The group ended after all.
        }
      }
    }
  });
});
