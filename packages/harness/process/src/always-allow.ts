/**
 * The access profile's user layer: the calls a person answered `allow_always`
 * for, in `$OPERAD_HOME/access-user.json` (ADR 0025 D3, D4 and D7; the rule
 * for a background run is still in `docs/backlog/operad-sandbox.md`). A missing
 * file is an empty list. A file that cannot be read is
 * reported by the step that reads it and treated as empty. Writes take the
 * platform file lock and replace the file atomically.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@operad-io/engine";
import { withLockFile } from "@operad-io/engine/platform";

/** The file name of the user layer under the operad home. */
export const ACCESS_USER_FILE = "access-user.json";

/** One call a person allowed always: its kind, exact value and working directory. */
export interface AlwaysAllowEntry {
  readonly kind: "command" | "path";
  /** The exact command text, or the path as the call wrote it. */
  readonly value: string;
  /** The working directory the person allowed it in. */
  readonly cwd: string;
  /** The tool a path entry names; absent for a command entry. */
  readonly tool?: string;
}

/** What one asked call carries into an `alwaysAllow` entry. */
export interface AskedCall {
  readonly kind: "command" | "path";
  readonly value: string;
  readonly tool?: string;
}

/** The file of the user layer in an operad home. */
export function accessUserPath(home: string): string {
  return join(home, ACCESS_USER_FILE);
}

/** The entry an answered call writes; its working directory is the step's `cwd`. */
export function alwaysAllowEntry(call: AskedCall, cwd: string): AlwaysAllowEntry {
  return {
    kind: call.kind,
    value: call.value,
    cwd,
    ...(call.kind === "path" && call.tool !== undefined ? { tool: call.tool } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function entryOf(value: unknown): AlwaysAllowEntry | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  const text = value["value"];
  const cwd = value["cwd"];
  const tool = value["tool"];
  if ((kind !== "command" && kind !== "path") || typeof text !== "string" || text.length === 0) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  if (kind === "path") {
    if (typeof tool !== "string" || tool.length === 0) return undefined;
    return { kind, value: text, cwd, tool };
  }
  if (tool !== undefined) return undefined;
  return { kind, value: text, cwd };
}

function entriesOf(value: unknown): AlwaysAllowEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(entryOf).filter((entry): entry is AlwaysAllowEntry => entry !== undefined);
}

function sameEntry(left: AlwaysAllowEntry, right: AlwaysAllowEntry): boolean {
  return left.kind === right.kind && left.value === right.value && left.cwd === right.cwd && left.tool === right.tool;
}

/** The user layer's entries, and a readable problem when the file had to be treated as empty. */
export interface AlwaysAllowRead {
  readonly entries: readonly AlwaysAllowEntry[];
  readonly problem?: string;
}

function invalid(path: string, detail: string): AlwaysAllowRead {
  return { entries: [], problem: `the user access file "${path}" ${detail}; it is treated as empty` };
}

/** Reads the user layer; a missing file is an empty list and an invalid one is empty with a problem. */
export async function readAlwaysAllow(home: string): Promise<AlwaysAllowRead> {
  const path = accessUserPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { entries: [] };
    return invalid(path, `cannot be read: ${messageOf(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return invalid(path, `is not valid JSON: ${messageOf(error)}`);
  }
  if (!Array.isArray(raw)) return invalid(path, "must be a JSON array of always-allowed entries");
  const entries: AlwaysAllowEntry[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = entryOf(raw[index]);
    if (entry === undefined) return invalid(path, `entry ${index} is not a command or path entry with a value and a working directory`);
    entries.push(entry);
  }
  return { entries };
}

/** Appends one entry, under the file lock and with an atomic replace. */
export async function appendAlwaysAllow(home: string, entry: AlwaysAllowEntry): Promise<void> {
  const path = accessUserPath(home);
  await withLockFile(`${path}.lock`, async () => {
    const found = await readAlwaysAllow(home);
    const entries = [...found.entries.filter((existing) => !sameEntry(existing, entry)), entry];
    await mkdir(home, { recursive: true });
    const temporary = join(home, `.${ACCESS_USER_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // The temporary file was never made, or is already gone.
      }
      throw error;
    }
  }, { label: "access user layer" });
}

/**
 * A late `allow_always` carries the call in the one-time grant the kernel hands
 * back, since `askAnswer` itself names only the prompt and the choice.
 */
export function alwaysAllowFromGrant(access: unknown, cwd: string): AlwaysAllowEntry | undefined {
  if (!isRecord(access) || !Array.isArray(access["grants"])) return undefined;
  const grant = access["grants"].find(isRecord);
  if (grant === undefined) return undefined;
  const kind = grant["kind"];
  const value = grant["value"];
  const tool = grant["tool"];
  if ((kind !== "command" && kind !== "path") || typeof value !== "string" || value.length === 0) return undefined;
  if (kind === "path" && (typeof tool !== "string" || tool.length === 0)) return undefined;
  return alwaysAllowEntry(
    {
      kind,
      value,
      ...(typeof tool === "string" ? { tool } : {}),
    },
    cwd,
  );
}

/**
 * The profile a step passes on: its own entries plus the user layer, or no
 * entries at all in a run no person's message started (`docs/backlog/operad-sandbox.md`,
 * not in an ADR yet).
 */
export function accessWithAlwaysAllow(
  access: unknown,
  entries: readonly AlwaysAllowEntry[],
  enabled: boolean,
): Record<string, unknown> | undefined {
  const base = isRecord(access) ? access : undefined;
  if (!enabled) {
    if (base === undefined || base["alwaysAllow"] === undefined) return base;
    return { ...base, alwaysAllow: [] };
  }
  const combined = [...entriesOf(base?.["alwaysAllow"]), ...entries];
  if (combined.length === 0) return base;
  return { ...(base ?? {}), alwaysAllow: combined };
}

/** The sources `chat:send` uses for a message a person wrote in a chat. */
const MESSAGE_SOURCES = new Set(["ios", "telegram", "cli", "tui", "other"]);

/**
 * Whether a run may see `allow_always`: no trigger is a person's command, and
 * a message event from one of the chat's own client sources is a person's
 * message in that conversation. Every other event (a schedule, a webhook, an
 * incoming message from another source, a run's own event) is a background run
 * (`docs/backlog/operad-sandbox.md`, not in an ADR yet).
 */
export function personStarted(trigger: unknown): boolean {
  if (trigger === undefined || trigger === null) return true;
  return (
    isRecord(trigger) &&
    trigger["type"] === "message" &&
    typeof trigger["source"] === "string" &&
    MESSAGE_SOURCES.has(trigger["source"])
  );
}
