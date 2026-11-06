/** The repository lock: one dev writer per repository, safe across processes. */

import { randomBytes } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DevError, isRecord } from "./model.ts";

/** How long a waiter accepts a live holder before it gives up. */
const LOCK_TIMEOUT_MS = 10_000;

/** The fallback check interval when no watch event arrives. */
const LOCK_POLL_MS = 200;

/** An unreadable lock counts as dead once its mtime is this old. */
const STALE_UNREADABLE_MS = 30_000;

/** What a waiter may inject: the clock, how it waits, and where a log goes. */
export interface RepositoryLockOptions {
  readonly clock?: (() => number) | undefined;
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
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
  if (!isRecord(parsed)) return { raw, record: undefined };
  const pid = parsed.pid;
  const nonce = parsed.nonce;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { raw, record: undefined };
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    return { raw, record: undefined };
  }
  const startedAt = parsed.startedAt;
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

/**
 * Waits for the lock directory to change, or for one fallback interval. The
 * directory is watched because the lock file is renamed and replaced.
 */
function waitForLock(path: string, ms: number): Promise<void> {
  return new Promise((done) => {
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      watcher?.close();
      if (timer !== undefined) clearTimeout(timer);
      done();
    };
    timer = setTimeout(finish, Math.max(1, ms));
    try {
      watcher = watch(dirname(path), (_event, filename) => {
        if (filename === null || filename === basename(path)) finish();
      });
      watcher.on("error", finish);
    } catch {
      // The timer is the fallback when watching is unavailable.
    }
  });
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
 * Takes over a lock whose record is dead. The rename decides the winner: only
 * one process can rename a given file, and `ENOENT` means another did.
 *
 * This protocol leaves one window: three processes can decide the lock is dead
 * inside the same few microseconds and one of them can rename a lock another
 * has just created. The rename-back below keeps that newer lock, and a third
 * process may still win the next acquire; the critical section stays single.
 * This is accepted: the window needs the old holder to die and three waiters to
 * interleave within microseconds.
 */
async function takeOver(
  lockPath: string,
  dead: LockFile,
  onLog: (message: string) => void,
): Promise<true> {
  const stale = `${lockPath}.stale.${newNonce()}`;
  lockTestHooks.beforeTakeoverRename?.(lockPath);
  try {
    renameSync(lockPath, stale);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }

  const renamed = readLockFile(stale);
  const same =
    dead.record !== undefined && renamed.record !== undefined
      ? dead.record.nonce === renamed.record.nonce
      : dead.raw === renamed.raw;
  if (same) {
    safeUnlink(stale);
    return true;
  }

  // We renamed a newer live lock: put it back and never delete it.
  try {
    linkSync(stale, lockPath);
    safeUnlink(stale);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    onLog(
      `dev lock: a newer lock appeared while taking over ${lockPath}; kept ${stale}`,
    );
  }
  return true;
}

async function acquire(
  lockPath: string,
  clock: () => number,
  wait: (ms: number) => Promise<void>,
  onLog: (message: string) => void,
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
      linkSync(tmp, lockPath);
      linked = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        safeUnlink(tmp);
        throw error;
      }
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
      await takeOver(lockPath, holder, onLog);
      continue;
    }

    if (clock() - started > LOCK_TIMEOUT_MS) {
      const who =
        holder.record === undefined ? "unknown pid" : `pid ${holder.record.pid}`;
      throw new DevError(
        "lock",
        `another dev command holds ${lockPath} (${who})`,
      );
    }
    await wait(LOCK_POLL_MS);
  }
}

/** Releases this process's lock, never deleting a record that is not ours. */
function release(
  lockPath: string,
  mine: LockRecord,
  onLog: (message: string) => void,
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
    onLog(`dev lock: ${lockPath} changed while releasing; kept ${released}`);
  }
}

/**
 * Holds one repository's lock while ids and counts change. The lock file makes
 * two commands in two processes take turns; commands in one process wait too.
 */
export async function withRepositoryLock<T>(
  repositoryPath: string,
  work: () => Promise<T> | T,
  options: RepositoryLockOptions = {},
): Promise<T> {
  const directory = join(repositoryPath, ".operad");
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, "dev.lock");
  const clock = options.clock ?? (() => Date.now());
  const wait = options.wait ?? ((ms: number) => waitForLock(lockPath, ms));
  const onLog = options.onLog ?? ((message: string) => console.error(message));
  const mine = await acquire(lockPath, clock, wait, onLog);
  try {
    return await work();
  } finally {
    release(lockPath, mine, onLog);
  }
}
