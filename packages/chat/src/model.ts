/** The shape of a chat and its messages, and how a chat is read from its facts. */

import { randomUUID } from "node:crypto";
import type { JsonValue, ObjectRef, ObjectStore, PluginFact } from "@operad-io/engine";
import { isRecord, stringList } from "@operad-io/engine";

/** The object type of a chat. */
export const CHAT_TYPE = "chat";

/** The fact type of one message on a chat; a person's and the assistant's alike. */
export const MESSAGE_FACT = "chat.message";

/** The event type a new message is: its source is `ios`, `telegram` or `cli`. */
export const MESSAGE_EVENT = "message";

/** Where a message can come from. */
export const CHAT_SOURCES = ["ios", "telegram", "cli"] as const;

export type ChatSource = (typeof CHAT_SOURCES)[number];

/** Who wrote a message: the person, or the assistant. */
export type MessageRole = "user" | "assistant";

/** What a chat stores. The creating plugin gives every field but `session`. */
export interface ChatData {
  readonly [key: string]: unknown;
  /** The object one level up (a repository, a profile); a full object id. */
  readonly parent?: string | undefined;
  /** The harness plugin that answers, such as `harness-claude`; fixed once the chat exists. */
  readonly harness: string;
  /** Where the harness works. */
  readonly cwd: string;
  /** The access profile the harness applies; opaque here. */
  readonly access: Readonly<Record<string, JsonValue>>;
  readonly skills: readonly string[];
  readonly title: string;
  /** The harness's own reference to its conversation; never shown. */
  readonly session?: string | null | undefined;
  /** The channels (`telegram:<chat>`) whose messages land here. */
  readonly channels: readonly string[];
  /**
   * A step (`<plugin>/<step>`) that gives the working directory, access profile
   * and skills as they are now; the reply asks it every time, so a chat whose
   * settings live elsewhere (an assistant profile) follows them. The fields
   * above are then what the chat started with.
   */
  readonly refresh?: string | undefined;
}

/** What a plugin gives to create a chat. */
export interface NewChat {
  readonly parent?: string | undefined;
  readonly harness: string;
  readonly cwd: string;
  readonly access?: Readonly<Record<string, JsonValue>> | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly title: string;
  readonly channels?: readonly string[] | undefined;
  /** See {@link ChatData.refresh}. */
  readonly refresh?: string | undefined;
}

/** What a message fact holds. Attachment paths stay empty until attachments exist. */
export interface MessageData {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly role: MessageRole;
  readonly from: { readonly via: string; readonly id: string };
  readonly text: string;
  readonly attachments: readonly string[];
  /** Where it came from, and its id there (a Telegram message id), when it has one. */
  readonly source: { readonly kind: string; readonly ref: string | null };
  /** An assistant message: the ids of the messages it answers. */
  readonly replyTo?: readonly string[] | undefined;
  /** An assistant message: the harness session after it. */
  readonly session?: string | undefined;
}

/** One message with when it was recorded. */
export interface Message extends MessageData {
  readonly at: number;
  readonly sequence: number;
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
    channels: stringList(data.channels),
    ...(typeof data.refresh === "string" && data.refresh.length > 0 ? { refresh: data.refresh } : {}),
  };
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
  if (input.harness.trim().length === 0) throw new Error("a chat needs a harness");
  if (input.cwd.trim().length === 0) throw new Error("a chat needs a working directory");
  if (input.title.trim().length === 0) throw new Error("a chat needs a title");
  const data: ChatData = {
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    harness: input.harness,
    cwd: input.cwd,
    access: input.access ?? {},
    skills: input.skills ?? [],
    title: input.title.trim(),
    session: null,
    channels: input.channels ?? [],
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
    attachments: stringList(data.attachments),
    source: {
      kind: typeof source.kind === "string" ? source.kind : "",
      ref: typeof source.ref === "string" ? source.ref : null,
    },
    ...(Array.isArray(data.replyTo) ? { replyTo: stringList(data.replyTo) } : {}),
    ...(typeof data.session === "string" ? { session: data.session } : {}),
    at: fact.at,
    sequence: fact.sequence,
  };
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

/** The prompt for the messages to answer, built from facts alone. */
export function promptFor(pending: readonly Message[]): string {
  if (pending.length === 1) return pending[0]?.text ?? "";
  return pending.map((message) => message.text).join("\n\n");
}
