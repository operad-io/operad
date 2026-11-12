/** The shape of a chat and its messages, and how a chat is read from its facts. */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { JsonValue, ObjectRef, ObjectStore, PluginFact } from "@operad-io/engine";
import { isRecord, storedType, stringList } from "@operad-io/engine";

/** The object type of a chat. */
export const CHAT_TYPE = "chat";

/** The fact type of one message on a chat; a person's and the assistant's alike. */
export const MESSAGE_FACT = "chat.message";

/** The fact type of one finished part of an answer: text, thinking or a tool call. */
export const ENTRY_FACT = "chat.entry";

/** How a tool call ended. */
export type ToolResult = "done" | "failed" | "blocked" | "denied";

/** The kinds of part an answer is recorded as. */
export type EntryKind = "text" | "thinking" | "tool" | "stopped";

/** The event type a new message is: its source is `ios`, `telegram`, `cli`, `tui` or `other`. */
export const MESSAGE_EVENT = "message";

/** The fact type of a change of a chat's model: who changed it, from what, to what. */
export const MODEL_FACT = "chat.model";

/** The fact type of a change of a chat's effort: who changed it, from what, to what. */
export const EFFORT_FACT = "chat.effort";

/** The fact type of a chat that was closed. */
export const CLOSED_FACT = "chat.closed";

/** The list filters of chats: closed ones are hidden unless asked for. */
export const CHAT_FILTERS = [
  { name: "open", default: true, states: ["open"] },
  { name: "closed", states: ["closed"] },
] as const;

/** Where a message can come from. */
export const CHAT_SOURCES = ["ios", "telegram", "cli", "tui"] as const;

/** The event source of a message from a client the chat does not know by name. */
export const OTHER_SOURCE = "other";

export type ChatSource = (typeof CHAT_SOURCES)[number];

/** Who wrote a message: the person, or the assistant. */
export type MessageRole = "user" | "assistant";

/** What a chat stores. The creating plugin gives every field but `session`. */
export interface ChatData {
  readonly [key: string]: unknown;
  /** The object one level up (a repository, a bot); a full object id. */
  readonly parent?: string | undefined;
  /** The harness plugin that answers, such as `claude`; fixed once the chat exists. */
  readonly harness: string;
  /** Where the harness works. */
  readonly cwd: string;
  /** The access profile the harness applies; opaque here. */
  readonly access: Readonly<Record<string, JsonValue>>;
  readonly skills: readonly string[];
  readonly title: string;
  /** Whether the chat was closed; a closed chat takes no messages. */
  readonly closed: boolean;
  /** The harness's own reference to its conversation; never shown. */
  readonly session?: string | null | undefined;
  /** The channels (`telegram:<chat>`) whose messages land here. */
  readonly channels: readonly string[];
  /**
   * A step (`<plugin>/<step>`) that gives the working directory, access profile
   * and skills as they are now; the reply asks it every time, so a chat whose
   * settings live elsewhere (a bot) follows them. The fields
   * above are then what the chat started with.
   */
  readonly refresh?: string | undefined;
  /** The model the next reply uses; one the agent's plugin lists. Absent for an agent that lists none. */
  readonly model?: string | undefined;
  /** The effort the next reply uses; one the agent's plugin lists. Absent for an agent that lists none. */
  readonly effort?: string | undefined;
  /** The agent's default effort when this chat was made, so the row can tell a choice from the default. */
  readonly effortDefault?: string | undefined;
  /** The model that gave the last reply, when its harness reported one. */
  readonly lastModel?: string | undefined;
  /** What the replies cost so far, in millionths of a dollar; absent while no reply reported a cost. */
  readonly costMicros?: number | undefined;
  /** How far to trust `costMicros`: the least exact of the replies counted. */
  readonly costQuality?: CostQuality | undefined;
}

/** How far to trust a cost: the harness's own words. */
export type CostQuality = "exact" | "estimated" | "incomplete";

/** What a plugin gives to create a chat. */
export interface NewChat {
  readonly parent?: string | undefined;
  readonly harness: string;
  readonly cwd: string;
  readonly access?: Readonly<Record<string, JsonValue>> | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly title: string;
  readonly channels?: readonly string[] | undefined;
  /** See {@link ChatData.model}. */
  readonly model?: string | undefined;
  /** See {@link ChatData.effort}. */
  readonly effort?: string | undefined;
  /** See {@link ChatData.effortDefault}. */
  readonly effortDefault?: string | undefined;
  /** See {@link ChatData.refresh}. */
  readonly refresh?: string | undefined;
}

/** One file attached to a message: where it is stored, and what a client shows of it. */
export interface Attachment {
  readonly [key: string]: unknown;
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

/** The image types claude and pi take as image input. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
};

/** The media type a file name's extension says; `application/octet-stream` when it says none. */
export function mediaTypeOf(name: string): string {
  return MEDIA_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** The attachment record of a stored file; throws when the file is not there. */
export function attachmentOf(path: string): Attachment {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`the attachment ${path} is not there`);
  }
  const name = basename(path);
  // The type the upload came with wins over a guess from the extension.
  return { path, name, type: storedType(path) ?? mediaTypeOf(name), size };
}

/** The attachments of a message fact; an older fact that holds bare paths reads as records. */
export function attachmentsOf(value: unknown): readonly Attachment[] {
  if (!Array.isArray(value)) return [];
  const found: Attachment[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      found.push({ path: item, name: basename(item), type: mediaTypeOf(item), size: 0 });
    } else if (isRecord(item) && typeof item.path === "string" && item.path.length > 0) {
      const name = typeof item.name === "string" ? item.name : basename(item.path);
      found.push({
        path: item.path,
        name,
        type: typeof item.type === "string" ? item.type : mediaTypeOf(name),
        size: typeof item.size === "number" ? item.size : 0,
      });
    }
  }
  return found;
}

/** What a model-change fact holds. */
export interface ModelChangedData {
  readonly [key: string]: unknown;
  readonly by: { readonly via: string; readonly id: string };
  readonly from: string | null;
  readonly to: string;
}

/** What an effort-change fact holds. */
export interface EffortChangedData {
  readonly [key: string]: unknown;
  readonly by: { readonly via: string; readonly id: string };
  readonly from: string | null;
  readonly to: string;
}

/**
 * The effort a new chat starts with: the one asked for, else the preferred one
 * (a bot's), else the agent's default. An effort the agent does not list is
 * refused by name; an agent that lists none takes none.
 */
export function startingEffort(
  harness: string,
  efforts: { readonly list: readonly string[]; readonly default: string | null } | undefined,
  asked: string | undefined,
  preferred?: string | undefined,
): string | undefined {
  const list = efforts?.list ?? [];
  const wanted = asked ?? preferred;
  if (wanted !== undefined) {
    if (!list.includes(wanted)) {
      throw new Error(
        `the agent "${harness}" cannot use the effort "${wanted}"; it offers: ${list.join(", ") || "none"}`,
      );
    }
    return wanted;
  }
  return efforts?.default ?? undefined;
}

/**
 * The model a new chat starts with: the one asked for, else the preferred one
 * (a bot's), else the agent's default. A model the agent does not list is refused
 * by name; an agent that lists none takes none.
 */
export function startingModel(
  harness: string,
  models: { readonly list: readonly string[]; readonly default: string | null } | undefined,
  asked: string | undefined,
  preferred?: string | undefined,
): string | undefined {
  const list = models?.list ?? [];
  const wanted = asked ?? preferred;
  if (wanted !== undefined) {
    if (!list.includes(wanted)) {
      throw new Error(
        `the agent "${harness}" cannot use the model "${wanted}"; it offers: ${list.join(", ") || "none"}`,
      );
    }
    return wanted;
  }
  return models?.default ?? undefined;
}

/** What a message fact holds. Attachment paths stay empty until attachments exist. */
export interface MessageData {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly role: MessageRole;
  readonly from: { readonly via: string; readonly id: string };
  readonly text: string;
  /** The files sent with it; their paths are under the chat's attachment directory. */
  readonly attachments: readonly Attachment[];
  /** Where it came from, and its id there (a Telegram message id), when it has one. */
  readonly source: { readonly kind: string; readonly ref: string | null };
  /** An assistant message: the ids of the messages it answers. */
  readonly replyTo?: readonly string[] | undefined;
  /** The run whose answer this message or entry belongs to. */
  readonly runId?: string | undefined;
  /** An assistant message: the harness session after it. */
  readonly session?: string | undefined;
  /** An assistant message: the model that answered, when the harness reported it. */
  readonly model?: string | undefined;
  /** An assistant message: what it cost in millionths of a dollar, when reported. */
  readonly costMicros?: number | undefined;
  readonly costQuality?: CostQuality | undefined;
}

/** One message with when it was recorded. */
export interface Message extends MessageData {
  readonly at: number;
  readonly sequence: number;
}

/**
 * What one finished part of an answer holds. Tool calls carry the call's id and
 * name, what ran, how it ended, when it started, how long it took, the start of
 * its output and, when the output was long, the file that holds all of it.
 */
export interface EntryData {
  readonly [key: string]: unknown;
  readonly runId: string;
  readonly kind: EntryKind;
  /** Text or thinking; the half-written reply of a stopped run is `stopped`. */
  readonly text?: string | undefined;
  readonly callId?: string | undefined;
  readonly toolName?: string | undefined;
  /** What ran: the command, path or main argument, as the harness summarized it. */
  readonly input?: string | null | undefined;
  readonly result?: ToolResult | undefined;
  /** Epoch milliseconds; null when the harness gave no start time. */
  readonly startedAt?: number | null | undefined;
  readonly durationMs?: number | undefined;
  /** The first 4 KB of what the call printed; null when it printed nothing. */
  readonly output?: string | null | undefined;
  /** The file that holds the whole output, when it was longer than 4 KB. */
  readonly outputPath?: string | undefined;
  readonly outputTruncated?: boolean | undefined;
  /** The first line of the error, when the call failed. */
  readonly error?: string | null | undefined;
}

/** One entry with when its fact was recorded. */
export interface Entry extends EntryData {
  readonly at: number;
  readonly sequence: number;
}

/** What a close fact holds: who closed the chat. */
export interface ClosedData {
  readonly [key: string]: unknown;
  readonly by: { readonly via: string; readonly id: string };
}

/** The chat fields of a stored object, with the lists defaulted. */
export function chatData(data: Readonly<Record<string, unknown>>): ChatData {
  return {
    ...data,
    harness: typeof data.harness === "string" ? data.harness : "",
    cwd: typeof data.cwd === "string" ? data.cwd : "",
    access: isRecord(data.access) ? (data.access as Record<string, JsonValue>) : {},
    skills: stringList(data.skills),
    title: typeof data.title === "string" ? data.title : "",
    closed: data.closed === true,
    channels: stringList(data.channels),
    ...(typeof data.refresh === "string" && data.refresh.length > 0 ? { refresh: data.refresh } : {}),
    ...(typeof data.model === "string" && data.model.length > 0 ? { model: data.model } : {}),
    ...(typeof data.effort === "string" && data.effort.length > 0 ? { effort: data.effort } : {}),
    ...(typeof data.effortDefault === "string" && data.effortDefault.length > 0 ? { effortDefault: data.effortDefault } : {}),
    ...(typeof data.lastModel === "string" && data.lastModel.length > 0 ? { lastModel: data.lastModel } : {}),
    ...(typeof data.costMicros === "number" && Number.isFinite(data.costMicros) ? { costMicros: data.costMicros } : {}),
    ...(isCostQuality(data.costQuality) ? { costQuality: data.costQuality } : {}),
  };
}

function isCostQuality(value: unknown): value is CostQuality {
  return value === "exact" || value === "estimated" || value === "incomplete";
}

/** A cost as text: `$0.12`, `~$0.12` when estimated, `≥$0.12` when only part was priced. */
export function costText(micros: number, quality: CostQuality | undefined): string {
  const symbol = quality === "estimated" ? "~" : quality === "incomplete" ? "≥" : "";
  return `${symbol}$${(micros / 1e6).toFixed(2)}`;
}

/** The model and cost parts of a line, as far as they are known. */
export function modelAndCost(
  model: string | undefined,
  micros: number | undefined,
  quality: CostQuality | undefined,
): readonly string[] {
  return [
    ...(model === undefined || model.length === 0 ? [] : [model]),
    ...(micros === undefined ? [] : [costText(micros, quality)]),
  ];
}

/** What a chat uses, for its row and its page: `claude · sonnet · high · $0.12`. */
export function agentLine(chat: ChatData): string {
  const model = chat.model ?? chat.lastModel;
  const effort =
    chat.effort !== undefined && chat.effort !== chat.effortDefault ? [chat.effort] : [];
  return [
    chat.harness,
    ...(model === undefined || model.length === 0 ? [] : [model]),
    ...effort,
    ...(chat.costMicros === undefined ? [] : [costText(chat.costMicros, chat.costQuality)]),
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** The model, cost and quality a harness's `usage` reports; each only when it did. */
export function usageOf(value: unknown): {
  readonly model?: string;
  readonly costMicros?: number;
  readonly costQuality?: CostQuality;
} {
  if (!isRecord(value)) return {};
  const micros = value.costMicros;
  const known = typeof micros === "number" && Number.isFinite(micros);
  return {
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(known ? { costMicros: micros } : {}),
    ...(known ? { costQuality: isCostQuality(value.costQuality) ? value.costQuality : "estimated" } : {}),
  };
}

const QUALITY_ORDER: readonly CostQuality[] = ["exact", "estimated", "incomplete"];

/** The less exact of two qualities; an absent one counts for the other. */
export function worseQuality(a: CostQuality | undefined, b: CostQuality | undefined): CostQuality | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return QUALITY_ORDER.indexOf(a) >= QUALITY_ORDER.indexOf(b) ? a : b;
}

/** The longest title taken from a first message. */
export const TITLE_FROM_MESSAGE_MAX = 60;

/**
 * A chat title from the start of its first message: its first non-empty line,
 * cut at a word boundary when it is longer than {@link TITLE_FROM_MESSAGE_MAX},
 * with an ellipsis. Undefined when the message has no text.
 */
export function titleFromMessage(message: string): string | undefined {
  const line = message.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  if (line === undefined) return undefined;
  const flat = line.replace(/\s+/g, " ");
  if (flat.length <= TITLE_FROM_MESSAGE_MAX) return flat;
  const cut = flat.slice(0, TITLE_FROM_MESSAGE_MAX);
  const space = cut.lastIndexOf(" ");
  const base = space >= TITLE_FROM_MESSAGE_MAX / 2 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s.,;:!?]+$/, "")}…`;
}

/** A new message id; the event's key. */
export function newMessageId(): string {
  return `m-${randomUUID()}`;
}

/** The reference of a chat in events and facts. */
export function chatRef(id: string): ObjectRef {
  return { type: CHAT_TYPE, id };
}

/** The next free chat id, `C-0001` upward. */
async function nextChatId(store: ObjectStore): Promise<string> {
  let highest = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      const match = /^C-(\d+)$/.exec(object.id);
      if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return `C-${String(highest + 1).padStart(4, "0")}`;
}

/** Creates a chat for a plugin that has every field; returns its id. */
export async function createChat(
  store: ObjectStore,
  input: NewChat,
  cause: string,
): Promise<string> {
  if (input.harness.trim().length === 0) throw new Error("a chat needs an agent");
  if (input.cwd.trim().length === 0) throw new Error("a chat needs a working directory");
  if (input.title.trim().length === 0) throw new Error("a chat needs a title");
  const data: ChatData = {
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    harness: input.harness,
    cwd: input.cwd,
    access: input.access ?? {},
    skills: input.skills ?? [],
    title: input.title.trim(),
    closed: false,
    session: null,
    channels: input.channels ?? [],
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.effort === undefined || input.effortDefault === undefined ? {} : { effortDefault: input.effortDefault }),
    ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
  };
  // The id counts up; a taken one (two chats made at once) moves on to the next.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = await nextChatId(store);
    const id = `C-${String(Number(base.slice(2)) + attempt).padStart(4, "0")}`;
    if ((await store.get(CHAT_TYPE, id)) !== undefined) continue;
    await store.put(CHAT_TYPE, id, data, cause);
    return id;
  }
  throw new Error("cannot find a free chat id");
}

function messageOfFact(fact: PluginFact): Message | undefined {
  if (fact.type !== MESSAGE_FACT) return undefined;
  const data = fact.data;
  if (typeof data.id !== "string" || typeof data.text !== "string") return undefined;
  if (data.role !== "user" && data.role !== "assistant") return undefined;
  const from = isRecord(data.from) ? data.from : {};
  const source = isRecord(data.source) ? data.source : {};
  return {
    id: data.id,
    role: data.role,
    from: {
      via: typeof from.via === "string" ? from.via : "",
      id: typeof from.id === "string" ? from.id : "",
    },
    text: data.text,
    attachments: attachmentsOf(data.attachments),
    source: {
      kind: typeof source.kind === "string" ? source.kind : "",
      ref: typeof source.ref === "string" ? source.ref : null,
    },
    ...(Array.isArray(data.replyTo) ? { replyTo: stringList(data.replyTo) } : {}),
    ...(typeof data.runId === "string" && data.runId.length > 0 ? { runId: data.runId } : {}),
    ...(typeof data.session === "string" ? { session: data.session } : {}),
    ...(typeof data.model === "string" && data.model.length > 0 ? { model: data.model } : {}),
    ...(typeof data.costMicros === "number" && Number.isFinite(data.costMicros) ? { costMicros: data.costMicros } : {}),
    ...(isCostQuality(data.costQuality) ? { costQuality: data.costQuality } : {}),
    at: fact.at,
    sequence: fact.sequence,
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return value === "done" || value === "failed" || value === "blocked" || value === "denied";
}

export function entryOfFact(fact: PluginFact): Entry | undefined {
  if (fact.type !== ENTRY_FACT) return undefined;
  const data = fact.data;
  if (typeof data.runId !== "string" || data.runId.length === 0) return undefined;
  const kind = data.kind;
  if (kind !== "text" && kind !== "thinking" && kind !== "tool" && kind !== "stopped") return undefined;
  const entryKind: EntryKind = kind;
  const base = { runId: data.runId, kind: entryKind, at: fact.at, sequence: fact.sequence };
  if (entryKind === "tool") {
    if (typeof data.callId !== "string" || typeof data.toolName !== "string" || !isToolResult(data.result)) {
      return undefined;
    }
    return {
      ...base,
      callId: data.callId,
      toolName: data.toolName,
      ...(typeof data.input === "string" || data.input === null ? { input: data.input } : {}),
      result: data.result,
      ...(typeof data.startedAt === "number" || data.startedAt === null ? { startedAt: data.startedAt } : {}),
      ...(typeof data.durationMs === "number" && Number.isFinite(data.durationMs) ? { durationMs: data.durationMs } : {}),
      ...(typeof data.output === "string" || data.output === null ? { output: data.output } : {}),
      ...(typeof data.outputPath === "string" ? { outputPath: data.outputPath } : {}),
      ...(data.outputTruncated === true ? { outputTruncated: true } : {}),
      ...(typeof data.error === "string" || data.error === null ? { error: data.error } : {}),
    };
  }
  return typeof data.text === "string" ? { ...base, text: data.text } : undefined;
}

/** One page of a chat's messages from `cursor`, and where the next page starts. */
export function messagePage(
  store: ObjectStore,
  chat: string,
  cursor: string | undefined,
  limit: number,
): { readonly messages: readonly Message[]; readonly next: string | undefined } {
  const messages: Message[] = [];
  let at = cursor;
  for (;;) {
    const page = store.facts(chatRef(chat), {
      ...(at === undefined ? {} : { cursor: at }),
      limit,
    });
    for (const fact of page.facts) {
      const message = messageOfFact(fact);
      if (message !== undefined) messages.push(message);
    }
    if (page.next === undefined || messages.length >= limit) {
      return { messages, next: page.next };
    }
    at = page.next;
  }
}

/** Every message of a chat, oldest first. */
export function allMessages(store: ObjectStore, chat: string): readonly Message[] {
  const found: Message[] = [];
  let cursor: string | undefined;
  do {
    const page = messagePage(store, chat, cursor, 500);
    found.push(...page.messages);
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** Every entry of a chat, oldest first. */
export function allEntries(store: ObjectStore, chat: string): readonly Entry[] {
  const found: Entry[] = [];
  let cursor: string | undefined;
  do {
    const page = store.facts(chatRef(chat), {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 500,
    });
    for (const fact of page.facts) {
      const entry = entryOfFact(fact);
      if (entry !== undefined) found.push(entry);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** The person's messages no assistant message answers yet, oldest first. */
export function unanswered(messages: readonly Message[]): readonly Message[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const id of message.replyTo ?? []) answered.add(id);
    }
  }
  return messages.filter((message) => message.role === "user" && !answered.has(message.id));
}

/** The harness session after the last reply, else the chat's own reference. */
export function currentSession(
  chat: ChatData,
  messages: readonly Message[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.session !== undefined) return message.session;
  }
  return typeof chat.session === "string" && chat.session.length > 0 ? chat.session : undefined;
}

function sizeText(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** The lines that give a message's files to an agent as paths; `shown` marks those it also gets as images. */
function attachmentLines(message: Message, shown: ReadonlySet<string>): string {
  if (message.attachments.length === 0) return "";
  const lines = message.attachments.map(
    (file) =>
      `- ${file.path} (${file.name}, ${file.type}, ${sizeText(file.size)}${shown.has(file.path) ? "; also given to you as an image" : ""})`,
  );
  return `Attached files:\n${lines.join("\n")}`;
}

/**
 * The prompt for the messages to answer, built from facts alone. A message's
 * files follow its text as paths; `images` are the paths also given as image input.
 */
export function promptFor(pending: readonly Message[], images: ReadonlySet<string> = new Set()): string {
  const parts = pending.map((message) =>
    [message.text, attachmentLines(message, images)].filter((part) => part.length > 0).join("\n\n"),
  );
  return parts.join("\n\n");
}
