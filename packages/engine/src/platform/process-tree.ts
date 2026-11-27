/**
 * A process and everything it started, wherever it moved: a shell with job
 * control puts each job in a process group of its own, which a signal to the
 * shell's group never reaches.
 */

import { listEnvCarriers, type ProcessRow } from "./step-reap.ts";

/** The variable that names the pseudo terminal a process was started on. */
export const PTY_MARKER_ENV = "OPERAD_PTY";

/**
 * The rows of `root`, of everything below it, and of every member of a group
 * one of those leads (a member whose parent ended keeps the group). This
 * process is never part of a tree.
 */
export function processTree(rows: readonly ProcessRow[], root: number): readonly ProcessRow[] {
  const found = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (found.has(row.pid) || row.pid <= 1 || row.pid === process.pid) continue;
      if (found.has(row.ppid) || found.has(row.pgid)) {
        found.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => found.has(row.pid) && row.pid !== process.pid);
}

/**
 * The rows of what a pseudo terminal started and is still its own, wherever it
 * went: each process that carries its marker, what is below it and the rest of
 * its group. This finds the jobs a shell left when it exited, which no parent
 * and no terminal ties to it any more. A process that leads a session of its
 * own left the terminal to be a daemon: it and what is below it stay.
 */
export async function markedRows(
  rows: readonly ProcessRow[],
  marker: string,
): Promise<readonly ProcessRow[]> {
  const carriers = new Set(await listEnvCarriers(PTY_MARKER_ENV, marker));
  const marked = rows.filter((row) => carriers.has(row.pid));
  const groups = new Set(marked.map((row) => row.pgid).filter((pgid) => pgid > 1));
  const daemons = new Set(
    marked
      .filter((row) => row.sessionLeader === true)
      .flatMap((row) => processTree(rows, row.pid))
      .map((row) => row.pid),
  );
  const found = new Set<number>();
  for (const row of rows) {
    if (!carriers.has(row.pid) && !groups.has(row.pgid)) continue;
    for (const member of processTree(rows, row.pid)) found.add(member.pid);
  }
  return rows.filter(
    (row) => found.has(row.pid) && !daemons.has(row.pid) && row.pid !== process.pid,
  );
}

/** One row for each process of several lists. */
export function mergeRows(...lists: readonly (readonly ProcessRow[])[]): readonly ProcessRow[] {
  return [...new Map(lists.flat().map((row) => [row.pid, row])).values()];
}

/** Sends one signal to each process; one that already ended is passed over. */
export function signalRows(rows: readonly ProcessRow[], signal: NodeJS.Signals): void {
  for (const row of rows) {
    try {
      process.kill(row.pid, signal);
    } catch {
      // Gone since the table was read.
    }
  }
}
