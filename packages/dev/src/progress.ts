/**
 * What a work step leaves behind when it runs out of time: the words it says
 * to the worker, the note the worker writes, and how the next attempt reads
 * them. The git side lives in `steps.ts` next to the other worktree helpers.
 */

/** The file in the worktree root the worker writes its progress note to. */
export const PROGRESS_FILE = ".operad-progress.md";

/** The message of the commit dev makes of whatever a timed-out step left. */
export const WIP_MESSAGE = "work in progress: the work step ran out of time";

/** The message of the commit that takes the note out of the branch again. */
export const NOTE_REMOVED_MESSAGE = "remove the progress note from the branch";

/**
 * The inbox a harness step gets in `params.inbox`: it keeps what is sent until
 * a harness listens, then passes everything on in order.
 */
export interface Inbox {
  listen(handler: (text: string) => void): () => void;
  /**
   * A harness calls it when its run begins, with how long the run may last in
   * milliseconds. The wrap-up is timed from then, not from the step's start.
   */
  begin(limitMs: number): void;
}

export interface Outbox {
  readonly inbox: Inbox;
  send(text: string): void;
}

export function createOutbox(onBegin: (limitMs: number) => void): Outbox {
  let handler: ((text: string) => void) | undefined;
  const kept: string[] = [];
  return {
    inbox: {
      begin: onBegin,
      listen(next) {
        handler = next;
        for (const text of kept.splice(0)) next(text);
        return () => {
          if (handler === next) handler = undefined;
        };
      },
    },
    send(text) {
      if (handler === undefined) kept.push(text);
      else handler(text);
    },
  };
}

/** What the worker is told when the step is close to its time limit. */
export function wrapUpMessage(): string {
  return [
    "This work is close to its time limit. Stop starting new things.",
    "Commit what you have now, so nothing is left uncommitted, and run no more than you must.",
    `Then write a progress note to ${PROGRESS_FILE} in the worktree root: what is done, what is left, and what you learned. Do not commit that file.`,
    "End your turn when the note is written.",
  ].join("\n");
}

/** One commit a worker made. */
export interface ProgressCommit {
  readonly sha: string;
  readonly subject: string;
}

/** What an attempt left for the next one. */
export interface Progress {
  readonly note: string | null;
  readonly commits: readonly ProgressCommit[];
  readonly timedOut: boolean;
}

/** Reads a stored progress record; anything that is not one is undefined. */
export function progressOf(value: unknown): Progress | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const note: unknown = Reflect.get(value, "note");
  const commits: unknown = Reflect.get(value, "commits");
  const timedOut: unknown = Reflect.get(value, "timedOut");
  if (note !== null && typeof note !== "string") return undefined;
  if (!Array.isArray(commits)) return undefined;
  const list: ProgressCommit[] = [];
  for (const item of commits as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const sha: unknown = Reflect.get(item, "sha");
    const subject: unknown = Reflect.get(item, "subject");
    if (typeof sha !== "string" || typeof subject !== "string") return undefined;
    list.push({ sha, subject });
  }
  return { note, commits: list, timedOut: timedOut === true };
}

/** The text at the top of the next attempt's prompt. */
export function previousAttemptText(progress: Progress): string {
  const lines = [
    progress.timedOut
      ? "The attempt before this one ran out of time. Continue from where it got to; do not start over."
      : "The attempt before this one left a progress note. Continue from where it got to; do not start over.",
  ];
  lines.push(
    progress.commits.length === 0
      ? "It made no commits."
      : ["Its commits, newest first, are already in this worktree:", ...progress.commits.map((commit) => `- ${commit.sha} ${commit.subject}`)].join("\n"),
  );
  if (progress.note !== null) {
    lines.push(["Its progress note:", progress.note.trim()].join("\n"));
  }
  return lines.join("\n\n");
}
