/**
 * The dev plugin's `init` check: every registered repository has a remote that
 * answers and accepts a push to a scratch ref. The check leaves no ref on the
 * remote. It pushes the scratch ref only to a remote whose repository is a path
 * on this machine, because only there can it remove the ref when the remote
 * refuses the delete: it removes the ref from that repository directly and
 * fails the check. A remote this process can only reach over the wire gets a
 * dry-run push, which reaches and authenticates the remote and writes nothing,
 * so a remote that would refuse the delete never receives a ref it cannot
 * remove.
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
 * Removes a scratch ref from the repository of a remote that is a path on this
 * machine, without asking the remote over the wire. Returns false when the ref
 * may remain.
 */
function removeScratchDirect(gitDir: string, ref: string): boolean {
  const removed = git(gitDir, ["update-ref", "-d", ref]);
  if (!removed.ok) return false;
  const remaining = git(gitDir, ["show-ref", "--verify", "--quiet", ref]);
  return !remaining.ok;
}

/**
 * Pushes the head commit to a scratch ref of a remote that is a path on this
 * machine and deletes that ref again. A remote that refuses the wire delete is
 * still clean: the ref is removed from that repository directly, and the check
 * fails with what the remote said.
 */
function pushAndRemove(
  cwd: string,
  remoteUrl: string,
  name: string,
  head: string,
  ref: string,
  gitDir: string,
): void {
  const pushed = git(cwd, ["push", "--quiet", remoteUrl, `${head}:${ref}`]);
  if (!pushed.ok) {
    removeScratchDirect(gitDir, ref);
    throw new Error(
      `remote "${name}" refused a push: ${firstLine(pushed.err)}`,
    );
  }
  const deleted = git(cwd, ["push", "--quiet", remoteUrl, "--delete", ref]);
  if (deleted.ok) return;
  if (!removeScratchDirect(gitDir, ref)) {
    throw new Error(
      `remote "${name}" accepted a push but refused to delete the scratch ref ${ref}: ${firstLine(deleted.err)}`,
    );
  }
  throw new Error(
    `remote "${name}" accepted a push but refused to delete the scratch ref; it was removed from ${gitDir}: ${firstLine(deleted.err)}`,
  );
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
  const gitDir = localGitDir(repository.path, remoteUrl);
  if (gitDir !== undefined) {
    pushAndRemove(
      repository.path,
      remoteUrl,
      settings.remote,
      head.out,
      ref,
      gitDir,
    );
    return settings.remote;
  }

  // Nothing can remove a ref from a remote this process can only reach over the
  // wire, so the check must not leave one there: ask what a push would do and
  // write nothing.
  const dryRun = git(repository.path, [
    "push",
    "--dry-run",
    "--quiet",
    remoteUrl,
    `${head.out}:${ref}`,
  ]);
  if (!dryRun.ok) {
    throw new Error(
      `remote "${settings.remote}" refused a push: ${firstLine(dryRun.err)}`,
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
