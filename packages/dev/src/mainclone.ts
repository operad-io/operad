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
  readonly out: string;
}

/** Runs a command in a directory; tests replace it so no real install runs. */
export type CommandRunner = (
  cwd: string,
  cmd: readonly string[],
) => CommandResult;

export const runCommand: CommandRunner = (cwd, cmd) => {
  const result = Bun.spawnSync({
    cmd: [...cmd],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
};

/** What happened to the main clone. */
export interface MainCloneOutcome {
  readonly updated: boolean;
  /** Why the clone was not updated, or how the install ended. */
  readonly note?: string | undefined;
  readonly installed?: boolean | undefined;
}

function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

/** The text a task's Changes shows, or undefined when there is nothing to say. */
export function mainCloneChange(outcome: MainCloneOutcome): string | undefined {
  if (!outcome.updated) return `main clone not updated: ${outcome.note ?? "unknown"}`;
  return outcome.note === undefined ? undefined : `main clone: ${outcome.note}`;
}

/** Fast-forwards the main clone to `sha` when it is on `branch` and clean. */
export function updateMainClone(
  repository: string,
  branch: string,
  sha: string,
  run: CommandRunner = runCommand,
): MainCloneOutcome {
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
  const before = git(repository, ["rev-parse", "HEAD"]);
  if (!before.ok) return { updated: false, note: `cannot read HEAD: ${before.err}` };
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
  const changed = git(repository, [
    "diff",
    "--name-only",
    before.out,
    "HEAD",
    "--",
    "bun.lock",
  ]);
  if (!changed.ok || changed.out.length === 0) return { updated: true };
  const install = run(repository, ["bun", "install", "--frozen-lockfile"]);
  return install.ok
    ? { updated: true, installed: true, note: "bun install --frozen-lockfile done" }
    : {
        updated: true,
        installed: false,
        note: `bun install --frozen-lockfile failed: ${lastLine(install.out)}`,
      };
}
