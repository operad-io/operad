/** One lock file per run and one per home, with a stale-PID check. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LockHeldError } from "./errors.ts";

interface LockContents {
  readonly pid: number;
  readonly at: number;
}

export interface LockOptions {
  readonly pid?: number | undefined;
  readonly clock?: (() => number) | undefined;
  /** Test hook; defaults to asking the OS whether the PID exists. */
  readonly isAlive?: ((pid: number) => boolean) | undefined;
}

export interface LockHandle {
  readonly path: string;
  release(): void;
}

/** True when the OS knows the PID (it may belong to another user). */
export function pidAlive(pid: number): boolean {
  return defaultIsAlive(pid);
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function readLock(path: string): LockContents | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof raw === "object" &&
      raw !== null &&
      "pid" in raw &&
      typeof raw.pid === "number"
    ) {
      return {
        pid: raw.pid,
        at:
          "at" in raw && typeof raw.at === "number" ? raw.at : 0,
      };
    }
  } catch {
    // A torn or deleted lock is stale.
  }
  return undefined;
}

/**
 * The PID a lock file names, or undefined when there is no lock or it cannot
 * be read. It never removes a file, so a caller can look without touching.
 */
export function readLockPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  return readLock(path)?.pid;
}

/** True when a live process holds `path`. A stale lock is removed. */
export function lockHeld(path: string, options: LockOptions = {}): boolean {
  if (!existsSync(path)) return false;
  const contents = readLock(path);
  if (contents === undefined) {
    rmSync(path, { force: true });
    return false;
  }
  const isAlive = options.isAlive ?? defaultIsAlive;
  if (isAlive(contents.pid)) return true;
  rmSync(path, { force: true });
  return false;
}

/**
 * Creates `path` holding this PID, unless a live process already holds it.
 * A lock whose PID is gone is replaced.
 */
export function acquireLock(path: string, options: LockOptions = {}): LockHandle {
  const pid = options.pid ?? process.pid;
  const clock = options.clock ?? (() => Date.now());
  const isAlive = options.isAlive ?? defaultIsAlive;
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(
        path,
        `${JSON.stringify({ pid, at: clock() } satisfies LockContents)}\n`,
        { flag: "wx" },
      );
      return {
        path,
        release: () => {
          const contents = readLock(path);
          if (contents?.pid === pid) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
      const contents = readLock(path);
      if (contents !== undefined && isAlive(contents.pid)) {
        throw new LockHeldError(path, `run ${contents.pid} is still alive`);
      }
      // Stale or ours: remove it and try once more.
      rmSync(path, { force: true });
    }
  }
  throw new LockHeldError(path, "could not take it");
}

export function runLockPath(lockRoot: string, runId: string): string {
  return join(lockRoot, "locks", "runs", `${runId}.lock`);
}

export function serveLockPath(home: string): string {
  return join(home, "serve.lock");
}
