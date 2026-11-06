/**
 * The dev plugin's `init` check: every registered repository has a remote that
 * answers and publishes its main branch. The check only reads: it asks the
 * remote for its heads through the remote's name, so git's URL rewriting and
 * credentials apply as they would for a real command, and writes nothing.
 */

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

/** True when `git ls-remote` listed the branch under its full ref name. */
function listsBranch(output: string, branch: string): boolean {
  const ref = `refs/heads/${branch}`;
  return output
    .split("\n")
    .some((line) => line.split("\t")[1]?.trim() === ref);
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
    throw new Error(`remote "${settings.remote}" does not exist`);
  }

  const listed = git(repository.path, [
    "ls-remote",
    "--heads",
    settings.remote,
    settings.mainBranch,
  ]);
  if (!listed.ok) {
    throw new Error(
      `cannot reach remote "${settings.remote}": ${firstLine(listed.err)}`,
    );
  }
  if (!listsBranch(listed.out, settings.mainBranch)) {
    throw new Error(
      `remote "${settings.remote}" has no branch "${settings.mainBranch}"`,
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
