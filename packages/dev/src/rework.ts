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
 * The review the next one follows, or undefined for a first review. Only a
 * review of an earlier attempt counts; one of the same attempt does not.
 */
export function previousReview(
  history: readonly ReviewHistoryEntry[] | undefined,
  sha: string,
  attempt: number,
): ReviewHistoryEntry | undefined {
  const earlier = (history ?? []).filter((entry) => entry.attempt < attempt);
  const newest = earlier[earlier.length - 1];
  if (newest === undefined || newest.sha === sha) return undefined;
  return newest;
}

/**
 * The changed lines of a `git diff -U0` text, by new path: the added lines, and
 * for a pure deletion the two lines on either side of the cut.
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
      if (count === 0) {
        if (start > 0) current.add(start);
        current.add(start + 1);
      }
    }
  }
  return map;
}

/** The lines both maps hold, per file. */
export function intersect(left: LineMap, right: LineMap): LineMap {
  const map = new Map<string, Set<number>>();
  for (const [path, lines] of left) {
    const other = right.get(path);
    if (other === undefined) continue;
    const both = new Set<number>();
    for (const line of lines) if (other.has(line)) both.add(line);
    if (both.size > 0) map.set(path, both);
  }
  return map;
}

/**
 * The patch of one file restricted to the hunks that hold a wanted line. The
 * header stays; a patch with no such hunk is empty.
 */
export function restrictPatch(
  patch: string,
  wanted: ReadonlySet<number> | undefined,
): string {
  if (wanted === undefined || wanted.size === 0) return "";
  const lines = patch.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@ "));
  if (first < 0) return "";
  const header = lines.slice(0, first);
  const kept: string[] = [];
  let index = first;
  while (index < lines.length) {
    let end = index + 1;
    while (end < lines.length && !(lines[end] ?? "").startsWith("@@ ")) end += 1;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(lines[index] ?? "");
    if (match !== null) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      let holds = false;
      for (let at = start; at < start + count; at += 1) {
        if (wanted.has(at)) {
          holds = true;
          break;
        }
      }
      if (holds) kept.push(...lines.slice(index, end));
    }
    index = end;
  }
  if (kept.length === 0) return "";
  const text = [...header, ...kept].join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
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
