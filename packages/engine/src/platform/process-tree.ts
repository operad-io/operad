/**
 * A process and everything it started, wherever it moved: a shell with job
 * control puts each job in a process group of its own, which a signal to the
 * shell's group never reaches.
 */

import type { ProcessRow } from "./step-reap.ts";

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
