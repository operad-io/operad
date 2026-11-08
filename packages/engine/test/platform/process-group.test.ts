import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ControlReader,
  createGroupStop,
  exitFromStatus,
  runLine,
  waitForChange,
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

/**
 * How long a wait for a file sleeps between two looks when no directory event
 * comes. A directory watch can miss a file made while it was starting, so the
 * wait never relies on the event alone (see `waitForChange`).
 */
const LOOK_MS = 100;

/** Resolves when the file exists. Event first; a look every `LOOK_MS` besides. */
async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await waitForChange(dirname(path), basename(path), LOOK_MS);
  }
}

/** True for a pid a test may signal: a finite integer above 1 (never 0, 1 or a group). */
function signalable(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1;
}

/**
 * Resolves with the pid a shell wrote to `path`, once the file holds one. The
 * file exists, empty, before the shell writes to it, so existence is not enough.
 */
async function waitForPid(path: string): Promise<number> {
  for (;;) {
    try {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (signalable(pid)) return pid;
    } catch {
      // Not there yet.
    }
    await waitForChange(dirname(path), basename(path), LOOK_MS);
  }
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

/**
 * A clock whose waits end when the test says so. A wait that a stop starts
 * before the sentinel's `ready` was read is bounded by the same clock; letting
 * it end at once (the manual clock) made the stop give up on `ready` and send
 * only SIGKILL whenever the abort beat the read of the pipe. Here every wait
 * stays open until `release`, which the test calls from its `killGroup` once
 * SIGTERM went out, so the order TERM, grace, KILL does not depend on timing.
 */
function gatedClock(): Clock & { release(): void; readonly sleepsAfterRelease: number } {
  let open = false;
  let after = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      open = true;
      resolve();
    };
  });
  return {
    setTimeout() {
      return {};
    },
    clearTimeout() {},
    async sleep() {
      if (open) after += 1;
      await gate;
    },
    release,
    get sleepsAfterRelease() {
      return after;
    },
  };
}

/**
 * The signals of a stop without the repeats of its last SIGKILL: after the
 * KILL the stop looks for members of the group until it is empty and repeats
 * the KILL while one is left, so a count of KILLs depends on how fast the
 * kernel reaps.
 */
function afterTerm(signals: readonly (string | number)[]): readonly (string | number)[] {
  const first = signals.indexOf("SIGKILL");
  if (first < 0) return signals;
  const rest = signals.slice(first + 1);
  expect(rest.every((signal) => signal === "SIGKILL")).toBe(true);
  return signals.slice(0, first + 1);
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
  timeoutMs = 10_000,
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
    const clock = gatedClock();
    const controller = new AbortController();
    const running = runLine({
      line: `echo $$ > '${marker}'; sleep 60`,
      cwd: root,
      signal: controller.signal,
      clock,
      killGroup: (pgid, signal) => {
        signals.push(signal);
        // The grace starts when TERM has gone out; ending it sends KILL.
        if (signal === "SIGTERM") clock.release();
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
    // One grace after the TERM. A wait for `ready` that the abort beat is
    // bounded by the clock too, but it ends because `ready` came.
    expect(clock.sleepsAfterRelease).toBe(1);
    expect(afterTerm(signals)).toEqual(["SIGTERM", "SIGKILL"]);
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
    const pid = await waitForPid(pidFile);
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
      // The sleep runs in the background before the pid is written, and `wait`
      // takes the trap at once. A foreground `sleep` that the abort beat to its
      // fork would not be in the group when SIGTERM went out, and the shell
      // would hold the trap until that sleep ended, with the grace waiting for
      // the trap: the test would hang.
      line: `trap 'echo got-term > "${marker}"' TERM; sleep 60 & echo $PPID > '${sentinelFile}'; wait`,
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
      sentinelPid = await waitForPid(sentinelFile);
      controller.abort();

      // Wait for the line's own shell to report the TERM. The signal is only
      // delivered after this point, so the check on the sentinel below is not
      // a same-tick race. The marker is a file event, so wait on the directory
      // rather than poll for it under the full test run's load.
      await waitForFile(marker);
      expect(signals).toEqual(["SIGTERM"]);
      expect(alive(sentinelPid)).toBe(true);

      releaseGrace?.();
      await running;
      expect(alive(sentinelPid)).toBe(false);
    } finally {
      releaseGrace?.();
      await running.catch(() => undefined);
      if (signalable(sentinelPid) && alive(sentinelPid)) {
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
    // The wait for `ready` is bounded by the grace; a real 500 ms ended before
    // the delayed announcement under load and the stop sent only SIGKILL. The
    // clock holds every wait until TERM went out, so `ready` always wins.
    const clock = gatedClock();
    const running = runLine({
      line: "sleep 60",
      cwd: root,
      signal: controller.signal,
      sentinelScript,
      clock,
      killGroup: (pgid, signal) => {
        signals.push({ signal, ready: existsSync(readyFile) });
        if (signal === "SIGTERM") clock.release();
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
    expect(afterTerm(signals.map((entry) => entry.signal))).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    // Every signal was sent only after the sentinel had installed its trap and
    // announced `ready`; the signal that follows the announcement reaches a
    // sentinel that ignores it.
    expect(signals.every((entry) => entry.ready)).toBe(true);
    const sentinelPid = await waitForPid(sentinelFile);
    expect(alive(sentinelPid)).toBe(false);
  });

  test("a straggler that missed the SIGKILL is killed again while the group exists", async () => {
    const signals: (string | number)[] = [];
    // The group still has a member (a child forked while the signal went out)
    // for the first two looks, then it is gone.
    const looks = [true, true, false];
    const stop = createGroupStop({
      clock: manualClock(),
      killGroup: (_pgid, signal) => {
        signals.push(signal);
        return true;
      },
      pid: () => 4242,
      sentinelExited: () => false,
      readySeen: () => true,
      ready: Promise.resolve(),
      groupExists: () => looks.shift() ?? false,
      pause: () => Promise.resolve(),
    });
    await stop();
    expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGKILL", "SIGKILL"]);
    expect(looks).toEqual([]);
  });

  test("a stop that gave up on ready also kills a straggler again", async () => {
    const signals: (string | number)[] = [];
    const looks = [true, false];
    await createGroupStop({
      clock: manualClock(),
      killGroup: (_pgid, signal) => {
        signals.push(signal);
        return true;
      },
      pid: () => 4242,
      sentinelExited: () => false,
      readySeen: () => false,
      // `ready` never comes: the grace ends first and the stop sends KILL only.
      ready: new Promise<void>(() => undefined),
      groupExists: () => looks.shift() ?? false,
      pause: () => Promise.resolve(),
    })();
    expect(signals).toEqual(["SIGKILL", "SIGKILL"]);
  });

  test("a group that is gone after the SIGKILL gets no more signals", async () => {
    const signals: (string | number)[] = [];
    await createGroupStop({
      clock: manualClock(),
      killGroup: (_pgid, signal) => {
        signals.push(signal);
        return true;
      },
      pid: () => 4242,
      sentinelExited: () => false,
      readySeen: () => true,
      ready: Promise.resolve(),
      groupExists: () => false,
      pause: () => Promise.resolve(),
    })();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a child forked as the group is signaled does not outlive the stop", async () => {
    // The shell forks its `sleep` while the stop signals the group: the signal
    // reaches the shell and misses the child, which keeps the output pipe open.
    // Repeating this makes the race likely; every run must end.
    for (let round = 0; round < 40; round += 1) {
      const root = await tempRoot();
      const marker = join(root, "started");
      const controller = new AbortController();
      const running = runLine({
        line: `echo $$ > '${marker}'; sleep 60`,
        cwd: root,
        signal: controller.signal,
        clock: manualClock(),
      });
      await waitForFile(marker);
      controller.abort();
      const outcome = await running;
      expect(outcome.cancelled).toBe(true);
    }
  }, 60_000);

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

describe("a line's end record", () => {
  test("a status the shell wrote survives the shell's exit arriving first", async () => {
    // The sentinel exits at once and the record is written by a process that
    // outlives it, so the exit event comes before the record is readable.
    const script = [
      "printf 'ready\\n' >&2",
      "( sleep 0.3; printf 'end 130\\n' >&2 ) &",
      "exit 0",
    ].join("\n");
    const root = await tempRoot();
    const outcome = await runLine({
      line: "true",
      cwd: root,
      signal: new AbortController().signal,
      sentinelScript: script,
    });
    expect(outcome.exitCode).toBe(130);
    expect(outcome.signal).toBe("SIGINT");
  });
});

describe("a control pipe that closes early", () => {
  test("the group is stopped instead of waited for", async () => {
    // The sentinel closes its end of the pipe after `ready` and keeps running.
    const script = ["printf 'ready\\n' >&2", "exec 2>&-", "sleep 30"].join("\n");
    const root = await tempRoot();
    const outcome = await runLine({
      line: "true",
      cwd: root,
      signal: new AbortController().signal,
      clock: manualClock(),
      sentinelScript: script,
    });
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.cancelled).toBe(false);
  }, 10_000);
});

describe("the sentinel's host", () => {
  test("a line still running when its host dies is stopped with its sentinel", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "sentinel.pid");
    const fixture = fileURLToPath(
      new URL("../fixtures/run-line-orphan.ts", import.meta.url),
    );
    // The release file is never written: the line stays blocked.
    const child = Bun.spawn({
      cmd: [process.execPath, fixture, root, pidFile, join(root, "never")],
      stdout: "ignore",
      stderr: "ignore",
    });
    let sentinelPid = 0;
    let linePid = 0;
    try {
      linePid = await waitForPid(`${pidFile}.line`);
      sentinelPid = await waitForPid(pidFile);
      // We started this host, so its death is ours to cause.
      process.kill(child.pid, "SIGKILL");
      await child.exited;
      await waitUntil(() => !alive(sentinelPid) && !alive(linePid), 10_000);
      expect(alive(sentinelPid)).toBe(false);
      expect(alive(linePid)).toBe(false);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // The host is gone.
      }
      if (signalable(sentinelPid) && alive(sentinelPid)) {
        try {
          process.kill(-sentinelPid, "SIGKILL");
        } catch {
          // The group ended after all.
        }
      }
    }
  }, 20_000);

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
      sentinelPid = await waitForPid(pidFile);
      // We started this host, so its death is ours to cause.
      process.kill(child.pid, "SIGKILL");
      await child.exited;
      // The line can now finish; the sentinel must not outlive its host.
      writeFileSync(release, "go");
      await waitUntil(() => sentinelPid === undefined || !alive(sentinelPid));
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
      if (signalable(sentinelPid) && alive(sentinelPid)) {
        try {
          process.kill(-sentinelPid, "SIGKILL");
        } catch {
          // The group ended after all.
        }
      }
    }
  });
});
