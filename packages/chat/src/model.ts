/** The shape of a chat and its messages, and how a chat is read from its facts. */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type {
  ActionArgSchema,
  AgentTimings,
  CostQuality,
  HarnessModels,
  JsonValue,
  ObjectRef,
  ObjectStore,
  PluginFact,
  RunControl,
  UsageTokens,
} from "@operad-io/engine";
import { isRecord, modelIds, safeFileName, storedType, stringList } from "@operad-io/engine";
import { isAccessLevel, type AccessLevel } from "@operad-io/access-match";

/** The object type of a chat. */
export const CHAT_TYPE = "chat";

/** The fact type of one message on a chat; a person's and the assistant's alike. */
export const MESSAGE_FACT = "chat.message";

/** The fact type of one finished part of an answer: text, thinking or a tool call. */
export const ENTRY_FACT = "chat.entry";

/** The fact type of a reply run that began on a chat: the run id, so a view can find the step's log. */
export const RUN_FACT = "chat.run";

/** The fact type of a run a `/stop` cancelled, so status and retry need not read the command's words. */
export const STOP_FACT = "chat.stop";

/** The fact type of a `/new`: the session in force ends here and the next reply starts a fresh one. */
export const NEW_FACT = "chat.new";

/**
 * The fact type of the brief a `/new <goal>` gives the new session: one model
 * call's text, or why there is none, with the call's model and cost.
 */
export const BRIEF_FACT = "chat.brief";

/** The fact type of messages an attempt took, when no reply message can name them. */
export const ANSWER_FACT = "chat.answered";

/**
 * The fact type of messages a run took: the messages of its first prompt, and
 * each message an agent took while the run was going. A message in one is never
 * queued again, even when the attempt fails and a later run answers it.
 */
export const TAKEN_FACT = "chat.taken";

/** The fact type of a change to a message that had not been taken: its text, or its withdrawal. */
export const MESSAGE_CHANGE_FACT = "chat.message_change";

/**
 * The fact type of an attempt that ended on its own. A recovered reply step
 * reads it to tell a step that returned `interrupted` from one a crash left.
 */
export const ATTEMPT_END_FACT = "chat.attempt_end";

/** How a tool call ended. */
export type ToolResult = "done" | "failed" | "blocked" | "denied";

/** The kinds of part an answer is recorded as; `failure` is why a reply did not arrive. */
export type EntryKind = "text" | "thinking" | "tool" | "stopped" | "failure" | "worktree";

/** What the transcript says when a repository chat moves into its worktree. */
export const WORKTREE_NOTE = "This chat now works in a worktree.";

/** The event type a new message is: its source is `ios`, `telegram`, `cli`, `tui` or `other`. */
export const MESSAGE_EVENT = "message";

/** The fact type of a change of a chat's model: who changed it, from what, to what. */
export const MODEL_FACT = "chat.model";

/** The fact type of a change of a chat's effort: who changed it, from what, to what. */
export const EFFORT_FACT = "chat.effort";

/** The fact type of a change of a chat's access level: who changed it, from what, to what. */
export const ACCESS_FACT = "chat.access";

/** What each level means, in the chat action's information and a question its change lifts. */
export const ACCESS_LEVEL_INFO: Readonly<Record<AccessLevel, { readonly title: string; readonly description: string }>> = {
  plan: {
    title: "Plan only",
    description: "Read and run commands known to only read; a write asks.",
  },
  ask: {
    title: "Ask each time",
    description: "Every write and every command not known to only read asks.",
  },
  edits: {
    title: "Accept edits",
    description: "Write files in the working directory; a command not known to only read asks.",
  },
  full: {
    title: "Full access",
    description: "Skip every question; a deny still refuses and a read-only working directory still asks.",
  },
};

/** The file a chat keeps its live level in, read again by a harness for each call. */
export function accessLevelPath(home: string, chat: string): string {
  return join(home, "chat", safeFileName(chat), "access.json");
}

/**
 * The field the access action puts on the in-memory chat while it runs the
 * chat's `accessAction`; that action is out of every client list except then.
 */
export const ACCESS_ACTION_REQUEST = "accessActionRequest";

/** The fact type of a chat that was closed. */
export const CLOSED_FACT = "chat.closed";

/** The fact type of one command a person typed in a chat, and how it went. */
export const COMMAND_FACT = "chat.command";

/** The fact type of a request to compact a chat's context (`/compact`) and of its being taken. */
export const COMPACT_FACT = "chat.compact";

/** The share of the model's window at which a pi chat compacts its context after a reply (ADR 0023 D13). */
export const COMPACT_AT = 0.75;

/**
 * The one silent turn a bot chat runs before a compaction. It names no file:
 * the bot's memory instructions, already on the chat, say how and where memory
 * is written, and the turn writes under the same access rules as any other.
 */
export const COMPACT_FLUSH =
  "Your context is about to be compacted, and what is only in it will be lost. " +
  "Write now, to this bot's memory and by its memory instructions, what you should remember from this chat. " +
  "Write only what is worth keeping and not already in memory; if there is nothing, write nothing. " +
  "Do not answer or address the person. When you are done, reply with the one word: done.";

/** Whether the latest `chat.compact` fact is a request that no run has taken yet. */
export function compactRequested(facts: readonly PluginFact[]): boolean {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (fact?.type === COMPACT_FACT) return fact.data.kind === "request";
  }
  return false;
}

/** The list filters of chats: closed ones are hidden unless asked for. */
export const CHAT_FILTERS = [
  { name: "open", default: true, states: ["open"] },
  { name: "closed", states: ["closed"] },
] as const;

/** Where a message can come from. */
export const CHAT_SOURCES = ["ios", "telegram", "cli", "tui"] as const;

/** The event source of a message from a client the chat does not know by name. */
export const OTHER_SOURCE = "other";

/** Who wrote a message: the person, or the assistant. */
export type MessageRole = "user" | "assistant";

/** The scheduled prompt that opened a chat: its bot and the entry's name. */
export interface ScheduledChat {
  readonly [key: string]: string;
  readonly bot: string;
  readonly entry: string;
}

/** The scheduled origin a stored chat names, if it has one. */
export function scheduledChatOf(value: unknown): ScheduledChat | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.bot !== "string" || value.bot.length === 0) return undefined;
  if (typeof value.entry !== "string" || value.entry.length === 0) return undefined;
  return { bot: value.bot, entry: value.entry };
}

/** The hashes of the notes a chat's session last saw, keyed by the note's name. */
export interface ChatNoteHashes {
  /** The harness session the hashes belong to; absent for a session with no reference yet. */
  readonly session?: string | undefined;
  readonly files: Readonly<Record<string, string>>;
}

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
  /** The level the next reply uses: `plan`, `ask`, `edits` or `full`. */
  readonly accessLevel?: AccessLevel | undefined;
  /** The level this chat started at, so the row can tell a choice from the default. */
  readonly accessDefault?: AccessLevel | undefined;
  /**
   * Whether a person chose the level with `chat:access`. A chat that did not
   * choose follows its plugin's starting level when that changes.
   */
  readonly accessChosen?: boolean | undefined;
  readonly skills: readonly string[];
  readonly title: string;
  /** Whether the chat was closed; a closed chat takes no messages. */
  readonly closed: boolean;
  /** The harness's own reference to its conversation; never shown. */
  readonly session?: string | null | undefined;
  /** The working directory the session's starting text was built for; never shown. */
  readonly contextCwd?: string | undefined;
  /** The hashes of the notes this session last saw; never shown. */
  readonly noteHashes?: ChatNoteHashes | undefined;
  /** The channels (`telegram:<chat>`) whose messages land here. */
  readonly channels: readonly string[];
  /**
   * A step (`<plugin>/<step>`) that gives the working directory, access profile
   * and skills as they are now; the reply asks it every time, so a chat whose
   * settings live elsewhere (a bot) follows them. The fields
   * above are then what the chat started with.
   */
  readonly refresh?: string | undefined;
  /**
   * An action (`<plugin>/<action>`) that prepares a change of the access level,
   * such as opening a repository chat's worktree before it becomes writable;
   * the access action runs it before it records the new level.
   */
  readonly accessAction?: string | undefined;
  /** The model the next reply uses; one the agent's plugin lists. Absent for an agent that lists none. */
  readonly model?: string | undefined;
  /** The effort the next reply uses; one the agent's plugin lists. Absent for an agent that lists none. */
  readonly effort?: string | undefined;
  /** The agent's default effort when this chat was made; a fallback only when the agent declares none now. */
  readonly effortDefault?: string | undefined;
  /** The model that gave the last reply, when its harness reported one. */
  readonly lastModel?: string | undefined;
  /** What the replies cost so far, in millionths of a dollar; absent while no reply reported a cost. */
  readonly costMicros?: number | undefined;
  /** How far to trust `costMicros`: the least exact of the replies counted. */
  readonly costQuality?: CostQuality | undefined;
  /** The tokens the replies used so far; absent while no reply reported any. */
  readonly tokens?: UsageTokens | undefined;
  /** True when some replies reported no tokens, so `tokens` is a partial total. */
  readonly tokensIncomplete?: true | undefined;
  /** The scheduled prompt that opened this chat; absent for every other chat. */
  readonly scheduled?: ScheduledChat | undefined;
  /**
   * True for the record of one run of a routine: it keeps the reply and its
   * process like a chat, takes an `R-` id, and is not in the chat list.
   */
  readonly run?: true | undefined;
}

/** What a plugin gives to create a chat. */
export interface NewChat {
  readonly parent?: string | undefined;
  readonly harness: string;
  readonly cwd: string;
  readonly access?: Readonly<Record<string, JsonValue>> | undefined;
  /** The level the chat starts at; when absent, `plan` for a read-only profile and `ask` otherwise. */
  readonly accessLevel?: AccessLevel | undefined;
  /** See {@link ChatData.accessDefault}. Defaults to the starting level. */
  readonly accessDefault?: AccessLevel | undefined;
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
  /** See {@link ChatData.accessAction}. */
  readonly accessAction?: string | undefined;
  /** See {@link ChatData.scheduled}. */
  readonly scheduled?: ScheduledChat | undefined;
  /** See {@link ChatData.run}. */
  readonly run?: boolean | undefined;
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

/** What an access-level change fact holds. */
export interface AccessChangedData {
  readonly [key: string]: unknown;
  readonly by: { readonly via: string; readonly id: string };
  readonly from: AccessLevel;
  readonly to: AccessLevel;
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
 * The effort the chat itself chose, or undefined when it only inherits the
 * agent's default. An effort equal to the one stored when the chat was made is
 * inherited, so a harness whose default changed is followed.
 */
export function chosenEffort(
  chat: Pick<ChatData, "effort" | "effortDefault">,
): string | undefined {
  return chat.effort !== undefined && chat.effort !== chat.effortDefault
    ? chat.effort
    : undefined;
}

/**
 * The effort in force for a chat: its own choice, else the agent's live declared
 * default, else the default stored when the chat was made. The stored default is
 * only a fallback for an agent that declares none now, so a harness whose
 * default changed is followed.
 */
export function effectiveEffort(
  chat: Pick<ChatData, "effort" | "effortDefault">,
  efforts: { readonly default: string | null } | undefined,
): string | undefined {
  const chosen = chosenEffort(chat);
  if (chosen !== undefined) return chosen;
  const declared = efforts?.default;
  return declared !== null && declared !== undefined ? declared : chat.effortDefault;
}

/**
 * The model a new chat starts with: the one asked for, else the preferred one
 * (a bot's), else the agent's default. A model the agent does not list is refused
 * by name; an agent that lists none takes none.
 */
export function startingModel(
  harness: string,
  models: HarnessModels | undefined,
  asked: string | undefined,
  preferred?: string | undefined,
): string | undefined {
  const list = modelIds(models);
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
  /** A user message: text only the agent is given after the text; no view shows it. */
  readonly instruction?: string | undefined;
  /** The run whose answer this message or entry belongs to. */
  readonly runId?: string | undefined;
  /** An assistant message: the harness session after it. */
  readonly session?: string | undefined;
  /** An assistant message: the model that answered, when the harness reported it. */
  readonly model?: string | undefined;
  /** An assistant message: what it cost in millionths of a dollar, when reported. */
  readonly costMicros?: number | undefined;
  readonly costQuality?: CostQuality | undefined;
  /** An assistant message: the tokens it used, when the harness reported them. */
  readonly tokens?: UsageTokens | undefined;
  /** An assistant message: the context it ended with, when the harness could tell. */
  readonly context?: ReplyContext | undefined;
  /** An assistant message: how long the step took to start, to its first line, and in all. */
  readonly timings?: AgentTimings | undefined;
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
  /**
   * Epoch milliseconds: a tool call's start, or when the log received the line
   * that finished a text or thinking part. Null for a tool call whose log had
   * no start line; absent when the item carries no time, such as an old fact.
   */
  readonly startedAt?: number | null | undefined;
  readonly durationMs?: number | undefined;
  /** The first 4 KB of what the call printed; null when it printed nothing. */
  readonly output?: string | null | undefined;
  /** The file that holds the whole output, when it was longer than 4 KB. */
  readonly outputPath?: string | undefined;
  readonly outputTruncated?: boolean | undefined;
  /** The first line of the error, when the call failed. */
  readonly error?: string | null | undefined;
  /** On `failure`: why the reply failed (`empty`, `model_error`, ...). */
  readonly reason?: string | undefined;
  /** On `failure`: the oldest message the failed reply was for. */
  readonly messageId?: string | undefined;
  /** On `stopped`: the one line that says a crash or restart interrupted the reply. */
  readonly interrupted?: boolean | undefined;
}

/** One entry with when its fact was recorded. */
export interface Entry extends EntryData {
  readonly at: number;
  readonly sequence: number;
}

/** What a stop fact holds: the reply run the command cancelled, and who stopped it. */
export interface StopData {
  readonly [key: string]: unknown;
  readonly runId: string;
  readonly by: { readonly via: string; readonly id: string };
}

/** The stop a fact records, or undefined for another fact. */
export function stopOfFact(fact: PluginFact): StopData | undefined {
  if (fact.type !== STOP_FACT) return undefined;
  const data = fact.data;
  if (typeof data.runId !== "string" || data.runId.length === 0) return undefined;
  const from = isRecord(data.by) ? data.by : {};
  return {
    runId: data.runId,
    by: {
      via: typeof from.via === "string" ? from.via : "",
      id: typeof from.id === "string" ? from.id : "",
    },
  };
}

/** The run a stop fact cancelled after a sequence, newest first, or undefined. */
export function stoppedRunAfter(
  facts: readonly PluginFact[],
  after: number,
): string | undefined {
  let found: string | undefined;
  for (const fact of facts) {
    if (fact.sequence <= after) continue;
    const stop = stopOfFact(fact);
    if (stop !== undefined) found = stop.runId;
  }
  return found;
}

/** The ids a `chat.answered` fact records as taken by one run. */
export function answeredOfFact(fact: PluginFact): readonly string[] {
  if (fact.type !== ANSWER_FACT || !Array.isArray(fact.data.ids)) return [];
  return fact.data.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** The ids a `chat.answered` or `chat.taken` fact records as taken by one run. */
export function takenOfFact(fact: PluginFact): readonly string[] {
  if ((fact.type !== ANSWER_FACT && fact.type !== TAKEN_FACT) || !Array.isArray(fact.data.ids)) return [];
  return fact.data.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Every message a run has taken: in its first prompt, handed over mid-run, or answered. */
export function takenIds(facts: readonly PluginFact[]): ReadonlySet<string> {
  const taken = new Set<string>();
  for (const fact of facts) {
    for (const id of takenOfFact(fact)) taken.add(id);
    if (fact.type === MESSAGE_FACT && fact.data.role === "assistant" && Array.isArray(fact.data.replyTo)) {
      for (const id of fact.data.replyTo) {
        if (typeof id === "string" && id.length > 0) taken.add(id);
      }
    }
  }
  return taken;
}

/** What a message change fact holds: who changed which message, and how. */
export interface MessageChangeData {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly kind: "text" | "withdraw";
  readonly by: { readonly via: string; readonly id: string };
  /** The new text, on a `text` change. */
  readonly text?: string | undefined;
}

/** One message change with when its fact was recorded. */
export interface MessageChange extends MessageChangeData {
  readonly at: number;
  readonly sequence: number;
}

/** The change a fact records, or undefined for another fact. */
export function messageChangeOfFact(fact: PluginFact): MessageChange | undefined {
  if (fact.type !== MESSAGE_CHANGE_FACT) return undefined;
  const data = fact.data;
  if (typeof data.id !== "string" || data.id.length === 0) return undefined;
  if (data.kind !== "text" && data.kind !== "withdraw") return undefined;
  if (data.kind === "text" && typeof data.text !== "string") return undefined;
  const from = isRecord(data.by) ? data.by : {};
  return {
    id: data.id,
    kind: data.kind,
    by: {
      via: typeof from.via === "string" ? from.via : "",
      id: typeof from.id === "string" ? from.id : "",
    },
    ...(typeof data.text === "string" ? { text: data.text } : {}),
    at: fact.at,
    sequence: fact.sequence,
  };
}

/** The changes to each message, oldest first: its latest text and its withdrawal. */
export interface MessageChangeState {
  readonly withdrawn?: MessageChange | undefined;
  readonly text?: string | undefined;
}

export function messageChangesOf(facts: readonly PluginFact[]): ReadonlyMap<string, MessageChangeState> {
  const changes = new Map<string, MessageChangeState>();
  for (const fact of facts) {
    const change = messageChangeOfFact(fact);
    if (change === undefined) continue;
    const before = changes.get(change.id) ?? {};
    changes.set(
      change.id,
      change.kind === "withdraw"
        ? { ...before, withdrawn: change }
        : { ...before, text: change.text },
    );
  }
  return changes;
}

/** The messages with their latest text, without the ones a person withdrew. */
export function applyMessageChanges(
  messages: readonly Message[],
  changes: ReadonlyMap<string, MessageChangeState>,
): readonly Message[] {
  const found: Message[] = [];
  for (const message of messages) {
    const change = changes.get(message.id);
    if (change?.withdrawn !== undefined) continue;
    found.push(change?.text === undefined ? message : { ...message, text: change.text });
  }
  return found;
}

/** The message facts with their latest text, without the messages a person withdrew. */
export function messageFactsInForce(
  facts: readonly PluginFact[],
  changes: ReadonlyMap<string, MessageChangeState> = messageChangesOf(facts),
): readonly PluginFact[] {
  const found: PluginFact[] = [];
  for (const fact of facts) {
    if (fact.type !== MESSAGE_FACT || fact.data.role !== "user") {
      found.push(fact);
      continue;
    }
    const id = typeof fact.data.id === "string" ? fact.data.id : undefined;
    const change = id === undefined ? undefined : changes.get(id);
    if (change?.withdrawn !== undefined) continue;
    found.push(
      change?.text === undefined ? fact : { ...fact, data: { ...fact.data, text: change.text } },
    );
  }
  return found;
}

/** A queued message, in the shape a chat's row and section carry. */
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly attachments: readonly Attachment[];
}

/** The queued messages a chat shows a client, oldest first. */
export function queuedMessages(
  messages: readonly Message[],
  facts: readonly PluginFact[],
): readonly Message[] {
  const taken = takenIds(facts);
  return unanswered(messages, facts).filter((message) => !taken.has(message.id));
}

/** The queued messages as a client reads them. */
export function queuedData(messages: readonly Message[]): readonly QueuedMessage[] {
  return messages.map((message) => ({
    id: message.id,
    text: message.text,
    at: message.at,
    attachments: message.attachments,
  }));
}

/** The queued messages a stored chat object carries, when it has them. */
export function queuedOf(value: unknown): readonly QueuedMessage[] {
  if (!Array.isArray(value)) return [];
  const found: QueuedMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    if (typeof item.text !== "string") continue;
    const at = item.at;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    found.push({ id: item.id, text: item.text, at, attachments: attachmentsOf(item.attachments) });
  }
  return found;
}

/** The run an attempt fact says ended on its own, or undefined for another fact. */
export function attemptEndedOfFact(fact: PluginFact): string | undefined {
  if (fact.type !== ATTEMPT_END_FACT) return undefined;
  return typeof fact.data.runId === "string" && fact.data.runId.length > 0
    ? fact.data.runId
    : undefined;
}

/** What a close fact holds: who closed the chat. */
export interface ClosedData {
  readonly [key: string]: unknown;
  readonly by: { readonly via: string; readonly id: string };
}

/** What a command fact holds: who typed it, the command and how it went. */
export interface CommandData {
  readonly [key: string]: unknown;
  readonly from: { readonly via: string; readonly id: string };
  /** The command as typed, starting with `/`. */
  readonly command: string;
  /** What happened, or why it was refused. */
  readonly outcome: string;
  readonly ok: boolean;
}

/** One command with when its fact was recorded. */
export interface Command extends CommandData {
  readonly at: number;
  readonly sequence: number;
}

/** The command a fact records, or undefined for another fact. */
export function commandOfFact(fact: PluginFact): Command | undefined {
  if (fact.type !== COMMAND_FACT) return undefined;
  const data = fact.data;
  if (
    typeof data.command !== "string" ||
    typeof data.outcome !== "string" ||
    typeof data.ok !== "boolean"
  ) {
    return undefined;
  }
  const from = isRecord(data.from) ? data.from : {};
  return {
    from: {
      via: typeof from.via === "string" ? from.via : "",
      id: typeof from.id === "string" ? from.id : "",
    },
    command: data.command,
    outcome: data.outcome,
    ok: data.ok,
    at: fact.at,
    sequence: fact.sequence,
  };
}

/** The level a chat falls back to when it has none: a read-only profile starts at plan, any other at ask. */
function fallbackAccessLevel(data: Readonly<Record<string, unknown>>): AccessLevel {
  return isRecord(data.access) && data.access.readOnly === true ? "plan" : "ask";
}

function noteHashesOf(value: unknown): ChatNoteHashes | undefined {
  if (!isRecord(value) || !isRecord(value.files)) return undefined;
  const files: Record<string, string> = {};
  for (const [name, hash] of Object.entries(value.files)) {
    if (name.length > 0 && typeof hash === "string" && hash.length > 0) files[name] = hash;
  }
  return {
    ...(typeof value.session === "string" && value.session.length > 0 ? { session: value.session } : {}),
    files,
  };
}

/** The chat fields of a stored object, with the lists and the access level defaulted. */
export function chatData(data: Readonly<Record<string, unknown>>): ChatData {
  const tokens = usageTokensOf(data.tokens);
  const scheduled = scheduledChatOf(data.scheduled);
  const noteHashes = noteHashesOf(data.noteHashes);
  const accessDefault = isAccessLevel(data.accessDefault)
    ? data.accessDefault
    : fallbackAccessLevel(data);
  const accessLevel = isAccessLevel(data.accessLevel) ? data.accessLevel : accessDefault;
  // A chat stored before the flag existed chose a level when it differs from its starting one.
  const accessChosen = data.accessChosen === true || accessLevel !== accessDefault;
  return {
    ...data,
    harness: typeof data.harness === "string" ? data.harness : "",
    cwd: typeof data.cwd === "string" ? data.cwd : "",
    access: isRecord(data.access) ? (data.access as Record<string, JsonValue>) : {},
    accessLevel,
    accessDefault,
    accessChosen,
    skills: stringList(data.skills),
    title: typeof data.title === "string" ? data.title : "",
    closed: data.closed === true,
    channels: stringList(data.channels),
    ...(typeof data.refresh === "string" && data.refresh.length > 0 ? { refresh: data.refresh } : {}),
    ...(typeof data.accessAction === "string" && data.accessAction.length > 0 ? { accessAction: data.accessAction } : {}),
    ...(typeof data.contextCwd === "string" && data.contextCwd.length > 0 ? { contextCwd: data.contextCwd } : {}),
    ...(noteHashes === undefined ? {} : { noteHashes }),
    ...(typeof data.model === "string" && data.model.length > 0 ? { model: data.model } : {}),
    ...(typeof data.effort === "string" && data.effort.length > 0 ? { effort: data.effort } : {}),
    ...(typeof data.effortDefault === "string" && data.effortDefault.length > 0 ? { effortDefault: data.effortDefault } : {}),
    ...(typeof data.lastModel === "string" && data.lastModel.length > 0 ? { lastModel: data.lastModel } : {}),
    ...(typeof data.costMicros === "number" && Number.isFinite(data.costMicros) ? { costMicros: data.costMicros } : {}),
    ...(isCostQuality(data.costQuality) ? { costQuality: data.costQuality } : {}),
    ...(tokens === undefined ? {} : { tokens }),
    ...(data.tokensIncomplete === true ? { tokensIncomplete: true as const } : {}),
    ...(scheduled === undefined ? {} : { scheduled }),
    ...(data.run === true ? { run: true as const } : {}),
  };
}

/**
 * The chat a client with no chosen chat returns to, on one parent (a bot): the
 * newest open chat bound to a channel when there is one, else the newest open
 * chat; a chat a scheduled prompt opened is never the main one. Newest is the
 * largest id. Undefined when the parent has no open chat. The routine delivery
 * reads the same rule.
 */
export async function mainChatOf(store: ObjectStore, parent: string): Promise<string | undefined> {
  let bound: string | undefined;
  let latest: string | undefined;
  let cursor: string | undefined;
  do {
    const page = await store.list(CHAT_TYPE, { where: { parent }, ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      const data = chatData(object.data);
      if (data.parent !== parent || data.closed || data.scheduled !== undefined) continue;
      if (latest === undefined || object.id > latest) latest = object.id;
      if (data.channels.length > 0 && (bound === undefined || object.id > bound)) bound = object.id;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return bound ?? latest;
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
  // A row reads only the stored chat, so it shows the effort the chat itself
  // chose; the agent's live default is not a choice and may have changed since.
  const effort = chosenEffort(chat);
  return [
    chat.harness,
    ...(model === undefined || model.length === 0 ? [] : [model]),
    ...(effort === undefined ? [] : [effort]),
    ...(chat.costMicros === undefined ? [] : [costText(chat.costMicros, chat.costQuality)]),
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** The four token counts of a usage, when all are known and at least one is not zero. */
function usageTokensOf(value: unknown): UsageTokens | undefined {
  if (!isRecord(value)) return undefined;
  const count = (key: string): number | undefined => {
    const found = value[key];
    return typeof found === "number" && Number.isInteger(found) && found >= 0 ? found : undefined;
  };
  const input = count("input");
  const output = count("output");
  const cacheread = count("cacheread");
  const cachewrite = count("cachewrite");
  if (input === undefined || output === undefined || cacheread === undefined || cachewrite === undefined) {
    return undefined;
  }
  // A harness that reports no token counts gives all four as zero.
  if (input === 0 && output === 0 && cacheread === 0 && cachewrite === 0) return undefined;
  return { input, output, cacheread, cachewrite };
}

/** What a reply records about the context it ended with. */
export interface ReplyContext {
  readonly used: number;
  readonly window?: number | undefined;
}

/** What a chat's view says about its context: the last reply's numbers and model. */
export interface ChatContext extends ReplyContext {
  readonly model?: string | undefined;
}

/** The context numbers a harness or a stored reply reports, when they are whole. */
export function replyContextOf(value: unknown): ReplyContext | undefined {
  if (!isRecord(value)) return undefined;
  const used = value.used;
  if (typeof used !== "number" || !Number.isInteger(used) || used < 0) return undefined;
  const window = value.window;
  const known = typeof window === "number" && Number.isInteger(window) && window > 0 ? window : undefined;
  return { used, ...(known === undefined ? {} : { window: known }) };
}

/** The model, tokens, cost and quality a harness's `usage` reports; each only when it did. */
export function usageOf(value: unknown): {
  readonly model?: string;
  readonly costMicros?: number;
  readonly costQuality?: CostQuality;
  readonly tokens?: UsageTokens;
} {
  if (!isRecord(value)) return {};
  const micros = value.costMicros;
  const known = typeof micros === "number" && Number.isFinite(micros);
  const tokens = usageTokensOf(value.tokens);
  return {
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(known ? { costMicros: micros } : {}),
    ...(known ? { costQuality: isCostQuality(value.costQuality) ? value.costQuality : "estimated" } : {}),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

/** The timings a harness's step data reports; undefined when it has none or not a whole one. */
export function timingsOf(value: unknown): AgentTimings | undefined {
  if (!isRecord(value)) return undefined;
  const total = value.totalMs;
  if (typeof total !== "number" || !Number.isFinite(total)) return undefined;
  const duration = (key: string): number | null => {
    const at = value[key];
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  };
  return {
    startToReadyMs: duration("startToReadyMs"),
    readyToFirstMs: duration("readyToFirstMs"),
    totalMs: total,
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
async function nextChatId(store: ObjectStore, prefix: "C" | "R" = "C"): Promise<string> {
  let highest = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      const match = /^([CR])-(\d+)$/.exec(object.id);
      if (match !== null && match[1] === prefix) highest = Math.max(highest, Number(match[2]));
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
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
  const accessLevel =
    input.accessLevel ??
    input.accessDefault ??
    (input.access?.readOnly === true ? "plan" : "ask");
  const accessDefault = input.accessDefault ?? accessLevel;
  const data: ChatData = {
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    harness: input.harness,
    cwd: input.cwd,
    access: input.access ?? {},
    accessLevel,
    accessDefault,
    skills: input.skills ?? [],
    title: input.title.trim(),
    closed: false,
    session: null,
    channels: input.channels ?? [],
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.effortDefault === undefined ? {} : { effortDefault: input.effortDefault }),
    ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
    ...(input.accessAction === undefined ? {} : { accessAction: input.accessAction }),
    ...(input.scheduled === undefined ? {} : { scheduled: input.scheduled }),
    ...(input.run === true ? { run: true as const } : {}),
  };
  const prefix = input.run === true ? "R" : "C";
  // The id counts up; a taken one (two chats made at once) moves on to the next.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = await nextChatId(store, prefix);
    const id = `${prefix}-${String(Number(base.slice(2)) + attempt).padStart(4, "0")}`;
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
  const timings = timingsOf(data.timings);
  const tokens = usageTokensOf(data.tokens);
  const context = replyContextOf(data.context);
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
    ...(data.role === "user" && typeof data.instruction === "string" && data.instruction.length > 0
      ? { instruction: data.instruction }
      : {}),
    ...(typeof data.runId === "string" && data.runId.length > 0 ? { runId: data.runId } : {}),
    ...(typeof data.session === "string" ? { session: data.session } : {}),
    ...(typeof data.model === "string" && data.model.length > 0 ? { model: data.model } : {}),
    ...(typeof data.costMicros === "number" && Number.isFinite(data.costMicros) ? { costMicros: data.costMicros } : {}),
    ...(isCostQuality(data.costQuality) ? { costQuality: data.costQuality } : {}),
    ...(tokens === undefined ? {} : { tokens }),
    ...(context === undefined ? {} : { context }),
    ...(timings === undefined ? {} : { timings }),
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
  if (kind !== "text" && kind !== "thinking" && kind !== "tool" && kind !== "stopped" && kind !== "failure" && kind !== "worktree") return undefined;
  const entryKind: EntryKind = kind;
  const base = {
    runId: data.runId,
    kind: entryKind,
    at: fact.at,
    sequence: fact.sequence,
    ...(typeof data.startedAt === "number" || data.startedAt === null ? { startedAt: data.startedAt } : {}),
    ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
    ...(typeof data.messageId === "string" ? { messageId: data.messageId } : {}),
    ...(data.interrupted === true ? { interrupted: true } : {}),
  };
  if (entryKind === "tool") {
    if (!isToolResult(data.result)) return undefined;
    return {
      ...base,
      // An older or partly written entry may have no id or name; it still ran,
      // so it is shown as a tool rather than dropped from the transcript.
      callId: typeof data.callId === "string" ? data.callId : "",
      toolName: typeof data.toolName === "string" && data.toolName.length > 0 ? data.toolName : "tool",
      ...(typeof data.input === "string" || data.input === null ? { input: data.input } : {}),
      result: data.result,
      ...(typeof data.durationMs === "number" && Number.isFinite(data.durationMs) ? { durationMs: data.durationMs } : {}),
      ...(typeof data.output === "string" || data.output === null ? { output: data.output } : {}),
      ...(typeof data.outputPath === "string" ? { outputPath: data.outputPath } : {}),
      ...(data.outputTruncated === true ? { outputTruncated: true } : {}),
      ...(typeof data.error === "string" || data.error === null ? { error: data.error } : {}),
    };
  }
  return typeof data.text === "string" ? { ...base, text: data.text } : undefined;
}

/** The messages among a chat's facts, with a person's changed text and withdrawal. */
function messagesOfFacts(facts: readonly PluginFact[]): readonly Message[] {
  const changes = messageChangesOf(facts);
  const messages: Message[] = [];
  for (const fact of facts) {
    const message = messageOfFact(fact);
    if (message === undefined) continue;
    if (message.role !== "user") {
      messages.push(message);
      continue;
    }
    const change = changes.get(message.id);
    if (change?.withdrawn !== undefined) continue;
    messages.push(change?.text === undefined ? message : { ...message, text: change.text });
  }
  return messages;
}

/** The entries among a chat's facts. */
function entriesOfFacts(facts: readonly PluginFact[]): readonly Entry[] {
  const found: Entry[] = [];
  for (const fact of facts) {
    const entry = entryOfFact(fact);
    if (entry !== undefined) found.push(entry);
  }
  return found;
}

/** Every message of a chat in force, oldest first: changed text, and no withdrawn message. */
export function allMessages(store: ObjectStore, chat: string): readonly Message[] {
  return messagesOfFacts(chatFacts(store, chat));
}

/** Every entry of a chat, oldest first. */
export function allEntries(store: ObjectStore, chat: string): readonly Entry[] {
  return entriesOfFacts(chatFacts(store, chat));
}

/** Every fact of one object, oldest first. */
export function factsOf(store: ObjectStore, ref: ObjectRef): readonly PluginFact[] {
  const facts: PluginFact[] = [];
  let cursor: string | undefined;
  do {
    const page = store.facts(ref, { ...(cursor === undefined ? {} : { cursor }), limit: 500 });
    facts.push(...page.facts);
    cursor = page.next;
  } while (cursor !== undefined);
  return facts;
}

/** Every fact of a chat, oldest first. */
export function chatFacts(store: ObjectStore, chat: string): readonly PluginFact[] {
  return factsOf(store, chatRef(chat));
}

/** Everything a reader needs from a chat's facts, from one scan. */
export interface ChatRead {
  readonly facts: readonly PluginFact[];
  readonly messages: readonly Message[];
  readonly entries: readonly Entry[];
}

/** Reads a chat's facts once and derives its messages and entries from them. */
export function readChat(store: ObjectStore, chat: string): ChatRead {
  const facts = chatFacts(store, chat);
  return {
    facts,
    messages: messagesOfFacts(facts),
    entries: entriesOfFacts(facts),
  };
}

/** The run id of the latest reply run recorded on a chat, if any. */
export function latestRunOf(facts: readonly PluginFact[]): string | undefined {
  let found: string | undefined;
  for (const fact of facts) {
    if (fact.type === RUN_FACT && typeof fact.data.runId === "string" && fact.data.runId.length > 0) {
      found = fact.data.runId;
    }
  }
  return found;
}

/** A reply run that is being written: its run id and when it began. */
export interface WritingReply {
  readonly runId: string;
  readonly since: number;
}

/**
 * The reply being written, if one is. The latest `chat.run` fact starts an
 * attempt; a failure entry, a stopped half reply or a successful `/stop` for
 * that run ends it. A reply for that run with no messages still unanswered also
 * ends it; with messages unanswered the flow is going round again. The answer
 * reads the chat's facts, so it works while the reply runs and costs no tokens.
 */
export function writingReply(
  facts: readonly PluginFact[],
  messages: readonly Message[],
  entries: readonly Entry[],
): WritingReply | undefined {
  let runId: string | undefined;
  let since: number | undefined;
  let started = -1;
  for (const fact of facts) {
    if (fact.type === RUN_FACT && typeof fact.data.runId === "string" && fact.data.runId.length > 0) {
      runId = fact.data.runId;
      since = fact.at;
      started = fact.sequence;
    }
  }
  if (runId === undefined || since === undefined) return undefined;
  const ended = entries.some(
    (entry) => (entry.kind === "failure" || entry.kind === "stopped") && entry.runId === runId,
  );
  const stopped = facts.some((fact) => {
    if (fact.sequence <= started) return false;
    return stopOfFact(fact)?.runId === runId;
  });
  // A `/compact` run has no reply: its own done fact ends it.
  const compacted = facts.some((fact) => fact.type === COMPACT_FACT && fact.data.kind === "done" && fact.data.runId === runId);
  if (ended || stopped || compacted) return undefined;
  const replied = messages.some((message) => message.role === "assistant" && message.runId === runId);
  // The flow goes round again while messages arrived during the reply: a reply
  // for this run with messages still unanswered is the next round, not an end.
  if (!replied || unanswered(messages, facts).length > 0) return { runId, since };
  return undefined;
}

/**
 * The reply being written now: as {@link writingReply}, unless the host says the
 * latest run has ended. A host that cannot tell leaves the fact-only answer as
 * it was.
 */
export async function writingReplyNow(
  facts: readonly PluginFact[],
  messages: readonly Message[],
  entries: readonly Entry[],
  runs?: Pick<RunControl, "active"> | undefined,
): Promise<WritingReply | undefined> {
  const writing = writingReply(facts, messages, entries);
  if (writing === undefined || runs === undefined) return writing;
  const active = await runs.active(writing.runId);
  return active === false ? undefined : writing;
}

/** The time from a reply's start to its first output, when its timings hold both parts. */
export function firstOutputMs(timings: AgentTimings | undefined): number | undefined {
  if (timings === undefined || timings.startToReadyMs === null || timings.readyToFirstMs === null) {
    return undefined;
  }
  return timings.startToReadyMs + timings.readyToFirstMs;
}

/** How the last attempt at a reply ended: a normal reply, a failure, a stopped half reply, or none yet. */
export interface ReplyOutcome {
  readonly kind: "normal" | "failed" | "stopped" | "none";
  /** The reply run whose reply, failure or stopped half reply it was. */
  readonly runId?: string | undefined;
}

/**
 * The outcome of the last reply attempt. A normal reply, a failure entry and a
 * stopped half reply are the ways an attempt can end; the newest of them wins,
 * so a message that arrived after a stopped reply does not hide the stop.
 */
export function lastReplyOutcome(
  messages: readonly Message[],
  entries: readonly Entry[],
): ReplyOutcome {
  let kind: ReplyOutcome["kind"] = "none";
  let runId: string | undefined;
  let sequence = -1;
  for (const message of messages) {
    if (message.role !== "assistant" || message.sequence <= sequence) continue;
    kind = "normal";
    sequence = message.sequence;
    runId = message.runId;
  }
  for (const entry of entries) {
    if ((entry.kind !== "failure" && entry.kind !== "stopped") || entry.sequence <= sequence) continue;
    kind = entry.kind === "failure" ? "failed" : "stopped";
    sequence = entry.sequence;
    runId = entry.runId;
  }
  return { kind, ...(runId === undefined ? {} : { runId }) };
}

/**
 * The person's messages no assistant message answers yet, oldest first. A
 * `chat.answered` fact also answers messages an attempt took before it ended
 * without a reply message.
 */
export function unanswered(
  messages: readonly Message[],
  facts: readonly PluginFact[] = [],
): readonly Message[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const id of message.replyTo ?? []) answered.add(id);
    }
  }
  const withdrawn = new Set<string>();
  for (const fact of facts) {
    for (const id of takenOfFact(fact)) {
      if (fact.type === ANSWER_FACT) answered.add(id);
    }
    const change = messageChangeOfFact(fact);
    if (change?.kind === "withdraw") withdrawn.add(change.id);
  }
  return messages.filter(
    (message) => message.role === "user" && !answered.has(message.id) && !withdrawn.has(message.id),
  );
}

/** The sequence of the latest `/new` on a chat, or -1 when it has had none. */
export function newSessionAt(facts: readonly PluginFact[]): number {
  let at = -1;
  for (const fact of facts) if (fact.type === NEW_FACT && fact.sequence > at) at = fact.sequence;
  return at;
}

/** The goal of the latest `/new`, when it had one and no brief has been recorded for it yet. */
export function briefDue(
  facts: readonly PluginFact[],
): { readonly goal: string; readonly from: string | undefined; readonly sequence: number } | undefined {
  let due: { readonly goal: string; readonly from: string | undefined; readonly sequence: number } | undefined;
  for (const fact of facts) {
    if (fact.type === NEW_FACT) {
      const goal = typeof fact.data.goal === "string" ? fact.data.goal.trim() : "";
      const from = typeof fact.data.from === "string" && fact.data.from.length > 0 ? fact.data.from : undefined;
      due = goal.length === 0 ? undefined : { goal, from, sequence: fact.sequence };
    } else if (fact.type === BRIEF_FACT) {
      due = undefined;
    }
  }
  return due;
}

/**
 * The text the new session starts with: the brief of the latest `/new`, until
 * a reply has been written after it. Undefined when the latest `/new` had no goal.
 */
export function briefToCarry(messages: readonly Message[], facts: readonly PluginFact[]): string | undefined {
  let found: PluginFact | undefined;
  for (const fact of facts) {
    if (fact.type === NEW_FACT) found = undefined;
    else if (fact.type === BRIEF_FACT) found = fact;
  }
  if (found === undefined) return undefined;
  const at = found.sequence;
  if (messages.some((message) => message.role === "assistant" && message.sequence > at)) return undefined;
  const text = typeof found.data.text === "string" ? found.data.text.trim() : "";
  const goal = typeof found.data.goal === "string" ? found.data.goal.trim() : "";
  const failed = typeof found.data.failed === "string" ? found.data.failed : undefined;
  const lead = "This is a new session of an existing chat.";
  const body =
    text.length > 0
      ? `${lead} Brief of the earlier session:\n\n${text}`
      : `${lead} A brief of the earlier session could not be made${failed === undefined ? "" : ` (${failed})`}.`;
  return goal.length === 0 ? body : `${body}\n\nGoal for this session: ${goal}`;
}

/**
 * Whether the next prompt is the first of a session a `/new` started: a `/new`
 * is on record and no reply has come since. A reply that failed leaves it true,
 * so the retry still carries the pointer the agent has not yet seen.
 */
export function startsAfterNew(facts: readonly PluginFact[], messages: readonly Message[]): boolean {
  const since = newSessionAt(facts);
  if (since < 0) return false;
  return !messages.some((message) => message.role === "assistant" && message.sequence > since);
}

/**
 * The harness session after the last reply, else the chat's own reference. A
 * reply from before the latest `/new` is not the session in force.
 */
export function currentSession(
  chat: ChatData,
  messages: readonly Message[],
  facts: readonly PluginFact[] = [],
): string | undefined {
  const since = newSessionAt(facts);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.sequence < since) break;
    if (message.role === "assistant" && message.session !== undefined) return message.session;
  }
  return typeof chat.session === "string" && chat.session.length > 0 ? chat.session : undefined;
}

/**
 * The context a chat's view shows: the last finished reply's numbers, and the
 * model that gave it. A reply from before the chat's current session is left
 * out, so `/new` or a model change that starts a session clears the view until
 * the next reply.
 */
export function lastReplyContext(
  chat: ChatData,
  messages: readonly Message[],
  facts: readonly PluginFact[] = [],
): ChatContext | undefined {
  let last: Message | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    last = message;
    break;
  }
  if (last?.context === undefined || last.sequence < newSessionAt(facts)) return undefined;
  if ((chat.session ?? undefined) !== (last.session ?? undefined)) return undefined;
  const model = last.model ?? chat.model ?? chat.lastModel;
  return {
    used: last.context.used,
    ...(last.context.window === undefined ? {} : { window: last.context.window }),
    ...(model === undefined || model.length === 0 ? {} : { model }),
  };
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

/** How {@link promptFor} separates one unanswered message from the next. */
export const PROMPT_MESSAGE_SEPARATOR = "\n\n---\n\n";

/**
 * The prompt for the messages to answer, built from facts alone. Each message
 * is its own block, so two messages never read as one; a message's files
 * follow its text as paths, and `images` are the paths also given as image input.
 */
export function promptFor(pending: readonly Message[], images: ReadonlySet<string> = new Set()): string {
  const parts = pending.map((message) =>
    [message.text, attachmentLines(message, images), typeof message.instruction === "string" ? message.instruction : ""].filter((part) => part.length > 0).join("\n\n"),
  );
  return parts.join(PROMPT_MESSAGE_SEPARATOR);
}

/** One agent's choices for a new chat: what it lists, and what a chat starts with when none is asked for. */
export interface AgentChoices {
  readonly name: string;
  readonly models: HarnessModels | undefined;
  readonly efforts: { readonly list: readonly string[]; readonly default: string | null } | undefined;
  /** A configured model (a bot's); it is the default only for the agent that lists it. */
  readonly preferredModel?: string | null | undefined;
  /** A configured effort (a bot's); it is the default only for the agent that lists it. */
  readonly preferredEffort?: string | null | undefined;
}

/**
 * The conditionals of a new-chat form: one `if agent is X then model and effort
 * are X's` per agent, in standard JSON Schema (`allOf` of `if`/`then`). The
 * default is the configured value when the agent lists it, else the agent's
 * default. An agent that lists none gets no property in its `then`: nothing can
 * be picked for it. The kernel does not evaluate them; the action refuses a
 * value the agent does not list by name when it runs.
 */
export function agentConditionals(agents: readonly AgentChoices[]): ActionArgSchema[] {
  const pick = (
    list: readonly string[],
    preferred: string | null | undefined,
    fallback: string | null | undefined,
  ): Record<string, unknown> => {
    if (list.length === 0) return {};
    const chosen = preferred !== null && preferred !== undefined && list.includes(preferred) ? preferred : fallback;
    return { enum: [...list], ...(chosen === null || chosen === undefined ? {} : { default: chosen }) };
  };
  return agents.map((agent) => {
    const list = modelIds(agent.models);
    const model = pick(list, agent.preferredModel, agent.models?.default);
    const info =
      agent.models?.info === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(agent.models.info).filter(([id]) => list.includes(id)),
          );
    const effort = pick(agent.efforts?.list ?? [], agent.preferredEffort, agent.efforts?.default);
    return {
      if: { properties: { agent: { const: agent.name } }, required: ["agent"] },
      then: {
        properties: {
          ...(Object.keys(model).length === 0
            ? {}
            : { model: { type: "string", ...model, ...(info === undefined ? {} : { info }) } }),
          ...(Object.keys(effort).length === 0 ? {} : { effort: { type: "string", ...effort } }),
        },
      },
    } as ActionArgSchema;
  });
}
