import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { watch } from "node:fs";
import { createGroupStop, runLine, type Clock } from "../../src/platform/index.ts";

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
  test("the group outlives a finished line until the grace SIGKILL", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "leader.pid");
    const groupsSeen: boolean[] = [];
    let sleeps = 0;
    const clock: Clock = {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      sleep: async () => {
        sleeps += 1;
        // Read the group leader the line wrote (its parent, the sentinel),
        // then ask whether its numeric group id still names a live group.
        // Without the sentinel the group would have ended when the line
        // exited, and the id could be reused before the SIGKILL.
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        try {
          process.kill(-pid, 0);
          groupsSeen.push(true);
        } catch {
          groupsSeen.push(false);
        }
      },
    };

    const outcome = await runLine({
      line: `echo $PPID > '${pidFile}'`,
      cwd: root,
      signal: new AbortController().signal,
      clock,
    });

    expect(outcome.exitCode).toBe(0);
    // The stop waited the grace before SIGKILL, and the group still existed
    // then: the group id could not have been reused by another command.
    expect(sleeps).toBe(1);
    expect(groupsSeen).toEqual([true]);
  });

  test("a spawned line is stopped with SIGTERM and then SIGKILL", async () => {
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
