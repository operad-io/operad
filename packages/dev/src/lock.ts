/** The repository lock: one dev writer per repository, safe across processes. */

import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultOperadHome } from "@operad-io/engine";
import {
  LOCK_TIMEOUT_MS,
  LockTimeoutError,
  withLockFile,
  type LockFileOptions,
} from "@operad-io/engine/platform";
import { git } from "./git.ts";
import { DevError } from "./model.ts";

/** What a waiter may inject: the clock, how it waits, and where a log goes. */
export type RepositoryLockOptions = Omit<LockFileOptions, "label">;

/** Where an older dev kept its lock, inside the working tree. */
const LEGACY_LOCK_FILE = join(".operad", "dev.lock");

function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The identity of a repository, shared by every worktree. The git directory is
 * common to all worktrees, so a lock taken through one holds through all.
 */
function repositoryKey(repositoryPath: string): string {
  const common = git(repositoryPath, ["rev-parse", "--git-common-dir"]);
  const directory = realpathOr(
    common.ok ? resolve(repositoryPath, common.out) : resolve(repositoryPath),
  );
  return new Bun.CryptoHasher("sha1").update(directory).digest("hex");
}

/**
 * The lock file of one repository. It lives in the operad home, never in the
 * working tree: a held lock must not make the main clone look dirty to a merge.
 */
export function repositoryLockPath(
  repositoryPath: string,
  home: string = defaultOperadHome(),
): string {
  return join(home, "dev", "repository-locks", `${repositoryKey(repositoryPath)}.lock`);
}

/**
 * Removes the lock older versions left in the working tree, but only when
 * nobody holds it. An old holder keeps it until it ends; that lock is not ours
 * and its process still relies on it.
 */
async function removeLegacyLock(repositoryPath: string): Promise<void> {
  const legacy = join(repositoryPath, LEGACY_LOCK_FILE);
  if (!existsSync(legacy)) return;
  const held = new Error("the legacy dev lock is held");
  try {
    await withLockFile(
      legacy,
      () => {
        unlinkSync(legacy);
      },
      {
        label: "dev lock",
        onLog: () => {},
        timeoutMs: 0,
        wait: () => Promise.reject(held),
      },
    );
  } catch {
    // A held or unreadable old lock is left as it is; the new lock is elsewhere.
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
  await removeLegacyLock(repositoryPath);
  const lockPath = repositoryLockPath(repositoryPath);
  try {
    return await withLockFile(lockPath, work, { ...options, label: "dev lock" });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      throw new DevError(
        "lock",
        `another dev command holds ${error.lockPath} (${error.holder}); gave up after ${LOCK_TIMEOUT_MS / 1_000}s`,
      );
    }
    throw error;
  }
}
