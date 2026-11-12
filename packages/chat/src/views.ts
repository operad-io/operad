/** How a chat shows in a list and on its page: a row and a transcript. */

import { attachmentUrl, decodeCursor, encodeCursor } from "@operad-io/engine";
import type {
  ObjectRef,
  ObjectRow,
  ObjectViews,
  PluginFact,
  SectionContent,
  SectionPage,
  StoredObject,
  ViewContext,
  ViewSection,
} from "@operad-io/engine";
import { agentLine, attachmentsOf, chatData, chatRef, ENTRY_FACT, entryOfFact, IMAGE_TYPES, MESSAGE_FACT, modelAndCost, type Attachment, type Entry, type Message } from "./model.ts";

/** How many messages of a chat one page of the transcript holds. */
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
    ...(chat.harness.length > 0 ? { note: agentLine(chat) } : {}),
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

/** A path as a Markdown link destination: spaces and parentheses are escaped. */
function destination(path: string, home: string | undefined): string {
  // A client fetches the file from the server, so the link is the server's attachment address.
  const url = home === undefined ? undefined : attachmentUrl(home, path);
  return (url ?? encodeURI(path)).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** One attachment as a line: an image is shown as an image, another file as a link. */
function attachmentMarkdown(file: Attachment, home: string | undefined): string {
  const target = destination(file.path, home);
  if ((IMAGE_TYPES as readonly string[]).includes(file.type)) return `![${file.name}](${target})`;
  return `Attachment: [${file.name}](${target})`;
}

/** One message as Markdown: who, when and where from, then the text. */
export function messageMarkdown(message: Message, speaker: string = DEFAULT_SPEAKER, home?: string): string {
  const who = message.role === "assistant" ? speaker : "you";
  const via = message.role === "user" && message.source.kind.length > 0 ? ` via ${message.source.kind}` : "";
  const head = `**${who}**${via} · ${minute(message.at)}`;
  const used = message.role === "assistant" ? modelAndCost(message.model, message.costMicros, message.costQuality) : [];
  const under = used.length > 0 ? `*${used.join(" · ")}*` : "";
  const body = [message.text, ...message.attachments.map((file) => attachmentMarkdown(file, home)), under].filter((part) => part.length > 0);
  return [head, ...body].join("\n\n");
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
    attachments: attachmentsOf(data.attachments),
    source: {
      kind: typeof source.kind === "string" ? source.kind : "",
      ref: typeof source.ref === "string" ? source.ref : null,
    },
    ...(typeof data.runId === "string" && data.runId.length > 0 ? { runId: data.runId } : {}),
    ...(typeof data.model === "string" && data.model.length > 0 ? { model: data.model } : {}),
    ...(typeof data.costMicros === "number" && Number.isFinite(data.costMicros) ? { costMicros: data.costMicros } : {}),
    ...(data.costQuality === "exact" || data.costQuality === "estimated" || data.costQuality === "incomplete"
      ? { costQuality: data.costQuality }
      : {}),
    at: fact.at,
    sequence: fact.sequence,
  };
}

function seconds(ms: number): string {
  if (ms < 1000) return "<1s";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes === 0 ? `${total}s` : `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function firstLine(text: string | null | undefined): string | undefined {
  const line = text?.split("\n")[0]?.trim();
  return line === undefined || line.length === 0 ? undefined : line;
}

/** One tool call as a log line: what ran, how long it took and how it ended. */
function toolMarkdown(entry: Entry): string {
  const name = entry.toolName ?? "tool";
  const took = entry.durationMs === undefined ? "" : ` ${seconds(entry.durationMs)}`;
  const input = entry.input === undefined || entry.input === null ? "" : flat(entry.input);
  const what = input.length === 0 ? "" : ` ${inlineCode(input.length <= 160 ? input : `${input.slice(0, 159)}…`)}`;
  const head = `tool ${name}${took}${what}`;
  if (entry.result === "failed") {
    const error = firstLine(entry.error);
    return error === undefined ? `${head} failed` : `${head} failed: ${error}`;
  }
  if (entry.result === "blocked") {
    const reason = firstLine(entry.error);
    return reason === undefined ? `${head} blocked` : `${head} blocked: ${reason}`;
  }
  if (entry.result === "denied") return `${head} denied`;
  return head;
}

/** One finished part of an answer as Markdown lines; tool output is never shown. */
function entryMarkdown(entry: Entry, speaker: string, harness: string): string | undefined {
  // Radian gives no text or thinking increments; its chats show the tool lines only.
  if (entry.kind !== "tool" && harness === "radian") return undefined;
  if (entry.kind === "tool") return toolMarkdown(entry);
  if (entry.text === undefined) return undefined;
  if (entry.kind === "thinking") {
    return entry.text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
  }
  const said = flat(entry.text);
  return said.length === 0 ? undefined : `**${speaker}:** ${said}`;
}

function allFacts(ctx: ViewContext, ref: ObjectRef): readonly PluginFact[] {
  const facts: PluginFact[] = [];
  let cursor: string | undefined;
  do {
    const page = ctx.store.facts(ref, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 500,
    });
    facts.push(...page.facts);
    cursor = page.next;
  } while (cursor !== undefined);
  return facts;
}

interface Chunk {
  readonly facts: readonly PluginFact[];
  /** How many messages, not entries, the chunk holds. */
  readonly messages: number;
  readonly last: number;
}

function chunkOf(facts: readonly PluginFact[]): Chunk {
  return {
    facts,
    messages: facts.filter((fact) => fact.type === MESSAGE_FACT).length,
    last: facts.at(-1)?.sequence ?? 0,
  };
}

/** A turn is the entries of a run and the reply they led to, so a page never splits them. */
function chunksOf(facts: readonly PluginFact[]): readonly Chunk[] {
  const replies = new Map<string, number[]>();
  const indexes = new Map<number, number>();
  facts.forEach((fact, index) => {
    indexes.set(fact.sequence, index);
    if (fact.type !== MESSAGE_FACT || fact.data.role !== "assistant" || typeof fact.data.runId !== "string") return;
    const list = replies.get(fact.data.runId) ?? [];
    list.push(fact.sequence);
    replies.set(fact.data.runId, list);
  });
  const nextReply = (runId: string, after: number): number | undefined =>
    replies.get(runId)?.find((sequence) => sequence > after);
  const chunks: Chunk[] = [];
  let index = 0;
  while (index < facts.length) {
    const fact = facts[index];
    if (fact === undefined) break;
    if (fact.type === ENTRY_FACT) {
      const runId = typeof fact.data.runId === "string" ? fact.data.runId : undefined;
      const reply = runId === undefined ? undefined : nextReply(runId, fact.sequence);
      if (reply !== undefined) {
        const end = indexes.get(reply) ?? facts.length - 1;
        chunks.push(chunkOf(facts.slice(index, end + 1)));
        index = end + 1;
        continue;
      }
      let end = index + 1;
      while (
        end < facts.length &&
        facts[end]?.type === ENTRY_FACT &&
        (runId === undefined || facts[end]?.data.runId === runId)
      ) {
        end += 1;
      }
      chunks.push(chunkOf(facts.slice(index, end)));
      index = end;
      continue;
    }
    if (fact.type === MESSAGE_FACT) chunks.push(chunkOf([fact]));
    index += 1;
  }
  return chunks;
}

interface Page {
  readonly chunks: readonly Chunk[];
  readonly after: number | undefined;
  readonly cursor: string | undefined;
}

function factsCursor(ref: ObjectRef, after: number): string {
  return encodeCursor({ kind: "facts", type: ref.type, id: ref.id, after });
}

/** Pages count messages; a turn is one item, so its entries stay with its reply. */
function pagesOf(ref: ObjectRef, chunks: readonly Chunk[]): readonly Page[] {
  const pages: Page[] = [];
  let index = 0;
  let after: number | undefined;
  while (index < chunks.length) {
    const pageChunks: Chunk[] = [];
    let messages = 0;
    while (index < chunks.length) {
      const chunk = chunks[index];
      if (chunk === undefined) break;
      if (pageChunks.length > 0 && messages + chunk.messages > TRANSCRIPT_PAGE) break;
      pageChunks.push(chunk);
      messages += chunk.messages;
      index += 1;
      if (messages >= TRANSCRIPT_PAGE) break;
    }
    const last = pageChunks.at(-1);
    if (last === undefined) break;
    pages.push({
      chunks: pageChunks,
      after,
      cursor: after === undefined ? undefined : factsCursor(ref, after),
    });
    after = last.last;
  }
  if (pages.length === 0) pages.push({ chunks: [], after: undefined, cursor: undefined });
  return pages;
}

function cursorAfter(cursor: string): number | undefined {
  const value = decodeCursor(cursor, "chat transcript");
  return value.kind === "facts" && typeof value.after === "number" ? value.after : undefined;
}

function rendered(chunk: Chunk, speaker: string, home: string | undefined, harness: string): readonly string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  const flush = (): void => {
    if (lines.length > 0) blocks.push(lines.join("\n"));
    lines = [];
  };
  for (const fact of chunk.facts) {
    if (fact.type === ENTRY_FACT) {
      const entry = entryOfFact(fact);
      const markdown = entry === undefined ? undefined : entryMarkdown(entry, speaker, harness);
      if (markdown !== undefined) lines.push(...markdown.split("\n"));
      continue;
    }
    if (fact.type !== MESSAGE_FACT) continue;
    flush();
    const message = messageFrom(fact);
    if (message !== undefined) blocks.push(messageMarkdown(message, speaker, home));
  }
  flush();
  return blocks;
}

async function load(
  ctx: ViewContext,
  object: StoredObject,
  sectionId: string,
  options: { readonly cursor?: string | undefined },
): Promise<SectionContent> {
  if (sectionId !== TRANSCRIPT) return { markdown: "" };
  const ref = chatRef(object.id);
  const chat = chatData(object.data);
  const speaker = await speakerOf(ctx, object);
  const pages = pagesOf(ref, chunksOf(allFacts(ctx, ref)));
  const after = options.cursor === undefined ? undefined : cursorAfter(options.cursor);
  const index = pages.findIndex((page) => page.after === after);
  const selected = pages[index < 0 ? 0 : index] ?? pages[0];
  const blocks = (selected?.chunks ?? []).flatMap((chunk) => rendered(chunk, speaker, ctx.home, chat.harness));
  const body = blocks.length === 0 && options.cursor === undefined ? "No messages yet." : blocks.join("\n\n---\n\n");
  // Every page says which agent answers, as the row does.
  const markdown = chat.harness.length > 0
    ? `Agent: ${agentLine(chat)}\n\n${body}`
    : body;
  const nextPage = index < 0 ? undefined : pages[index + 1];

  // The table of contents: the cursor each page starts at, the first one without.
  const toc: SectionPage[] = pages.map((page, at) =>
    at === 0 || page.cursor === undefined
      ? { label: `Page ${at + 1}` }
      : { label: `Page ${at + 1}`, cursor: page.cursor },
  );
  return {
    markdown,
    ...(nextPage?.cursor === undefined ? {} : { next: nextPage.cursor }),
    ...(toc.length > 1 ? { pages: toc } : {}),
  };
}

/** The views of the chat type. */
export const chatViews: ObjectViews = { row, sections, load };
