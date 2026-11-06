import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Clock } from "../src/process.ts";

const roots: string[] = [];

/** A scratch directory under `.radian/`, removed by `cleanupTempRoots`. */
export async function tempRoot(): Promise<string> {
  const base = join(process.cwd(), ".radian", "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "shell-test-"));
  roots.push(root);
  return root;
}

export async function cleanupTempRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
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
  /** Fires every timeout still scheduled; returns how many there were. */
  fireTimeouts(): number;
  /** How many grace waits were requested. */
  readonly sleeps: number;
}

/**
 * A clock a test drives: timeouts run only when the test fires them, and a
 * grace wait returns at once. No test waits for real time.
 */
export function manualClock(): ManualClock {
  const timers = new Set<{ readonly handler: () => void }>();
  let sleeps = 0;
  return {
    setTimeout(handler) {
      const timer = { handler };
      timers.add(timer);
      return timer;
    },
    clearTimeout(handle) {
      timers.delete(handle as { readonly handler: () => void });
    },
    sleep() {
      sleeps += 1;
      return Promise.resolve();
    },
    fireTimeouts() {
      const due = [...timers];
      timers.clear();
      for (const timer of due) timer.handler();
      return due.length;
    },
    get sleeps() {
      return sleeps;
    },
  };
}
