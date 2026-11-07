import { existsSync, watch, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Clock } from "@operad-io/harness-process";

const roots: string[] = [];

/** A scratch directory under `.radian/`, removed by `cleanupTempRoots`. */
export async function tempRoot(): Promise<string> {
  const base = join(process.cwd(), ".radian", "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "harness-pi-test-"));
  roots.push(root);
  return root;
}

export async function cleanupTempRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // A test that timed out can leave a directory it locked; unlock and retry.
      await unlock(root);
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function unlock(path: string): Promise<void> {
  try {
    await chmod(path, 0o700);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await unlock(join(path, entry.name));
    }
  } catch {
    // The path may already be gone, or not be a directory.
  }
}

/** Resolves when the file exists, without asking repeatedly: watches the directory. */
export function waitForFile(path: string): Promise<void> {
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

export interface ManualClock extends Clock {
  /** Fires every timeout whose requested delay is at most `maxMs`. */
  fireUpTo(maxMs?: number): number;
  /** Resolves once `predicate` holds; every timer change rechecks it. */
  when(predicate: () => boolean): Promise<void>;
  /** How many grace waits were requested. */
  readonly sleeps: number;
  /** How many timers were cancelled, which shows a stall timer was reset. */
  readonly clears: number;
}

interface Timer {
  readonly handler: () => void;
  readonly ms: number;
}

interface Waiter {
  readonly predicate: () => boolean;
  readonly resolve: () => void;
}

/**
 * A clock a test drives: timeouts run only when the test fires them, and a
 * grace wait returns at once. No test waits for real time: a test that needs
 * to know a timer exists asks `when` and is woken by a timer change.
 */
export function manualClock(): ManualClock {
  const timers = new Set<Timer>();
  const waiters: Waiter[] = [];
  let sleeps = 0;
  let clears = 0;

  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.predicate()) continue;
      waiters.splice(index, 1);
      waiter.resolve();
    }
  };

  return {
    setTimeout(handler, ms) {
      const timer = { handler, ms };
      timers.add(timer);
      notify();
      return timer;
    },
    clearTimeout(handle) {
      clears += 1;
      timers.delete(handle as Timer);
      notify();
    },
    sleep() {
      sleeps += 1;
      return Promise.resolve();
    },
    fireUpTo(maxMs = Number.POSITIVE_INFINITY) {
      const due = [...timers].filter((timer) => timer.ms <= maxMs);
      for (const timer of due) timers.delete(timer);
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
    get sleeps() {
      return sleeps;
    },
    get clears() {
      return clears;
    },
  };
}
