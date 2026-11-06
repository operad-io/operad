/**
 * The dev plugin's `init` check: every registered repository has a remote that
 * answers, accepts a push to a scratch ref and deletes that ref again. The
 * check writes nothing into the repository and leaves no ref behind on the
 * remote: a remote that refuses the wire delete but is a path on this machine
 * is cleaned directly.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { messageOf, type PluginBaseContext } from "@operad-io/engine";
import { listRepositories } from "./service.ts";
import { readDevSettings } from "./settings.ts";

interface GitResult {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function git(cwd: string, args: readonly string[]): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim();
  return line === undefined || line.length === 0 ? "no detail" : line;
}

/**
 * The git directory of a remote that names a path on this machine, or
 * undefined for a remote this process can only reach over the wire. A bare
 * repository is its own git directory; a work tree's is below `.git`.
 */
function localGitDir(cwd: string, remote: string): string | undefined {
  let path = remote;
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^[^/]+@[^/]+:/.test(path)) {
    return undefined;
  }
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  if (!existsSync(full)) return undefined;
  const found = git(full, ["rev-parse", "--absolute-git-dir"]);
  return found.ok && found.out.length > 0 ? found.out : undefined;
}

/**
 * Removes a scratch ref after a push. The wire delete is the ordinary path; a
 * remote that refuses it can still be a local repository, so remove the ref
 * directly there. Returns false when the ref may remain.
 */
function removeScratch(cwd: string, remote: string, ref: string): boolean {
  const deleted = git(cwd, ["push", "--quiet", remote, "--delete", ref]);
  if (deleted.ok) return true;
  const gitDir = localGitDir(cwd, remote);
  if (gitDir === undefined) return false;
  return git(gitDir, ["update-ref", "-d", ref]).ok;
}

/** Checks one repository and returns the remote it used. */
async function checkRepository(
  repository: { readonly name: string; readonly path: string },
): Promise<string> {
  const settings = await readDevSettings(repository.path);
  const remote = git(repository.path, [
    "remote",
    "get-url",
    settings.remote,
  ]);
  if (!remote.ok || remote.out.length === 0) {
    throw new Error(`remote "${settings.remote}" is not configured`);
  }
  const remoteUrl = remote.out;

  const reachable = git(repository.path, [
    "ls-remote",
    "--heads",
    settings.remote,
  ]);
  if (!reachable.ok) {
    throw new Error(
      `cannot reach remote "${settings.remote}": ${firstLine(reachable.err)}`,
    );
  }

  const head = git(repository.path, ["rev-parse", "HEAD"]);
  if (!head.ok || head.out.length === 0) {
    throw new Error("the repository has no commit to push");
  }

  const ref = `refs/operad/check/${randomUUID()}`;
  const pushed = git(repository.path, [
    "push",
    "--quiet",
    remoteUrl,
    `${head.out}:${ref}`,
  ]);
  if (!pushed.ok) {
    removeScratch(repository.path, remoteUrl, ref);
    throw new Error(
      `remote "${settings.remote}" refused a push: ${firstLine(pushed.err)}`,
    );
  }
  const deleted = git(repository.path, [
    "push",
    "--quiet",
    remoteUrl,
    "--delete",
    ref,
  ]);
  if (!deleted.ok) {
    const removed = removeScratch(repository.path, remoteUrl, ref);
    const leftover = removed ? "" : `; the scratch ref ${ref} remains`;
    throw new Error(
      `remote "${settings.remote}" accepted a push but refused to delete the scratch ref: ${firstLine(deleted.err)}${leftover}`,
    );
  }
  return settings.remote;
}

/** Runs the repository loop and reports one line, or throws with every failure. */
export async function checkDev(ctx: PluginBaseContext): Promise<string> {
  const repositories = await listRepositories(ctx.store);
  if (repositories.length === 0) return "no repositories registered";

  const failures: string[] = [];
  for (const repository of repositories) {
    try {
      await checkRepository(repository);
    } catch (error) {
      failures.push(`repository "${repository.name}": ${messageOf(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
  return `${repositories.length} repositories checked`;
}
