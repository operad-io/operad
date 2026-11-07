/** The repository lock: one dev writer per repository, safe across processes. */

import { join } from "node:path";
import {
  LockTimeoutError,
  withLockFile,
  type LockFileOptions,
} from "@operad-io/engine/platform";
import { DevError } from "./model.ts";

/** What a waiter may inject: the clock, how it waits, and where a log goes. */
export type RepositoryLockOptions = Omit<LockFileOptions, "label">;

/**
 * Holds one repository's lock while ids and counts change. The lock file makes
 * two commands in two processes take turns; commands in one process wait too.
 */
export async function withRepositoryLock<T>(
  repositoryPath: string,
  work: () => Promise<T> | T,
  options: RepositoryLockOptions = {},
): Promise<T> {
  const lockPath = join(repositoryPath, ".operad", "dev.lock");
  try {
    return await withLockFile(lockPath, work, { ...options, label: "dev lock" });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      throw new DevError(
        "lock",
        `another dev command holds ${error.lockPath} (${error.holder})`,
      );
    }
    throw error;
  }
}
