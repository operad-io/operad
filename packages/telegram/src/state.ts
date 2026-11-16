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
  /** The raw choice an answer sends; `label` when unset. */
  readonly choice?: string | undefined;
  /** The action's `<plugin>:<action>` for `act`. */
  readonly action?: string | undefined;
  /** The answer needs a note, or may carry one, so a reply to the message is a note. */
  readonly note?: "required" | "optional" | undefined;
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
  const note = value.note === true || value.note === "required"
    ? "required"
    : value.note === "optional"
      ? "optional"
      : undefined;
  return {
    label: value.label,
    how: value.how,
    ...(typeof value.choice === "string" ? { choice: value.choice } : {}),
    ...(typeof value.action === "string" ? { action: value.action } : {}),
    ...(note === undefined ? {} : { note }),
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

/** One command sent without its one choice, as it waits for a tap. */
export interface SentCommand {
  /** The operad chat the command runs on. */
  readonly chatId: string;
  /** The Telegram chat the keyboard is in. */
  readonly target: number;
  readonly messageId: number;
  /** The text as sent; "chosen: X" is added to it. */
  readonly text: string;
  /** The command's name, without the slash. */
  readonly name: string;
  /** The choices, in order, as the action's schema lists them. */
  readonly choices: readonly string[];
  /** The page of choices the keyboard shows now. */
  readonly page: number;
  /** The choice the command ran with; set once the message was changed. */
  readonly chosen?: string | undefined;
}

/** What the command side remembers, by the Telegram chat and message of each keyboard. */
export type CommandState = Readonly<Record<string, SentCommand>>;

/** The file the choice keyboards are recorded in. */
export function telegramCommandsPath(home: string): string {
  return join(telegramStateDirectory(home), "commands.json");
}

function commandOf(value: unknown): SentCommand | undefined {
  if (
    !isRecord(value) ||
    typeof value.chatId !== "string" ||
    typeof value.target !== "number" ||
    typeof value.messageId !== "number" ||
    typeof value.text !== "string" ||
    typeof value.name !== "string" ||
    typeof value.page !== "number" ||
    !Array.isArray(value.choices)
  ) {
    return undefined;
  }
  const choices = value.choices.filter((choice): choice is string => typeof choice === "string");
  return {
    chatId: value.chatId,
    target: value.target,
    messageId: value.messageId,
    text: value.text,
    name: value.name,
    choices,
    page: Number.isInteger(value.page) && value.page >= 0 ? value.page : 0,
    ...(typeof value.chosen === "string" ? { chosen: value.chosen } : {}),
  };
}

/** How many choice keyboards the state file keeps; older answered ones are dropped. */
export const COMMAND_STATE_MAX = 100;

/** A bounded command state: unanswered keyboards first, then the newest answered ones. */
export function pruneCommands(
  state: CommandState,
  keep = COMMAND_STATE_MAX,
): CommandState {
  const entries = Object.entries(state);
  if (entries.length <= keep) return state;
  const open = entries.filter(([, command]) => command.chosen === undefined).slice(-keep);
  const chosen = entries.filter(([, command]) => command.chosen !== undefined);
  const room = Math.max(0, keep - open.length);
  const kept = new Set([
    ...open.map(([key]) => key),
    ...chosen.slice(-room).map(([key]) => key),
  ]);
  const bounded: Record<string, SentCommand> = {};
  for (const [key, command] of entries) {
    if (kept.has(key)) bounded[key] = command;
  }
  return bounded;
}

/** The recorded choice keyboards; empty when the file is missing or unusable. */
export function readCommands(home: string): CommandState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(telegramCommandsPath(home), "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const commands: Record<string, SentCommand> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const command = commandOf(value);
    if (command !== undefined) commands[key] = command;
  }
  return pruneCommands(commands);
}

/** Records the choice keyboards, replacing the file whole. */
export function writeCommands(home: string, state: CommandState): void {
  const path = telegramCommandsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporary, path);
}

/** One progress message a reply is shown in: where it lives and what it last said. */
export interface ProgressRecord {
  /** The Telegram chat the message is in. */
  readonly target: number;
  /** The Telegram `message_id` to edit and to delete when the reply ends. */
  readonly messageId: number;
  /** The reduced Markdown that was last sent, so an unchanged text is not edited. */
  readonly text: string;
}

/** The progress messages still alive, by the chat they belong to. */
export type ProgressState = Readonly<Record<string, ProgressRecord>>;

/** The file the progress messages are recorded in. */
export function telegramProgressPath(home: string): string {
  return join(telegramStateDirectory(home), "progress.json");
}

function progressOf(value: unknown): ProgressRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.target !== "number" ||
    typeof value.messageId !== "number" ||
    typeof value.text !== "string"
  ) {
    return undefined;
  }
  return { target: value.target, messageId: value.messageId, text: value.text };
}

/** The recorded progress messages; empty when the file is missing or unusable. */
export function readProgress(home: string): ProgressState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(telegramProgressPath(home), "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const found: Record<string, ProgressRecord> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const record = progressOf(value);
    if (record !== undefined) found[key] = record;
  }
  return found;
}

/** Records the progress messages, replacing the file whole. */
export function writeProgress(home: string, state: ProgressState): void {
  const path = telegramProgressPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporary, path);
}
