/** Scratch directories and git repositories for the dev tests. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FilePluginStore } from "@operad-io/engine";

const roots: string[] = [];

/** A scratch directory under `.radian/`, removed by `cleanupTempRoots`. */
export async function tempRoot(): Promise<string> {
  const base = join(process.cwd(), ".radian", "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "dev-test-"));
  roots.push(root);
  return root;
}

export async function cleanupTempRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
}

/** A git work tree with an origin remote. */
export async function makeGitRepository(
  parent: string,
  name = "repository",
): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q"]);
  git(path, ["remote", "add", "origin", "https://example.com/repo.git"]);
  await writeFile(join(path, "README.md"), "# test\n");
  git(path, ["add", "README.md"]);
  git(path, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "start"]);
  return path;
}

export function storeAt(path: string): FilePluginStore {
  return new FilePluginStore({ root: join(path, "store") });
}
