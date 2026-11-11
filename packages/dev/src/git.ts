/**
 * The one way dev runs a git query. Under heavy load git sometimes exits 0 with
 * empty stdout and stderr (8 in 120000 `rev-parse` runs, with Bun and node), so
 * a query whose output is expected is run again, a bounded number of times,
 * before an empty answer is believed.
 */

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
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdin:
      options.input === undefined
        ? "ignore"
        : typeof options.input === "string"
          ? new TextEncoder().encode(options.input)
          : options.input,
    stdout: "pipe",
    stderr: "pipe",
    // Passed on so the child is found through the current PATH.
    env: options.env ?? { ...process.env },
  });
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
