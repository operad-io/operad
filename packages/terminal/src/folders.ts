/** The folders a terminal may start in: a registered repository or one of its worktrees. */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SettingsRepository } from "@operad-io/engine";
import { findGit } from "@operad-io/engine/platform";

/** The real path of a directory, or undefined when there is none. */
function directory(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The worktrees git lists for a repository; none when git cannot say. */
async function worktrees(repository: string): Promise<readonly string[]> {
  const git = findGit();
  if (git === undefined) return [];
  try {
    const child = Bun.spawn([git, "-C", repository, "worktree", "list", "--porcelain", "-z"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return [];
    return output
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length));
  } catch {
    return [];
  }
}

/**
 * The real path of `folder` when it is a registered repository's folder or one
 * of its worktrees, otherwise undefined.
 */
export async function knownFolder(
  folder: string,
  repositories: readonly SettingsRepository[],
): Promise<string | undefined> {
  if (!isAbsolute(folder)) return undefined;
  const asked = directory(folder);
  if (asked === undefined) return undefined;
  if (repositories.some((repository) => directory(repository.path) === asked)) return asked;
  for (const repository of repositories) {
    const found = await worktrees(repository.path);
    if (found.some((path) => directory(path) === asked)) return asked;
  }
  return undefined;
}
