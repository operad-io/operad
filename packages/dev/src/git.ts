/**
 * The one way dev runs a git query. Under heavy load git sometimes exits 0 with
 * empty stdout and stderr (8 in 120000 `rev-parse` runs, with Bun and node), so
 * a query whose output is expected is run again, a bounded number of times,
 * before an empty answer is believed.
 */

import { findGit, GIT_NOT_INSTALLED, realGitFinderHost } from "@operad-io/engine/platform";

export interface GitResult {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

export interface GitOptions {
  /** Keep the output exactly as git wrote it; the default trims it. */
  readonly raw?: boolean;
  /** Input for a command that reads stdin. */
  readonly input?: string | Uint8Array;
  /** The command's environment; the default is this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** How long one run may take before it is killed; the default is `GIT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * How long one git run may take. It is well under a test's 30 s limit, so a git
 * that never exits is reported with its command instead of as a silent timeout.
 * This is a diagnosis, not a retry: the run is not tried again.
 */
export const GIT_TIMEOUT_MS = 20_000;

/** A git run that did not end within its limit and was killed. */
export class GitTimeoutError extends Error {
  constructor(
    readonly cwd: string,
    readonly args: readonly string[],
    readonly ranMs: number,
  ) {
    super(`git ${args.join(" ")} in ${cwd} did not end after ${ranMs} ms and was killed`);
    this.name = "GitTimeoutError";
  }
}

/** How many times a query that printed nothing is run in all. */
export const GIT_EMPTY_ATTEMPTS = 5;

/**
 * True when a successful run of this git command always prints something, so
 * an empty success is a glitch. Every other command (diff, status, rev-list,
 * fetch, push, merge, commit, reset, worktree add/prune/remove, branch,
 * `merge-base --is-ancestor`, `cat-file -e`, ...) may print nothing and is run
 * once: they are the commands marked as allowed to print nothing.
 */
export function printsOnSuccess(args: readonly string[]): boolean {
  const [command, sub] = args;
  switch (command) {
    case "rev-parse":
    case "symbolic-ref":
      return true;
    case "worktree":
      return sub === "list";
    case "merge-base":
      return !args.includes("--is-ancestor");
    case "remote":
      // `remote` alone may print nothing: a repository need not have one.
      return args[1] === "get-url";
    case "ls-remote":
    case "patch-id":
    case "check-attr":
      return true;
    default:
      return false;
  }
}

function runOnce(cwd: string, args: readonly string[], options: GitOptions): GitResult {
  const started = Date.now();
  const env = options.env ?? { ...process.env };
  // The absolute path found now, not the word `git`: a PATH that changed after
  // this process started is not seen by a spawn. Nothing is spawned without it.
  const program = findGit({ ...realGitFinderHost(), env });
  if (program === undefined) return { ok: false, out: "", err: GIT_NOT_INSTALLED };
  const result = Bun.spawnSync({
    cmd: [program, "-C", cwd, ...args],
    stdin:
      options.input === undefined
        ? "ignore"
        : typeof options.input === "string"
          ? new TextEncoder().encode(options.input)
          : options.input,
    stdout: "pipe",
    stderr: "pipe",
    env,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout === true) {
    throw new GitTimeoutError(cwd, args, Date.now() - started);
  }
  return {
    ok: result.exitCode === 0,
    out: options.raw === true ? result.stdout.toString() : result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

/** True when an empty success is also a real answer, not a glitch. */
export function emptyIsSuccess(args: readonly string[]): boolean {
  const [command, sub] = args;
  // A missing remote or branch is a normal empty answer; the caller reports it.
  return command === "ls-remote" || (command === "remote" && sub === "get-url");
}

/**
 * Runs git. The output is trimmed unless `raw` is set; output whose leading or
 * trailing spaces mean something (`status --porcelain`) must be read raw. A
 * command that must print (see `printsOnSuccess`) and exits 0 with nothing is
 * run again; if it never prints, the result is a failure that carries git's
 * stderr and says the output was empty, unless emptiness is a real answer.
 */
export function git(
  cwd: string,
  args: readonly string[],
  rawOrOptions: boolean | GitOptions = false,
): GitResult {
  const options: GitOptions =
    typeof rawOrOptions === "boolean" ? { raw: rawOrOptions } : rawOrOptions;
  let result = runOnce(cwd, args, options);
  if (!printsOnSuccess(args)) return result;
  for (
    let attempt = 1;
    attempt < GIT_EMPTY_ATTEMPTS && result.ok && result.out.trim().length === 0;
    attempt += 1
  ) {
    result = runOnce(cwd, args, options);
  }
  if (result.ok && result.out.trim().length === 0 && !emptyIsSuccess(args)) {
    const note = `git ${args[0] ?? ""} printed nothing (output was empty)`;
    return { ok: false, out: "", err: result.err.length > 0 ? `${result.err}; ${note}` : note };
  }
  return result;
}

/** The commit `ref` names, or undefined when it does not name one. */
export function commitOf(cwd: string, ref: string): string | undefined {
  return revisionOf(cwd, `${ref}^{commit}`);
}

/** The tree `ref` names, or undefined when it does not name one. */
export function treeOf(cwd: string, ref: string): string | undefined {
  return revisionOf(cwd, `${ref}^{tree}`);
}

/**
 * What `git rev-parse --verify --quiet` prints for `ref`, or undefined when the
 * ref does not name an object.
 */
export function revisionOf(cwd: string, ref: string): string | undefined {
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  return result.ok && result.out.length > 0 ? result.out : undefined;
}

/** The commit a work tree has checked out, or undefined when it has none. */
export function headOf(cwd: string): string | undefined {
  const result = git(cwd, ["rev-parse", "HEAD"]);
  return result.ok && result.out.length > 0 ? result.out : undefined;
}

/** True when `ancestor` is reachable from `descendant`. */
export function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): boolean {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

/** True when a local branch exists, or the branch on `remote` when one is named. */
export function branchExists(
  cwd: string,
  branch: string,
  remote?: string,
): boolean {
  const ref =
    remote === undefined
      ? `refs/heads/${branch}`
      : `refs/remotes/${remote}/${branch}`;
  return git(cwd, ["show-ref", "--verify", "--quiet", ref]).ok;
}

// The two settings that name a repository's base branch.
export interface BaseSettings {
  // Undefined when the repository has no remote.
  readonly remote?: string | undefined;
  readonly mainBranch: string;
}

// The name a task branch starts from and merges into: `<remote>/<main>`, or
// the local main branch when the repository has no remote.
export function baseName(settings: BaseSettings): string {
  return settings.remote === undefined
    ? settings.mainBranch
    : `${settings.remote}/${settings.mainBranch}`;
}

// The full ref of `baseName`.
export function baseRef(settings: BaseSettings): string {
  return settings.remote === undefined
    ? `refs/heads/${settings.mainBranch}`
    : `refs/remotes/${settings.remote}/${settings.mainBranch}`;
}

// Fetches the remote; a repository with no remote has nothing to fetch, which
// counts as a fetch that worked.
export function fetchRemote(
  cwd: string,
  settings: BaseSettings,
  args: readonly string[] = ["--prune"],
): GitResult {
  if (settings.remote === undefined) return { ok: true, out: "", err: "" };
  return git(cwd, ["fetch", ...args, settings.remote]);
}
