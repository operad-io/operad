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

/**
 * The task's durable record of whether this merge's prepare still has to run.
 * It is saved before the fast-forward, so a restart after the clone moved runs
 * the lines even when the clone already holds the commit.
 */
export interface PrepareMarker {
  /** True when the record says this merge moved the clone and prepare is not done. */
  readonly due: boolean;
  /** Saves whether prepare is due; false when the record could not be written. */
  readonly save: (due: boolean) => Promise<boolean>;
}

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

/** Runs prepare and records that it is no longer due, even when a line failed. */
async function prepareAndClear(
  repository: string,
  lines: readonly string[],
  run: CommandRunner,
  marker: PrepareMarker | undefined,
): Promise<MainCloneOutcome> {
  const outcome = await prepare(repository, lines, run);
  await marker?.save(false);
  return outcome;
}

/** The text a task's Changes shows, or undefined when there is nothing to say. */
export function mainCloneChange(outcome: MainCloneOutcome): string | undefined {
  if (!outcome.updated) return `main clone not updated: ${outcome.note ?? "unknown"}`;
  return outcome.note === undefined ? undefined : `main clone: ${outcome.note}`;
}

/**
 * Fast-forwards the main clone to `sha` when it is on `branch` and clean, then
 * runs the prepare lines there when the clone moved. A marker left by an
 * interrupted merge makes a replay run prepare even when the clone already
 * holds the commit.
 */
export async function updateMainClone(
  repository: string,
  branch: string,
  sha: string,
  lines: readonly string[],
  run: CommandRunner,
  marker?: PrepareMarker | undefined,
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
  const already = git(repository, ["merge-base", "--is-ancestor", sha, "HEAD"]).ok;
  if (already) {
    if (marker?.due !== true) return { updated: true };
    if (lines.length === 0) {
      await marker.save(false);
      return { updated: true };
    }
    return prepareAndClear(repository, lines, run, marker);
  }
  if (lines.length > 0 && marker !== undefined) {
    if (!(await marker.save(true))) {
      return { updated: false, note: "cannot record that prepare is due" };
    }
  }
  const merge = git(repository, ["merge", "--ff-only", sha]);
  if (!merge.ok) {
    if (lines.length > 0 && marker !== undefined) await marker.save(false);
    return {
      updated: false,
      note: `cannot fast-forward: ${lastLine(merge.err || merge.out) || "git merge failed"}`,
    };
  }
  return prepareAndClear(repository, lines, run, marker);
}
