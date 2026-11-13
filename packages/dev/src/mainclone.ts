/**
 * After a merge landed on the remote main, bring the repository's main clone up
 * to it when that is safe. The clone is what serve and every run execute, so a
 * merge that leaves it behind leaves the old code running. Only a fast-forward
 * through git is ever used: no reset, rebase or stash.
 */

import { git } from "./steps.ts";

/** What a command runner reports. */
export interface CommandResult {
  readonly ok: boolean;
  /** The last line of the output. */
  readonly out: string;
}

/**
 * Runs one prepare line in a directory. The merge step passes one that runs it
 * as a checkout's prepare line runs; tests replace it.
 */
export type CommandRunner = (
  cwd: string,
  line: string,
) => Promise<CommandResult>;

/** What happened to the main clone. */
export interface MainCloneOutcome {
  readonly updated: boolean;
  /** Why the clone was not updated, or how the prepare lines ended. */
  readonly note?: string | undefined;
  /** True when the prepare lines ran and passed. */
  readonly prepared?: boolean | undefined;
}

function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

/** Runs the lines in order in the clone; the first failure stops them. */
async function prepare(
  repository: string,
  lines: readonly string[],
  run: CommandRunner,
): Promise<MainCloneOutcome> {
  if (lines.length === 0) return { updated: true };
  for (const line of lines) {
    const done = await run(repository, line);
    if (!done.ok) {
      return {
        updated: true,
        prepared: false,
        note: `prepare failed: ${line}: ${lastLine(done.out)}`,
      };
    }
  }
  return { updated: true, prepared: true, note: "prepare done" };
}

/** The text a task's Changes shows, or undefined when there is nothing to say. */
export function mainCloneChange(outcome: MainCloneOutcome): string | undefined {
  if (!outcome.updated) return `main clone not updated: ${outcome.note ?? "unknown"}`;
  return outcome.note === undefined ? undefined : `main clone: ${outcome.note}`;
}

/**
 * Fast-forwards the main clone to `sha` when it is on `branch` and clean, then
 * runs the prepare lines there when the clone moved.
 */
export async function updateMainClone(
  repository: string,
  branch: string,
  sha: string,
  lines: readonly string[],
  run: CommandRunner,
): Promise<MainCloneOutcome> {
  const current = git(repository, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!current.ok || current.out !== branch) {
    return {
      updated: false,
      note: `the main clone is on ${current.ok ? `"${current.out}"` : "no branch"}, not "${branch}"`,
    };
  }
  const status = git(repository, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!status.ok) {
    return { updated: false, note: `cannot read its status: ${status.err}` };
  }
  if (status.out.length > 0) {
    return { updated: false, note: "uncommitted changes" };
  }
  if (git(repository, ["merge-base", "--is-ancestor", sha, "HEAD"]).ok) {
    return { updated: true };
  }
  const merge = git(repository, ["merge", "--ff-only", sha]);
  if (!merge.ok) {
    return {
      updated: false,
      note: `cannot fast-forward: ${lastLine(merge.err || merge.out) || "git merge failed"}`,
    };
  }
  return prepare(repository, lines, run);
}
