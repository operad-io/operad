/**
 * The dev plugin's `init` check: every registered repository that has a remote
 * has one that answers and publishes its main branch; one without a remote has
 * its main branch locally. The check only reads: it asks the
 * remote for its heads through the remote's name, so git's URL rewriting and
 * credentials apply as they would for a real command, and writes nothing.
 */

import { messageOf, type MissingItem, type PluginBaseContext } from "@operad-io/engine";

/** The check's answer when something is missing (ADR 0010 D7). */
type SetupMissing = { readonly note: string; readonly missing: readonly MissingItem[] };
import { git } from "./git.ts";
import { gitStateOf } from "./git-state.ts";
import { listRepositories } from "./service.ts";
import { readDevSettings } from "./settings.ts";

/** Git's own explanation, every line of it, or a plain note when it said nothing. */
function detail(text: string): string {
  return text.length === 0 ? "no detail" : text;
}

/** True when `git ls-remote` listed the branch under its full ref name. */
function listsBranch(output: string, branch: string): boolean {
  const ref = `refs/heads/${branch}`;
  return output
    .split("\n")
    .some((line) => line.split("\t")[1]?.trim() === ref);
}

/** Checks one repository and returns the remote it used, or undefined when it has none. */
async function checkRepository(
  repository: { readonly name: string; readonly path: string },
): Promise<string | undefined> {
  const settings = await readDevSettings(repository.path);
  const remoteName = settings.remote;
  if (remoteName === undefined) {
    // No remote: the local main branch is the base, and it must exist.
    const local = git(repository.path, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${settings.mainBranch}`,
    ]);
    if (!local.ok) throw new Error(`no branch "${settings.mainBranch}"`);
    return undefined;
  }
  // The init check must never wait for a credential prompt; the shared runner
  // retries an empty success under load.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const remote = git(repository.path, [
    "remote",
    "get-url",
    remoteName,
  ], { env });
  if (!remote.ok || remote.out.length === 0) {
    throw new Error(`remote "${remoteName}" does not exist`);
  }

  const listed = git(repository.path, [
    "ls-remote",
    "--heads",
    remoteName,
    settings.mainBranch,
  ], { env });
  if (!listed.ok) {
    throw new Error(
      `cannot reach remote "${remoteName}": ${detail(listed.err)}`,
    );
  }
  if (!listsBranch(listed.out, settings.mainBranch)) {
    throw new Error(
      `remote "${remoteName}" has no branch "${settings.mainBranch}"`,
    );
  }
  return remoteName;
}

/** Runs the repository loop and reports one line, or throws with every failure. */
export async function checkDev(ctx: PluginBaseContext): Promise<string | SetupMissing> {
  const repositories = await listRepositories(ctx.store);
  if (repositories.length === 0) {
    return {
      note: "no repositories registered",
      missing: [{ name: "repository", description: "no repository is registered with dev" }],
    };
  }

  const failures: string[] = [];
  for (const repository of repositories) {
    // A folder without git, or with no commit yet, is not a failure: git is
    // needed only to create a task, and the setup there makes the folder ready.
    // A folder git cannot judge is a failure with git's own message.
    try {
      if (gitStateOf(repository.path).state !== "ready") continue;
      await checkRepository(repository);
    } catch (error) {
      failures.push(`repository "${repository.name}": ${messageOf(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
  return `${repositories.length} repositories checked`;
}
