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

/** Reads the last `limit` bytes of a file as parsed lines, and whether the window starts at the file's start. */
function readWindow(path: string, limit: number): { readonly values: unknown[]; readonly whole: boolean; readonly bytes: number } | undefined {
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
    // A line cut by the start of the window is dropped; so is one still being written.
    if (start > 0) lines.shift();
    const values: unknown[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        // Not complete, or not one of ours.
      }
    }
    return { values, whole: start === 0, bytes: read };
  } finally {
    closeSync(fd);
  }
}

function typeOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
    ? (value as { type: string }).type
    : undefined;
}

function callOf(value: unknown): string | undefined {
  const id = typeof value === "object" && value !== null ? (value as { toolCallId?: unknown }).toolCallId : undefined;
  return typeof id === "string" ? id : undefined;
}

/**
 * Where the fold of a window can start so that it misses nothing that is still
 * unfinished: the index after a quiet point, or -1 when the window has none.
 *
 * A quiet point is a `message_end` line. The harnesses write the next message's
 * end only after every call of the batch before it has ended, so no call is
 * open there. A call's start line is not always before its message's end line,
 * so the point is trusted only when the window shows it: every call the lines
 * before it mention began and ended before it, and every call the lines after it
 * mention began after it. A running call whose start is before the window then
 * cannot hide: its start would be before an earlier quiet point, and such a
 * point is not accepted unless the call also ended before it. A log with no
 * text or thinking at all (radian) has no message ends; there a finished call
 * is the quiet point.
 */
function quietPoint(values: readonly unknown[]): number {
  const words = values.some((value) => {
    const type = typeOf(value);
    return type === "text_delta" || type === "thinking_delta" || type === "text_end" || type === "thinking_end" || type === "message_end";
  });
  for (let at = values.length - 1; at >= 0; at -= 1) {
    const type = typeOf(values[at]);
    if (type !== "message_end" && !(!words && type === "tool_execution_end")) continue;
    const started = new Set<string>();
    const ended = new Set<string>();
    const seen = new Set<string>();
    let good = true;
    for (let index = 0; index < values.length && good; index += 1) {
      const value = values[index];
      const id = callOf(value);
      const kind = typeOf(value);
      if (id === undefined || index === at) continue;
      if (index < at) {
        seen.add(id);
        if (kind === "tool_execution_start") started.add(id);
        if (kind === "tool_execution_end") ended.add(id);
      } else if (kind === "tool_execution_start") {
        // A call that begins after the point; its id must not be one from before.
        if (seen.has(id)) good = false;
        started.add(`after:${id}`);
      } else if (!started.has(`after:${id}`)) {
        good = false;
      }
    }
    if (!good) continue;
    for (const id of seen) if (!started.has(id) || !ended.has(id)) good = false;
    if (good) return at + 1;
  }
  return -1;
}

/**
 * Folds the end of a log file; undefined when there is no file. It reads the
 * last `limit` bytes and reads further back (doubling) until the window holds a
 * quiet point (see `quietPoint`), from which the fold cannot miss anything.
 */
export function foldLogTail(path: string, limit: number = TAIL_LOG_BYTES): TailRead | undefined {
  let size = limit;
  for (;;) {
    const window = readWindow(path, size);
    if (window === undefined) return undefined;
    const from = quietPoint(window.values);
    if (window.whole || from >= 0) {
      return { state: foldLines(window.values.slice(Math.max(0, from)), emptyFold), bytesRead: window.bytes };
    }
    size *= 2;
  }
}
