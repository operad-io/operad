import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ControlReader,
  createGroupStop,
  exitFromStatus,
  runLine,
  type Clock,
} from "../../src/platform/index.ts";
import {
  alive,
  cleanupTempRoots,
  manualClock,
  signalable,
  tempRoot,
  waitForFile,
  waitForPid,
  waitUntil,
  type ManualClock,
} from "../../src/testing/index.ts";

afterAll(cleanupTempRoots);

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

  test("a finished line is stopped without the grace", async () => {
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
    // A group that still has a live member gets another SIGKILL, as the TERM
    // path does; a TERM or a grace wait here would be the mistake.
    expect(afterTerm(signals)).toEqual(["SIGKILL"]);
  });

  test("a child forked as a line that ended is signaled does not outlive it", async () => {
    const root = await tempRoot();
    const childFile = join(root, "child");
    // The sentinel forks a child before it reports the end, as its own `sleep`
    // does. A test cannot land a fork in the kernel's window, so the first
    // SIGKILL reaches the leader alone: the child is missed, as a fork at that
    // instant would be. The stop must look again, as the TERM path does.
    let kills = 0;
    const outcome = await runLine({
      line: "echo hi",
      cwd: root,
      signal: new AbortController().signal,
      sentinelScript: [
        "trap ':' TERM",
        "printf 'ready\\n' >&2",
        'sh -c "$1" 2>&1',
        "status=$?",
        "sleep 10 &",
        `echo $! > '${childFile}'`,
        "printf 'end %s\\n' \"$status\" >&2",
        "wait",
      ].join("\n"),
      killGroup: (pgid, signal) => {
        kills += 1;
        try {
          process.kill(kills === 1 ? pgid : -pgid, signal);
          return true;
        } catch {
          return false;
        }
      },
    });

    expect(outcome.exitCode).toBe(0);
    const child = await waitForPid(childFile);
    await waitUntil(() => !alive(child), 5000);
  }, 20_000);

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
      pause: () => undefined,
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
      pause: () => undefined,
    })();
    expect(signals).toEqual(["SIGKILL", "SIGKILL"]);
  });

  test("no signal goes to the group id once the sentinel is reaped", async () => {
    // The reaped leader no longer owns the group id; the id may now belong to
    // an unrelated group, so a group that still looks alive is left alone.
    const signals: (string | number)[] = [];
    let reaped = false;
    await createGroupStop({
      clock: manualClock(),
      killGroup: (_pgid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") reaped = true;
        return true;
      },
      pid: () => 4242,
      sentinelExited: () => reaped,
      readySeen: () => true,
      ready: Promise.resolve(),
      groupExists: () => true,
      pause: () => undefined,
    })();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a SIGKILL that finds no group starts no sweep", async () => {
    // The group vanished before the SIGKILL, so its id may be someone else's.
    for (const readySeen of [true, false]) {
      const signals: (string | number)[] = [];
      await createGroupStop({
        clock: manualClock(),
        killGroup: (_pgid, signal) => {
          signals.push(signal);
          return signal === "SIGTERM";
        },
        pid: () => 4242,
        sentinelExited: () => false,
        readySeen: () => readySeen,
        ready: readySeen ? Promise.resolve() : new Promise<void>(() => undefined),
        groupExists: () => true,
        pause: () => undefined,
      })();
      expect(signals).toEqual(readySeen ? ["SIGTERM", "SIGKILL"] : ["SIGKILL"]);
    }
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
      pause: () => undefined,
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
      await waitUntil(() => sentinelPid === undefined || !alive(sentinelPid), 10_000);
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
