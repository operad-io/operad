/**
 * File locks. Two kinds live here, and a plugin picks one instead of writing a
 * third:
 *
 * - `withFileLock`: an advisory `flock(2)` on an open file, released by the
 *   kernel when the process dies. For a short critical section.
 * - `withLockFile`: a lock file made with link/rename and a nonce, whose record
 *   names the holder's pid so a dead holder can be taken over. For a section
 *   that spans awaits and processes.
 */

import { dlopen, FFIType } from "bun:ffi";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { waitForChange } from "./watch.ts";

const LOCK_EX = 2;

type Flock = (fd: number, operation: number) => number;

let flockFunction: Flock | undefined;

function loadFlock(): Flock {
  if (flockFunction) return flockFunction;

  const candidates =
    process.platform === "darwin"
      ? ["libc.dylib"]
      : process.platform === "linux"
        ? ["libc.so.6", "libc.so", `libc.musl-${process.arch}.so.1`]
        : [];

  for (const library of candidates) {
    try {
      const { symbols } = dlopen(library, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      const symbol = symbols.flock;
      if (symbol) {
        flockFunction = (fd, operation) => symbol(fd, operation);
        return flockFunction;
      }
    } catch {
      // Try the next library name.
    }
  }

  throw new Error(
    `this needs flock(2), which is not available on ${process.platform}`,
  );
}

/**
 * Run `fn` while holding an exclusive advisory lock on `path`.
 *
 * The lock lives on the open file, so the kernel releases it when the process
 * dies, even with SIGKILL. The lock file itself may stay behind; that is fine.
 */
export function withFileLock<T>(path: string, fn: () => T): T {
  const fd = openSync(path, "a+");
  try {
    if (loadFlock()(fd, LOCK_EX) !== 0) {
      throw new Error(`could not lock ${path}`);
    }
    return fn();
  } finally {
    // Closing the descriptor releases the flock.
    closeSync(fd);
  }
}

/**
 * Hard-links `source` to `target`. Returns false when `target` exists; the link
 * either creates `target` with the full content of `source` or fails, so a
 * crash never leaves a half-written `target`.
 */
export function linkExclusive(source: string, target: string): boolean {
  try {
    linkSync(source, target);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

/** How long a waiter accepts a live holder before it gives up. */
const LOCK_TIMEOUT_MS = 10_000;

/** The fallback check interval when no watch event arrives. */
const LOCK_POLL_MS = 200;

/** An unreadable lock counts as dead once its mtime is this old. */
const STALE_UNREADABLE_MS = 30_000;

/** Thrown when a live holder keeps the lock past the waiter's timeout. */
export class LockTimeoutError extends Error {
  readonly lockPath: string;
  /** `pid N` for a readable record, `unknown pid` for an unreadable one. */
  readonly holder: string;

  constructor(lockPath: string, holder: string) {
    super(`${lockPath} is held by ${holder}`);
    this.name = "LockTimeoutError";
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

/** What a waiter may inject: the clock, how it waits, and where a log goes. */
export interface LockFileOptions {
  readonly clock?: (() => number) | undefined;
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
  /** Names the lock in log lines; defaults to `lock`. */
  readonly label?: string | undefined;
}

/**
 * Test-only hooks. Production code never sets them; the protocol must hold
 * without them. `beforeLink` stands for a crash between the tmp write and the
 * link; `beforeTakeoverRename` lets a test put a newer live lock in place.
 */
export const lockTestHooks: {
  beforeLink?: ((tmpPath: string, lockPath: string) => void) | undefined;
  beforeTakeoverRename?: ((lockPath: string) => void) | undefined;
} = {};

interface LockRecord {
  readonly pid: number;
  readonly startedAt: number | null;
  readonly nonce: string;
}

interface LockFile {
  readonly raw: string | undefined;
  readonly record: LockRecord | undefined;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function newNonce(): string {
  return randomBytes(16).toString("hex");
}

function readLockFile(path: string): LockFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { raw: undefined, record: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { raw, record: undefined };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { raw, record: undefined };
  const fields = parsed as Record<string, unknown>;
  const pid = fields.pid;
  const nonce = fields.nonce;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { raw, record: undefined };
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    return { raw, record: undefined };
  }
  const startedAt = fields.startedAt;
  return {
    raw,
    record: {
      pid,
      startedAt: typeof startedAt === "number" ? startedAt : null,
      nonce,
    },
  };
}

/** True while a process with this pid exists; `EPERM` means it exists too. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

let myStartedAt: number | null | undefined;

/** The start time of this process, when the platform will say; best effort. */
function myStart(): number | null {
  if (myStartedAt !== undefined) return myStartedAt;
  const pid = process.pid;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    if (Number.isFinite(ticks)) {
      myStartedAt = ticks;
      return ticks;
    }
  } catch {
    // Not Linux.
  }
  try {
    const result = Bun.spawnSync({
      cmd: ["ps", "-p", String(pid), "-o", "lstart="],
      stdout: "pipe",
      stderr: "pipe",
    });
    const at = Date.parse(result.stdout.toString().trim());
    myStartedAt = Number.isFinite(at) ? at : null;
  } catch {
    myStartedAt = null;
  }
  return myStartedAt;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function isStaleUnreadable(path: string, clock: () => number): boolean {
  try {
    return clock() - statSync(path).mtimeMs > STALE_UNREADABLE_MS;
  } catch {
    return false;
  }
}

/**
 * Takes over a lock whose record is dead. Takers go one at a time, under a
 * kernel `flock` on a guard file that dies with its holder, and each re-reads
 * the lock under the guard: it removes the file only if it is still the dead
 * record the taker decided on. While that file exists nobody can link a new
 * lock, and only a taker removes a dead record, so the removal cannot hit a
 * live lock another process has just made. (An earlier version let every taker
 * rename the file and put back a live lock it had renamed by mistake; with five
 * waiters the put-back could find a third lock in its place, and two holders
 * entered together.)
 */
function takeOver(lockPath: string, dead: LockFile): void {
  withFileLock(`${lockPath}.takeover`, () => {
    lockTestHooks.beforeTakeoverRename?.(lockPath);
    const now = readLockFile(lockPath);
    if (now.raw === undefined) return;
    const same =
      dead.record !== undefined && now.record !== undefined
        ? dead.record.nonce === now.record.nonce
        : dead.raw === now.raw;
    if (!same) return;
    safeUnlink(lockPath);
  });
}

async function acquire(
  lockPath: string,
  clock: () => number,
  wait: (ms: number) => Promise<void>,
  log: (message: string) => void,
): Promise<LockRecord> {
  const started = clock();
  for (;;) {
    const mine: LockRecord = {
      pid: process.pid,
      startedAt: myStart(),
      nonce: newNonce(),
    };
    const tmp = `${lockPath}.${mine.nonce}.tmp`;
    writeFileSync(tmp, JSON.stringify(mine), { flag: "wx" });
    lockTestHooks.beforeLink?.(tmp, lockPath);

    let linked = false;
    try {
      // `link` either creates the lock with its full content or fails EEXIST.
      linked = linkExclusive(tmp, lockPath);
    } catch (error) {
      safeUnlink(tmp);
      throw error;
    }
    if (linked) {
      safeUnlink(tmp);
      return mine;
    }
    safeUnlink(tmp);

    const holder = readLockFile(lockPath);
    if (holder.raw === undefined) {
      // The holder released between the link and the read; try again.
      continue;
    }
    const dead =
      holder.record === undefined
        ? isStaleUnreadable(lockPath, clock)
        : !isAlive(holder.record.pid);
    if (dead) {
      takeOver(lockPath, holder);
      continue;
    }

    if (clock() - started > LOCK_TIMEOUT_MS) {
      const who =
        holder.record === undefined ? "unknown pid" : `pid ${holder.record.pid}`;
      throw new LockTimeoutError(lockPath, who);
    }
    await wait(LOCK_POLL_MS);
  }
}

/** Releases this process's lock, never deleting a record that is not ours. */
function release(
  lockPath: string,
  mine: LockRecord,
  log: (message: string) => void,
): void {
  const released = `${lockPath}.release.${mine.nonce}`;
  try {
    renameSync(lockPath, released);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }

  const file = readLockFile(released);
  if (file.record?.nonce === mine.nonce) {
    safeUnlink(released);
    return;
  }

  try {
    linkSync(released, lockPath);
    safeUnlink(released);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    log(`${lockPath} changed while releasing; kept ${released}`);
  }
}

/**
 * Holds the lock file at `lockPath` while `work` runs. The file makes two
 * callers in two processes take turns; callers in one process wait too. A lock
 * whose holder died is taken over; a live holder past the timeout throws
 * `LockTimeoutError`.
 */
export async function withLockFile<T>(
  lockPath: string,
  work: () => Promise<T> | T,
  options: LockFileOptions = {},
): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const clock = options.clock ?? (() => Date.now());
  const wait =
    options.wait ??
    ((ms: number) => waitForChange(dirname(lockPath), lockPath, ms));
  const label = options.label ?? "lock";
  const onLog = options.onLog ?? ((message: string) => console.error(message));
  const log = (message: string): void => onLog(`${label}: ${message}`);
  const mine = await acquire(lockPath, clock, wait, log);
  try {
    return await work();
  } finally {
    release(lockPath, mine, log);
  }
}
