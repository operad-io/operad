/** The folder a terminal starts in, and the registered repository it belongs to. */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SettingsRepository } from "@operad-io/engine";
import { findGit } from "@operad-io/engine/platform";

/** The real path of the folder asked for, or why a terminal cannot start there. */
export type StartFolder = { readonly path: string } | { readonly refusal: string };

export function startFolder(folder: string): StartFolder {
  // `~` is not expanded: it is not an absolute path either.
  if (!isAbsolute(folder)) {
    return { refusal: `the folder must be an absolute path, with no "~", and "${folder}" is not one` };
  }
  try {
    const path = realpathSync(folder);
    return statSync(path).isDirectory() ? { path } : { refusal: `"${folder}" is not a folder` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { refusal: `there is no folder at "${folder}"` };
    const why = error instanceof Error ? error.message : String(error);
    return { refusal: `the folder "${folder}" cannot be opened: ${why}` };
  }
}

/** The real path of a directory, or undefined when there is none. */
function directory(path: string): string | undefined {
  const found = startFolder(path);
  return "path" in found ? found.path : undefined;
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
 * The name of the registered repository whose folder or worktree `folder`, a
 * real path, is; undefined when it is none's. A repository's own folder comes
 * before another's worktree.
 */
export async function repositoryOf(
  folder: string,
  repositories: readonly SettingsRepository[],
): Promise<string | undefined> {
  const own = repositories.find((repository) => directory(repository.path) === folder);
  if (own !== undefined) return own.name;
  for (const repository of repositories) {
    const found = await worktrees(repository.path);
    if (found.some((path) => directory(path) === folder)) return repository.name;
  }
  return undefined;
}
