/**
 * The TUI's own state file, `<home>/tui-state.json`: the palette entries used
 * last. It is the TUI's, not the server's; a missing or broken file is empty.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECENT_ENTRIES } from "./actions.ts";

export function stateFile(home: string): string {
  return join(home, "tui-state.json");
}

/** The remembered palette entries, the latest first. */
export function loadRecent(home: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const list: unknown = (parsed as { recent?: unknown }).recent;
    if (!Array.isArray(list)) return [];
    return list
      .filter((item): item is string => typeof item === "string")
      .slice(0, RECENT_ENTRIES);
  } catch {
    return [];
  }
}

/** Writes the list; a failure is ignored, since losing it costs only a convenience. */
export function saveRecent(home: string, recent: readonly string[]): void {
  try {
    mkdirSync(home, { recursive: true });
    const file = stateFile(home);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ recent }, null, 2)}\n`);
    renameSync(temporary, file);
  } catch {
    // Nothing to do: the next change writes again.
  }
}
