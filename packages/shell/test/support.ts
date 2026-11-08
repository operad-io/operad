import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { waitForChange, type Clock } from "@operad-io/engine/platform";

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

/**
 * How long a wait for a file sleeps between two looks when no directory event
 * comes. A directory watch can miss a file made while it was starting, so the
 * wait never relies on the event alone (see `waitForChange`).
 */
const LOOK_MS = 100;

/** Resolves when the file exists. Event first; a look every `LOOK_MS` besides. */
export async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await waitForChange(dirname(path), basename(path), LOOK_MS);
  }
}

/** True for a pid a test may signal: a finite integer above 1 (never 0, 1 or a group). */
export function signalable(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1;
}

/**
 * Resolves with the pid a shell wrote to `path`, once the file holds one. The
 * file exists, empty, before the shell writes to it, so existence is not enough.
 */
export async function waitForPid(path: string): Promise<number> {
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

export interface ManualClock extends Clock {
  /** Fires every timeout still scheduled; returns how many there were. */
  fireTimeouts(): number;
  /** Resolves once `predicate` holds; every timer change rechecks it. */
  when(predicate: () => boolean): Promise<void>;
  /** How many timeouts are scheduled right now. */
  readonly pending: number;
  /** How many grace waits were requested. */
  readonly sleeps: number;
}

/**
 * A clock a test drives: timeouts run only when the test fires them, and a
 * grace wait returns at once. No test waits for real time: a test that needs
 * to know a timer exists asks `when` and is woken by a timer change.
 */
export function manualClock(): ManualClock {
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
    fireTimeouts() {
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
