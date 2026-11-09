/**
 * Rework rounds of a review: what the previous review found, which lines the
 * increment holds, and which findings dev moves out of the failing set. All of
 * it is decided from git and from recorded findings, never by the model.
 */

/** A blocking finding of an earlier review, as the next review is told. */
export interface PreviousFinding {
  readonly severity: string;
  readonly file: string;
  readonly line: number | null;
  readonly summary: string;
}

/** What a review recorded for the task, kept for the review after it. */
export interface ReviewHistoryEntry {
  /** The merge base of main and the commit, when the review ran. */
  readonly base?: string | undefined;
  readonly attempt: number;
  readonly round: number;
  readonly sha: string;
  readonly blocking: readonly PreviousFinding[];
}

/** Lines of the new side of a diff, by file. */
export type LineMap = ReadonlyMap<string, ReadonlySet<number>>;

/** How near a finding must be to a changed line to stay blocking. */
export const CHANGE_WINDOW = 3;
/** How near a finding must be to a previous blocking finding to stay blocking. */
export const PREVIOUS_WINDOW = 10;

/**
 * The review the next one follows: the newest review report of the task, in
 * any attempt, for a commit other than `sha`. A review of the same commit is
 * skipped, so a reverify of an unchanged head follows the one before it.
 */
export function previousReview(
  history: readonly ReviewHistoryEntry[] | undefined,
  sha: string,
): ReviewHistoryEntry | undefined {
  const other = (history ?? []).filter((entry) => entry.sha !== sha);
  return other[other.length - 1];
}

/**
 * The lines a `-U0` diff text changed, by new path: the lines it added and,
 * for a pure deletion, the two lines either side of the cut.
 */
export function addedLinesOf(diff: string): LineMap {
  const map = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).replace(/\t.*$/, "");
      if (raw === "/dev/null") {
        current = undefined;
        continue;
      }
      const path = raw.startsWith("b/") ? raw.slice(2) : raw;
      current = map.get(path) ?? new Set<number>();
      map.set(path, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk !== null && current !== undefined) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let at = start; at < start + count; at += 1) current.add(at);
      // A pure deletion changed the place between two lines: both count.
      if (count === 0) {
        if (start > 0) current.add(start);
        current.add(start + 1);
      }
    }
  }
  return map;
}

/** The patch of each file in a `git diff` text, by new path. */
export function filePatches(diff: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const blocks = diff.split(/^(?=diff --git )/m);
  for (const block of blocks) {
    if (!block.startsWith("diff --git ")) continue;
    let path: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("@@ ")) break;
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
        const raw = line.slice(4).replace(/\t.*$/, "");
        path = raw.startsWith("b/") ? raw.slice(2) : raw;
      } else if (line.startsWith("--- a/") && path === undefined) {
        path = line.slice(6).replace(/\t.*$/, "");
      }
    }
    if (path !== undefined) map.set(path, block);
  }
  return map;
}

interface SplitPatch {
  readonly header: string;
  readonly hunks: readonly string[];
}

function splitPatch(patch: string): SplitPatch {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const first = lines.findIndex((line) => line.startsWith("@@ "));
  if (first < 0) return { header: "", hunks: [] };
  const hunks: string[] = [];
  let start = first;
  for (let at = first + 1; at <= lines.length; at += 1) {
    if (at === lines.length || (lines[at] ?? "").startsWith("@@ ")) {
      hunks.push(`${lines.slice(start, at).join("\n")}\n`);
      start = at;
    }
  }
  return { header: `${lines.slice(0, first).join("\n")}\n`, hunks };
}

/** The changed lines (`+` and `-`) of a hunk, without line numbers or context. */
function changedOf(hunk: string): string[] {
  return hunk
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("+") || line.startsWith("-"));
}

/** A hunk's identity: its changed lines, in order. */
function keyOf(hunk: string): string {
  return changedOf(hunk).join("\n");
}

/** The hunks with no hunk of the same changed lines on the other side. */
function unmatched(
  hunks: readonly string[],
  other: readonly string[],
): readonly string[] {
  const left = new Map<string, number>();
  for (const hunk of other) {
    const key = keyOf(hunk);
    left.set(key, (left.get(key) ?? 0) + 1);
  }
  return hunks.filter((hunk) => {
    const key = keyOf(hunk);
    const have = left.get(key) ?? 0;
    if (have > 0) {
      left.set(key, have - 1);
      return false;
    }
    return true;
  });
}

/** What changed in the task's own diff between two reviews. */
export interface Increment {
  /** Hunks of the current own diff with a changed line the previous one lacks. */
  readonly added: string;
  /** Hunks of the previous own diff with a changed line the current one lacks. */
  readonly removed: string;
}

/**
 * The increment, as `git range-diff` pairs commits: both sides are the task's
 * own diff (merge base to head), so a line that only came with a merge of main
 * is on neither side. A hunk counts as new when no hunk of the previous diff of the same
 * file has exactly its `-`/`+` lines (line numbers and context are ignored); a hunk of
 * the previous diff that is gone is reported as removed with its old content.
 */
export function incrementOf(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): Increment {
  let added = "";
  let removed = "";
  for (const [path, patch] of current) {
    const now = splitPatch(patch);
    const before = splitPatch(previous.get(path) ?? "");
    const fresh = unmatched(now.hunks, before.hunks);
    if (fresh.length > 0) added += now.header + fresh.join("");
  }
  for (const [path, patch] of previous) {
    const before = splitPatch(patch);
    const now = splitPatch(current.get(path) ?? "");
    const gone = unmatched(before.hunks, now.hunks);
    if (gone.length > 0) removed += before.header + gone.join("");
  }
  return { added, removed };
}

/** A finding as dev judges it: only the parts that decide its place. */
export interface Placed {
  readonly severity: string;
  readonly file: string | undefined;
  readonly line: number | undefined;
}

function near(lines: ReadonlySet<number> | undefined, line: number, window: number): boolean {
  if (lines === undefined) return false;
  for (const changed of lines) {
    if (Math.abs(changed - line) <= window) return true;
  }
  return false;
}

/**
 * True when the finding is moved out of the failing set. It stays when it is
 * within 3 lines of a line the task's own change added in that file, within 10
 * lines of a previous blocking finding in that file, critical, or without a
 * file or a line.
 */
export function movesAsPreExisting(
  finding: Placed,
  own: LineMap,
  previous: readonly PreviousFinding[],
  normalize: (path: string) => string,
): boolean {
  if (finding.severity === "critical") return false;
  if (
    finding.file === undefined ||
    finding.file.length === 0 ||
    finding.line === undefined ||
    !Number.isFinite(finding.line)
  ) {
    return false;
  }
  const file = normalize(finding.file);
  if (near(own.get(file), finding.line, CHANGE_WINDOW)) return false;
  for (const old of previous) {
    if (
      old.line !== null &&
      normalize(old.file) === file &&
      Math.abs(old.line - finding.line) <= PREVIOUS_WINDOW
    ) {
      return false;
    }
  }
  return true;
}

/** Which review is being decided: the round fixes which pre-existing rule applies. */
export type ReviewKind = "first" | "reverify" | "rework";

/**
 * Whether a finding moves as pre-existing in a review of this kind.
 * A first review keeps only the per-file rule: a finding in a file the task's
 * change does not touch does not block (critical, and a finding without file
 * or line, never move). A reverify of the same commit moves nothing. A rework
 * round applies the line rules of `movesAsPreExisting`.
 */
export function movesIn(
  kind: ReviewKind,
  finding: Placed,
  own: LineMap,
  previous: readonly PreviousFinding[],
  normalize: (path: string) => string,
): boolean {
  if (kind === "reverify") return false;
  if (kind === "rework") return movesAsPreExisting(finding, own, previous, normalize);
  if (finding.severity === "critical") return false;
  if (
    finding.file === undefined ||
    finding.file.length === 0 ||
    finding.line === undefined ||
    !Number.isFinite(finding.line)
  ) {
    return false;
  }
  return !own.has(normalize(finding.file));
}

/** How many previous findings have no blocking finding of this review near them. */
export function fixedCount(
  previous: readonly PreviousFinding[],
  blocking: readonly Placed[],
  normalize: (path: string) => string,
): number {
  return previous.filter(
    (old) =>
      !blocking.some(
        (now) =>
          now.file !== undefined &&
          now.line !== undefined &&
          old.line !== null &&
          normalize(now.file) === normalize(old.file) &&
          Math.abs(now.line - old.line) <= PREVIOUS_WINDOW,
      ),
  ).length;
}

/** `[level] file:line summary` for one previous finding. */
export function previousLine(finding: PreviousFinding): string {
  const place =
    finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return `- [${finding.severity}] ${place} ${finding.summary}`;
}

/** Which block of reviewer settings a value came from. */
export type ReviewSettingSource =
  | "first"
  | "firstArgs"
  | "fallback"
  | "default";

/** The settings one review round ran with, and where each came from. */
export interface ReviewSettingsUsed {
  /** `first` for the task's first review; `rework` for every later one. */
  readonly round: "first" | "rework";
  readonly use: string;
  readonly args: readonly string[];
  readonly timeoutSecs: number;
  readonly stallSecs?: number;
  readonly sources: {
    readonly use: ReviewSettingSource;
    readonly args: ReviewSettingSource;
    readonly timeoutSecs: ReviewSettingSource;
    readonly stallSecs: ReviewSettingSource;
  };
}

/** The reviewer values the round's settings are chosen from. */
export interface ReviewerValues {
  readonly use: string;
  readonly args: readonly string[];
  readonly firstArgs?: readonly string[] | undefined;
  readonly first?:
    | {
        readonly use?: string | undefined;
        readonly args?: readonly string[] | undefined;
        readonly timeoutSecs?: number | undefined;
        readonly stallSecs?: number | undefined;
      }
    | undefined;
  readonly timeoutSecs: number;
  readonly stallSecs?: number | undefined;
}

/**
 * The settings of a review round. Only a first review reads the `first`
 * block, value by value; a rework round and a review of the same commit read
 * the default values. `firstArgs` (an older setting) still gives a first
 * review of an attempt its arguments when `first.args` is not set.
 */
export function reviewSettingsOf(
  kind: ReviewKind,
  reviewer: ReviewerValues,
  firstOfAttempt: boolean,
): ReviewSettingsUsed {
  const first = kind === "first" ? reviewer.first : undefined;
  // `firstArgs` is older than rounds: it belongs to the first review of every
  // attempt, whatever the round's kind.
  const legacy = firstOfAttempt ? reviewer.firstArgs : undefined;
  const args = first?.args ?? legacy;
  const stall = first?.stallSecs ?? reviewer.stallSecs;
  return {
    round: kind === "first" ? "first" : "rework",
    use: first?.use ?? reviewer.use,
    args: args ?? reviewer.args,
    timeoutSecs: first?.timeoutSecs ?? reviewer.timeoutSecs,
    ...(stall === undefined ? {} : { stallSecs: stall }),
    sources: {
      use: first?.use === undefined ? "default" : "first",
      args:
        first?.args !== undefined
          ? "first"
          : legacy !== undefined
            ? "firstArgs"
            : "default",
      timeoutSecs: first?.timeoutSecs === undefined ? "default" : "first",
      stallSecs: first?.stallSecs === undefined ? "default" : "first",
    },
  };
}
