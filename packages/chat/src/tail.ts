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
 * Whether a window holds all that the unfinished state depends on: a line that
 * ends the text and thinking before it, and no output of a call whose start
 * and end are both outside the window (that call may still run).
 */
function enough(values: readonly unknown[]): boolean {
  const types = new Set(values.map(typeOf));
  const reset = types.has("message_end") || types.has("tool_execution_start") || types.has("tool_execution_end") ||
    (types.has("text_end") && types.has("thinking_end"));
  if (!reset) return false;
  const known = new Set<string>();
  for (const value of values) {
    const type = typeOf(value);
    const id = callOf(value);
    if (id !== undefined && (type === "tool_execution_start" || type === "tool_execution_end")) known.add(id);
  }
  return values.every((value) => {
    const id = callOf(value);
    return typeOf(value) !== "tool_output" || id === undefined || known.has(id);
  });
}

/**
 * Folds the end of a log file; undefined when there is no file. It reads the
 * last `limit` bytes and reads further back (doubling) only while the unfinished
 * text, thinking or a running call could begin before the window.
 */
export function foldLogTail(path: string, limit: number = TAIL_LOG_BYTES): TailRead | undefined {
  let size = limit;
  for (;;) {
    const window = readWindow(path, size);
    if (window === undefined) return undefined;
    if (window.whole || enough(window.values)) {
      return { state: foldLines(window.values, emptyFold), bytesRead: window.bytes };
    }
    size *= 2;
  }
}
