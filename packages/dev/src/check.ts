/**
 * The dev plugin's `init` check: every registered repository has a remote that
 * answers, accepts a push to a scratch ref and deletes that ref again. The
 * check writes nothing into the repository and leaves no ref behind on the
 * remote when it can avoid it.
 */

import { randomUUID } from "node:crypto";
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

/** Deletes a scratch ref after a push that may or may not have landed. */
function deleteScratch(cwd: string, remote: string, ref: string): void {
  git(cwd, ["push", "--quiet", remote, "--delete", ref]);
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
    settings.remote,
    `${head.out}:${ref}`,
  ]);
  if (!pushed.ok) {
    deleteScratch(repository.path, settings.remote, ref);
    throw new Error(
      `remote "${settings.remote}" refused a push: ${firstLine(pushed.err)}`,
    );
  }
  const deleted = git(repository.path, [
    "push",
    "--quiet",
    settings.remote,
    "--delete",
    ref,
  ]);
  if (!deleted.ok) {
    throw new Error(
      `remote "${settings.remote}" accepted a push but refused to delete the scratch ref: ${firstLine(deleted.err)}`,
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
