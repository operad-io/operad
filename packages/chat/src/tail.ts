/**
 * The part of an answer that is not finished: read from the log of the step
 * that runs the agent. The run is not in the serve process; the log file is the
 * way to it. The log is append-only, so it is folded once and then only what
 * was appended is read: the state is always exact (for claude, pi and radian
 * alike) and a read costs what was added since the last one.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { emptyFold, foldLines, type FoldState } from "@operad-io/harness-process";

/** How many bytes one read call takes from the file. */
export const TAIL_READ_CHUNK = 1024 * 1024;

/** How many logs keep their folded state; the least recently read is dropped first. */
export const TAIL_CACHE_LOGS = 32;

/** Keeps a name usable as one path segment, as the step's logger does. */
function segment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length === 0 || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

/** Where a harness's agent step writes the log of one run. */
export function agentLogPath(storeRoot: string, harness: string, runId: string): string {
  return join(storeRoot, "logs", segment(harness), "runs", segment(runId), "agent.log");
}

/** What was read of a log: the fold of all of it, and how many bytes this read took. */
export interface TailRead {
  readonly state: FoldState;
  readonly bytesRead: number;
}

interface Saved {
  readonly dev: number;
  readonly ino: number;
  /** The bytes of the log folded so far: up to and including the last complete line. */
  readonly offset: number;
  readonly state: FoldState;
}

/**
 * The folded state per log path. A Map keeps insertion order; a read moves its
 * entry to the end, so the first entry is the least recently read and goes when
 * there are more than `TAIL_CACHE_LOGS`. A log nobody asks about any more (its
 * run ended) is therefore dropped as others are read.
 */
const saved = new Map<string, Saved>();

/**
 * The fold of a whole log file, reading only what was appended since the last
 * call for the path; undefined when there is no file. A file that is shorter
 * than what was read, or is another file, is read again from its start. A line
 * still being written is left for the next call. Finished entries are not kept:
 * only the unfinished text, thinking and calls matter here.
 */
export function foldLogTail(path: string): TailRead | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    const before = saved.get(path);
    const keep = before !== undefined && before.dev === stat.dev && before.ino === stat.ino && before.offset <= stat.size;
    let offset = keep ? before.offset : 0;
    let state = keep ? before.state : emptyFold;
    let pending = Buffer.alloc(0);
    let bytesRead = 0;
    let position = offset;
    while (position < stat.size) {
      const chunk = Buffer.allocUnsafe(Math.min(TAIL_READ_CHUNK, stat.size - position));
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0) break;
      position += count;
      bytesRead += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      const end = pending.lastIndexOf(0x0a);
      if (end < 0) continue;
      const values: unknown[] = [];
      for (const line of pending.subarray(0, end).toString("utf8").split("\n")) {
        if (line.length === 0) continue;
        try {
          values.push(JSON.parse(line));
        } catch {
          // Not one of ours.
        }
      }
      state = { ...foldLines(values, state), entries: [] };
      offset += end + 1;
      pending = pending.subarray(end + 1);
    }
    saved.delete(path);
    saved.set(path, { dev: stat.dev, ino: stat.ino, offset, state });
    for (const old of saved.keys()) {
      if (saved.size <= TAIL_CACHE_LOGS) break;
      saved.delete(old);
    }
    return { state, bytesRead };
  } finally {
    closeSync(fd);
  }
}
