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

/** What was sent of one assistant message. */
export interface SentRecord {
  /** How many chunks of the message reached Telegram. */
  readonly chunks: number;
  /** The Telegram `message_id` of the last chunk sent. */
  readonly telegramId?: number | undefined;
  /** The whole message is sent. */
  readonly done: boolean;
  /** Sending gave up; the chat's history says so. */
  readonly failed?: true | undefined;
}

/** What the reply side remembers: since when it counts, and what it sent. */
export interface SentState {
  /** Epoch milliseconds the reply side first ran; older messages are not new. */
  readonly since: number;
  readonly sent: Readonly<Record<string, SentRecord>>;
}

/** The file the sent messages are recorded in. */
export function telegramSentPath(home: string): string {
  return join(telegramStateDirectory(home), "sent.json");
}

function recordOf(value: unknown): SentRecord | undefined {
  if (!isRecord(value) || typeof value.chunks !== "number" || typeof value.done !== "boolean") return undefined;
  return {
    chunks: value.chunks,
    done: value.done,
    ...(typeof value.telegramId === "number" ? { telegramId: value.telegramId } : {}),
    ...(value.failed === true ? { failed: true as const } : {}),
  };
}

/** The recorded sends; `undefined` when the file is missing or unusable. */
export function readSent(home: string): SentState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(telegramSentPath(home), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.since !== "number" || !isRecord(parsed.sent)) return undefined;
  const sent: Record<string, SentRecord> = {};
  for (const [key, value] of Object.entries(parsed.sent)) {
    const record = recordOf(value);
    if (record !== undefined) sent[key] = record;
  }
  return { since: parsed.since, sent };
}

/** Records the sends, replacing the file whole. */
export function writeSent(home: string, state: SentState): void {
  const path = telegramSentPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporary, path);
}

/** One thing a message of the pending side offers. */
export interface SentOption {
  /** The words on the button, and in "answered: X". */
  readonly label: string;
  /** `act` runs an action, `choice` answers one of the question's choices, `free` takes any text. */
  readonly how: "act" | "choice" | "free";
  /** The action's `<plugin>:<action>` for `act`. */
  readonly action?: string | undefined;
  /** The action needs a note, so it is answered by replying. */
  readonly note?: true | undefined;
}

/** One pending item as it was sent to one Telegram chat. */
export interface SentItem {
  readonly runId: string;
  readonly waitId?: string | undefined;
  /** The object the item is about, as `type:id`. */
  readonly object?: string | undefined;
  readonly chatId: number;
  readonly messageId: number;
  /** The text as sent; "answered: X" is added to it. */
  readonly text: string;
  readonly options: readonly SentOption[];
  /** When it was sent, epoch milliseconds. */
  readonly at: number;
  /** The words the item was answered with; set once the message was changed. */
  readonly answered?: string | undefined;
}

/** What the pending side remembers, by the item and Telegram chat it was sent to. */
export type PendingState = Readonly<Record<string, SentItem>>;

/** The file the sent pending items are recorded in. */
export function telegramPendingPath(home: string): string {
  return join(telegramStateDirectory(home), "pending.json");
}

function optionOf(value: unknown): SentOption | undefined {
  if (!isRecord(value) || typeof value.label !== "string") return undefined;
  if (value.how !== "act" && value.how !== "choice" && value.how !== "free") return undefined;
  return {
    label: value.label,
    how: value.how,
    ...(typeof value.action === "string" ? { action: value.action } : {}),
    ...(value.note === true ? { note: true as const } : {}),
  };
}

function itemOf(value: unknown): SentItem | undefined {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.chatId !== "number" ||
    typeof value.messageId !== "number" ||
    typeof value.text !== "string" ||
    typeof value.at !== "number" ||
    !Array.isArray(value.options)
  ) {
    return undefined;
  }
  const options = value.options.flatMap((entry: unknown) => {
    const option = optionOf(entry);
    return option === undefined ? [] : [option];
  });
  return {
    runId: value.runId,
    chatId: value.chatId,
    messageId: value.messageId,
    text: value.text,
    at: value.at,
    options,
    ...(typeof value.waitId === "string" ? { waitId: value.waitId } : {}),
    ...(typeof value.object === "string" ? { object: value.object } : {}),
    ...(typeof value.answered === "string" ? { answered: value.answered } : {}),
  };
}

/** The recorded pending sends; empty when the file is missing or unusable. */
export function readPending(home: string): PendingState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(telegramPendingPath(home), "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const items: Record<string, SentItem> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const item = itemOf(value);
    if (item !== undefined) items[key] = item;
  }
  return items;
}

/** Records the pending sends, replacing the file whole. */
export function writePending(home: string, state: PendingState): void {
  const path = telegramPendingPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporary, path);
}
