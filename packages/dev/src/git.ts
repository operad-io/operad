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
      return args.length === 1;
    default:
      return false;
  }
}

function runOnce(cwd: string, args: readonly string[], raw: boolean): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
    // Passed on so the child is found through the current PATH.
    env: { ...process.env },
  });
  return {
    ok: result.exitCode === 0,
    out: raw ? result.stdout.toString() : result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

/**
 * Runs git. The output is trimmed unless `raw` is set; output whose leading or
 * trailing spaces mean something (`status --porcelain`) must be read raw. A
 * command that must print (see `printsOnSuccess`) and exits 0 with nothing is
 * run again; if it never prints, the result is a failure that carries git's
 * stderr and says the output was empty.
 */
export function git(cwd: string, args: readonly string[], raw = false): GitResult {
  let result = runOnce(cwd, args, raw);
  if (!printsOnSuccess(args)) return result;
  for (
    let attempt = 1;
    attempt < GIT_EMPTY_ATTEMPTS && result.ok && result.out.trim().length === 0;
    attempt += 1
  ) {
    result = runOnce(cwd, args, raw);
  }
  if (result.ok && result.out.trim().length === 0) {
    const note = `git ${args[0] ?? ""} printed nothing (output was empty)`;
    return { ok: false, out: "", err: result.err.length > 0 ? `${result.err}; ${note}` : note };
  }
  return result;
}
