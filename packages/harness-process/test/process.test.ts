import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgent, type Clock } from "../src/index.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "operad-harness-process-test-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** Resolves when the file exists, watching the directory instead of polling. */
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
  fireTimers(): number;
  when(predicate: () => boolean): Promise<void>;
  readonly pending: number;
  readonly sleeps: number;
}

/** A clock a test drives: the run never waits a real second for the drain. */
function manualClock(): ManualClock {
  const timers = new Set<{ readonly handler: () => void }>();
  const waiters: Array<{ readonly predicate: () => boolean; readonly resolve: () => void }> = [];
  let sleeps = 0;

  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.predicate()) continue;
      waiters.splice(index, 1);
      waiter.resolve();
    }
  };

  return {
    setTimeout(handler) {
      const timer = { handler };
      timers.add(timer);
      notify();
      return timer;
    },
    clearTimeout(handle) {
      timers.delete(handle as { readonly handler: () => void });
      notify();
    },
    sleep() {
      sleeps += 1;
      return Promise.resolve();
    },
    fireTimers() {
      const due = [...timers];
      timers.clear();
      for (const timer of due) timer.handler();
      notify();
      return due.length;
    },
    when(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
    get pending() {
      return timers.size;
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

describe("the harness process", () => {
  test("a child that leaves the group cannot hold the run open", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "escaped.pid");
    const clock = manualClock();
    const running = runAgent({
      command: "sh",
      args: ["-c", `set -m; sleep 60 & echo $! > '${pidFile}'`],
      cwd: root,
      wallMs: 0,
      stallMs: 0,
      signal: new AbortController().signal,
      clock,
      onLine() {},
    });

    // The drain grace comes from the injected clock, so the test ends it.
    await clock.when(() => clock.pending > 0);
    expect(clock.fireTimers()).toBe(1);

    const outcome = await running;
    const pid = Number((await Bun.file(pidFile).text()).trim());
    try {
      expect(outcome.exitCode).toBe(0);
      expect(pid).toBeGreaterThan(0);
      expect(alive(pid)).toBe(true);
      // A finished command is stopped directly, without the KILL grace.
      expect(clock.sleeps).toBe(0);
    } finally {
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});
