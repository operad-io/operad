/**
 * The plugin's own state file, `<home>/telegram/state.json`. It holds how far
 * `getUpdates` has been read; dedupe never depends on it, only the next request
 * does, so a process killed before the file is written reads the update again
 * and the event key keeps it one.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "@operad-io/engine";

/** The directory the plugin keeps its own files in. */
export function telegramStateDirectory(home: string): string {
  return join(home, "telegram");
}

/** The file the next `getUpdates` offset is in. */
export function telegramStatePath(home: string): string {
  return join(telegramStateDirectory(home), "state.json");
}

/** The recorded offset; 0 when the file is missing or unusable. */
export function readOffset(home: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(telegramStatePath(home), "utf8"));
  } catch {
    return 0;
  }
  if (!isRecord(parsed)) return 0;
  const offset = parsed.offset;
  return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

/** Records the next offset and the time it was written. */
export function writeOffset(home: string, offset: number, at: number): void {
  const path = telegramStatePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ offset, at })}\n`, "utf8");
  renameSync(temporary, path);
}
