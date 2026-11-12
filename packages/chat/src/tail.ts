/**
 * The part of an answer that is not finished: read from the log of the step
 * that runs the agent. The run is not in the serve process; the log file is the
 * way to it. Only the end of the file is read, so a long run does not make each
 * read slower.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { emptyFold, foldLines, type FoldState } from "@operad-io/harness-process";

/** The most bytes of a log one read takes, counted from its end. */
export const TAIL_LOG_BYTES = 256 * 1024;

/** Keeps a name usable as one path segment, as the step's logger does. */
function segment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length === 0 || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

/** Where a harness's agent step writes the log of one run. */
export function agentLogPath(storeRoot: string, harness: string, runId: string): string {
  return join(storeRoot, "logs", segment(harness), "runs", segment(runId), "agent.log");
}

/** What was read of a log: the fold of its end, and how many bytes that took. */
export interface TailRead {
  readonly state: FoldState;
  readonly bytesRead: number;
}

/**
 * Folds the last `limit` bytes of a log file; undefined when there is no file.
 * A line cut by the start of the window is dropped, and so is one still being
 * written at the end (it does not parse yet).
 */
export function foldLogTail(path: string, limit: number = TAIL_LOG_BYTES): TailRead | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buffer = Buffer.allocUnsafe(size - start);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (count === 0) break;
      read += count;
    }
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const values: unknown[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        // A line that is not complete, or not one of ours.
      }
    }
    return { state: foldLines(values, emptyFold), bytesRead: read };
  } finally {
    closeSync(fd);
  }
}
