/** How a chat shows in a list and on its page: a row and a transcript. */

import type {
  ObjectRow,
  ObjectViews,
  SectionContent,
  SectionPage,
  StoredObject,
  ViewContext,
  ViewSection,
} from "@operad-io/engine";
import { chatData, chatRef, MESSAGE_FACT, type Message } from "./model.ts";

/** How many facts of a chat one page of the transcript reads. */
export const TRANSCRIPT_PAGE = 50;

/** How a transcript labels the model's messages when nothing sets a speaker. */
export const DEFAULT_SPEAKER = "Operad Bot";

/** The one section of a chat. */
export const TRANSCRIPT = "transcript";

function row(object: StoredObject): ObjectRow {
  const chat = chatData(object.data);
  return {
    id: object.id,
    title: chat.title.length > 0 ? chat.title : object.id,
    state: chat.closed ? "closed" : "open",
    ...(chat.closed ? { final: true } : {}),
    ...(typeof chat.parent === "string" && chat.parent.length > 0 ? { parent: chat.parent } : {}),
  };
}

function sections(): readonly ViewSection[] {
  return [{ id: TRANSCRIPT, title: "Transcript", live: true }];
}

function minute(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

/** One message as Markdown: who, when and where from, then the text. */
export function messageMarkdown(message: Message, speaker: string = DEFAULT_SPEAKER): string {
  const who = message.role === "assistant" ? speaker : "you";
  const via = message.role === "user" && message.source.kind.length > 0 ? ` via ${message.source.kind}` : "";
  return `**${who}**${via} · ${minute(message.at)}\n\n${message.text}`;
}

/**
 * How the transcript labels the model's messages now. The chat's own setting
 * applies; a parent object that names a speaker (a bot) speaks for its chats.
 * It is read at every draw, so a changed name shows on the messages already
 * recorded too.
 */
async function speakerOf(ctx: ViewContext, object: StoredObject): Promise<string> {
  const parent = chatData(object.data).parent;
  if (parent !== undefined) {
    const at = parent.indexOf(":");
    if (at > 0 && at < parent.length - 1) {
      const owner = ctx.refreshedObject === undefined
        ? await ctx.store.get(parent.slice(0, at), parent.slice(at + 1))
        : await ctx.refreshedObject(parent.slice(0, at), parent.slice(at + 1));
      const speaker = owner?.data.speaker;
      if (typeof speaker === "string" && speaker.length > 0) return speaker;
    }
  }
  const settings = ctx.settingsInForce === undefined
    ? ctx.settings
    : ctx.settingsInForce(ctx.plugin);
  const speaker = settings.speaker;
  return typeof speaker === "string" && speaker.length > 0 ? speaker : DEFAULT_SPEAKER;
}

function messageFrom(fact: {
  readonly data: Readonly<Record<string, unknown>>;
  readonly at: number;
  readonly sequence: number;
}): Message | undefined {
  const data = fact.data;
  if (typeof data.id !== "string" || typeof data.text !== "string") return undefined;
  if (data.role !== "user" && data.role !== "assistant") return undefined;
  const source = typeof data.source === "object" && data.source !== null ? (data.source as Record<string, unknown>) : {};
  return {
    id: data.id,
    role: data.role,
    from: { via: "", id: "" },
    text: data.text,
    attachments: [],
    source: {
      kind: typeof source.kind === "string" ? source.kind : "",
      ref: typeof source.ref === "string" ? source.ref : null,
    },
    at: fact.at,
    sequence: fact.sequence,
  };
}

async function load(
  ctx: ViewContext,
  object: StoredObject,
  sectionId: string,
  options: { readonly cursor?: string | undefined },
): Promise<SectionContent> {
  if (sectionId !== TRANSCRIPT) return { markdown: "" };
  const ref = chatRef(object.id);
  const page = ctx.store.facts(ref, {
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: TRANSCRIPT_PAGE,
  });
  const speaker = await speakerOf(ctx, object);
  const blocks: string[] = [];
  for (const fact of page.facts) {
    if (fact.type !== MESSAGE_FACT) continue;
    const message = messageFrom(fact);
    if (message !== undefined) blocks.push(messageMarkdown(message, speaker));
  }
  const markdown = blocks.length === 0 && options.cursor === undefined ? "No messages yet." : blocks.join("\n\n---\n\n");

  // The table of contents: the cursor each page starts at, the first one without.
  const pages: SectionPage[] = [{ label: "Page 1" }];
  let cursor = ctx.store.facts(ref, { limit: TRANSCRIPT_PAGE }).next;
  while (cursor !== undefined) {
    pages.push({ label: `Page ${pages.length + 1}`, cursor });
    cursor = ctx.store.facts(ref, { cursor, limit: TRANSCRIPT_PAGE }).next;
  }
  return {
    markdown,
    ...(page.next === undefined ? {} : { next: page.next }),
    ...(pages.length > 1 ? { pages } : {}),
  };
}

/** The views of the chat type. */
export const chatViews: ObjectViews = { row, sections, load };
