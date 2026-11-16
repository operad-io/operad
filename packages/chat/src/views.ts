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
import { maskSecrets, type FoldEntry } from "@operad-io/harness-process";
import { secretValues } from "./reply.ts";
import { foldLogTail, agentLogPath } from "./tail.ts";
import { agentLine, attachmentsOf, chatData, chatRef, COMMAND_FACT, commandOfFact, ENTRY_FACT, entryOfFact, IMAGE_TYPES, latestRunOf, MESSAGE_FACT, modelAndCost, stopOfFact, unanswered, type Attachment, type Command, type Entry, type Message } from "./model.ts";
import type { TailRead } from "./tail.ts";

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

/** One command as a transcript entry: who, the command and how it went. */
export function commandMarkdown(command: Command): string {
  const via = command.from.via.length > 0 ? ` via ${command.from.via}` : "";
  return `**you**${via} · ${minute(command.at)} — \`${command.command.replace(/`/g, "\\`")}\`\n\n${command.outcome}`;
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
    ...(Array.isArray(data.replyTo)
      ? { replyTo: data.replyTo.filter((id): id is string => typeof id === "string") }
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

/** What a tool line shows, whether it comes from a fact or from the log. */
interface ShownTool {
  readonly toolName?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly input?: string | null | undefined;
  readonly result?: string | undefined;
  readonly error?: string | null | undefined;
}

/** One tool call as a log line: what ran, how long it took and how it ended. */
function toolMarkdown(entry: ShownTool): string {
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
function entryMarkdown(entry: Entry | FoldEntry, speaker: string, harness: string): string | undefined {
  // A failure line is shown for every harness; it is already one plain line.
  if (entry.kind === "failure") {
    const said = flat(entry.text ?? "");
    return said.length === 0 ? undefined : said;
  }
  if (entry.kind === "worktree") {
    const said = flat(entry.text ?? "");
    return said.length === 0 ? undefined : said;
  }
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
  if (said.length === 0) return undefined;
  const body = `**${speaker}:** ${said}`;
  return entry.kind === "stopped" ? `${body}\n\n*stopped*` : body;
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
    messages: facts.filter((fact) => fact.type === MESSAGE_FACT || fact.type === COMMAND_FACT).length,
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
    if (fact.type === MESSAGE_FACT || fact.type === COMMAND_FACT) chunks.push(chunkOf([fact]));
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
    if (fact.type === COMMAND_FACT) {
      flush();
      const command = commandOfFact(fact);
      if (command !== undefined) blocks.push(commandMarkdown(command));
      continue;
    }
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

/** The position after the last fact a read showed, as the opaque mark. */
function markOf(sequence: number): string {
  return String(sequence);
}

function markAfter(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

/** What a live transcript says the reply is doing, and since when. */
interface SectionStatus {
  readonly text: string;
  readonly since: number;
}

/** The changing part of a transcript: its tail and what the reply is doing. */
interface Live {
  readonly tail?: string | undefined;
  readonly status?: SectionStatus | undefined;
}

/**
 * The person's messages a reply still owes an answer. A reply recorded before
 * `replyTo` existed answers every message before it, so an old snapshot that
 * ends with an assistant message is not left looking unanswered.
 */
function statusPending(messages: readonly Message[], facts: readonly PluginFact[]): readonly Message[] {
  const pending = unanswered(messages, facts);
  if (pending.length === 0) return pending;
  const legacy = messages.filter(
    (message) => message.role === "assistant" && (message.replyTo === undefined || message.replyTo.length === 0),
  );
  return pending.filter((message) => !legacy.some((reply) => reply.sequence > message.sequence));
}

/**
 * What the reply is doing, or undefined when nothing of it is in progress. A
 * question waiting for the person, a failure, a stop and a chat whose messages
 * are all answered say nothing. Before the log has the ready line, the first
 * message still unanswered is what the reply waits on.
 */
function statusOf(
  facts: readonly PluginFact[],
  pending: readonly Message[],
  runId: string | undefined,
  times: Awaited<ReturnType<NonNullable<ViewContext["runTimes"]>>>,
  read: TailRead | undefined,
  called: ReadonlySet<string>,
  secrets: readonly string[],
): SectionStatus | undefined {
  const newest = pending.at(-1);
  if (newest === undefined) return undefined;
  const last = times?.segments.at(-1);
  if (last?.person === true && last.to === null) return undefined;
  // A failure or stop after the newest message that still waits ends the
  // reply for it. A message that came later starts another reply.
  let ended = -1;
  if (runId !== undefined) {
    for (const fact of facts) {
      const entry = entryOfFact(fact);
      if (entry !== undefined && (entry.kind === "failure" || entry.kind === "stopped") && entry.runId === runId) {
        ended = Math.max(ended, entry.sequence);
      }
      if (stopOfFact(fact)?.runId === runId) ended = Math.max(ended, fact.sequence);
    }
  }
  if (ended >= newest.sequence) return undefined;
  const endedAt = times?.endedAt;
  if (endedAt !== null && endedAt !== undefined && newest.at <= endedAt) return undefined;
  const first = pending[0] ?? newest;
  if (read === undefined || !read.ready) return { text: "Starting", since: first.at };
  const open = read.state.calls.find((call) => !called.has(maskSecrets(call.callId, secrets)));
  if (open !== undefined) {
    return { text: `Running ${maskSecrets(open.toolName, secrets)}`, since: open.at };
  }
  return { text: "Thinking", since: read.lastAt ?? times?.startedAt ?? first.at };
}

/**
 * What the running reply has written and the facts do not hold yet, as
 * Markdown, or undefined when no reply runs. It is read from the end of the log
 * of the step that runs the agent. A finished entry stays here until the fact
 * that holds it is visible to the same read, so the text never has a gap. The
 * same read gives the status beside it.
 */
async function liveOf(
  ctx: ViewContext,
  object: StoredObject,
  facts: readonly PluginFact[],
  speaker: string,
): Promise<Live> {
  const chat = chatData(object.data);
  const runId = latestRunOf(facts);
  const messages = facts.map(messageFrom).filter((message): message is Message => message !== undefined);
  const pending = statusPending(messages, facts);
  const times = runId !== undefined && ctx.runTimes !== undefined ? await ctx.runTimes(runId) : undefined;
  let tail: string | undefined;
  let read: TailRead | undefined;
  let called: ReadonlySet<string> = new Set<string>();
  let secrets: readonly string[] = [];
  if (runId !== undefined && chat.harness.length > 0 && ctx.runTimes !== undefined && times !== undefined && times.endedAt === null) {
    secrets = await secretValues(ctx);
    const said = new Set<string>();
    const calls = new Set<string>();
    for (const fact of facts) {
      if (fact.data.runId !== runId) continue;
      if (fact.type === MESSAGE_FACT && fact.data.role === "assistant" && typeof fact.data.text === "string") {
        said.add(fact.data.text.trim());
      }
      const entry = fact.type === ENTRY_FACT ? entryOfFact(fact) : undefined;
      if (entry?.kind === "tool" && entry.callId !== undefined) calls.add(entry.callId);
      else if (entry?.text !== undefined) said.add(entry.text.trim());
    }
    called = calls;
    // The read drops a finished entry the facts already hold, so a long run does
    // not keep them all in the saved fold.
    const held = (entry: FoldEntry): boolean => {
      if (entry.kind === "tool") return calls.has(maskSecrets(entry.callId, secrets));
      return said.has(maskSecrets(entry.text, secrets).trim());
    };
    read = foldLogTail(agentLogPath(ctx.store.root, chat.harness, runId), held);
    if (read !== undefined) {
      const fresh = (text: string): string | undefined => {
        const masked = maskSecrets(text, secrets);
        return masked.trim().length === 0 || said.has(masked.trim()) ? undefined : masked;
      };
      const lines: string[] = [];
      // A finished entry is shown until the facts hold it; then `said` and `called` drop it.
      for (const entry of read.state.entries) {
        // Radian gives no text or thinking increments; its chats show tool lines only.
        if (chat.harness === "radian" && entry.kind !== "tool") continue;
        if (entry.kind === "tool") {
          if (calls.has(maskSecrets(entry.callId, secrets))) continue;
          const markdown = entryMarkdown(
            {
              ...entry,
              toolName: maskSecrets(entry.toolName, secrets),
              input: entry.input === null ? null : maskSecrets(entry.input, secrets),
              error: entry.error === null ? null : maskSecrets(entry.error, secrets),
            },
            speaker,
            chat.harness,
          );
          if (markdown !== undefined) lines.push(markdown);
          continue;
        }
        const text = fresh(entry.text);
        if (text === undefined) continue;
        const markdown = entryMarkdown({ ...entry, text }, speaker, chat.harness);
        if (markdown !== undefined) lines.push(markdown);
      }
      // Radian gives no text or thinking increments; its chats show the tool lines only.
      if (chat.harness !== "radian") {
        const thinking = fresh(read.state.thinking);
        if (thinking !== undefined) lines.push(thinking.split(/\r?\n/).map((line) => `> ${line}`).join("\n"));
        const text = fresh(read.state.text);
        if (text !== undefined) lines.push(`**${speaker}:** ${flat(text)}`);
      }
      for (const call of read.state.calls) {
        if (calls.has(maskSecrets(call.callId, secrets))) continue;
        const input = call.input === null ? "" : flat(maskSecrets(call.input, secrets));
        const what = input.length === 0 ? "" : ` ${inlineCode(input.length <= 160 ? input : `${input.slice(0, 159)}…`)}`;
        lines.push(`tool ${maskSecrets(call.toolName, secrets)} since ${clock(call.at)}${what}`);
      }
      tail = lines.length === 0 ? undefined : lines.join("\n\n");
    }
  }
  const status = statusOf(facts, pending, runId, times, read, called, secrets);
  return {
    ...(tail === undefined ? {} : { tail }),
    ...(status === undefined ? {} : { status }),
  };
}

async function load(
  ctx: ViewContext,
  object: StoredObject,
  sectionId: string,
  options: { readonly cursor?: string | undefined; readonly after?: string | undefined },
): Promise<SectionContent> {
  if (sectionId !== TRANSCRIPT) return { markdown: "" };
  const ref = chatRef(object.id);
  const chat = chatData(object.data);
  const speaker = await speakerOf(ctx, object);
  const facts = allFacts(ctx, ref);
  const live = await liveOf(ctx, object, facts, speaker);
  const since = markAfter(options.after);
  if (since !== undefined) {
    // Only what was recorded after the mark, in the same Markdown as a full read.
    const chunks = chunksOf(facts.filter((fact) => fact.sequence > since));
    const blocks = chunks.flatMap((chunk) => rendered(chunk, speaker, ctx.home, chat.harness));
    return {
      markdown: blocks.join("\n\n---\n\n"),
      mark: markOf(Math.max(since, chunks.at(-1)?.last ?? 0)),
      delta: true,
      ...live,
    };
  }
  const pages = pagesOf(ref, chunksOf(facts));
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
    mark: markOf(selected?.chunks.at(-1)?.last ?? 0),
    ...(nextPage?.cursor === undefined ? {} : { next: nextPage.cursor }),
    ...(toc.length > 1 ? { pages: toc } : {}),
    ...live,
  };
}

/** The views of the chat type. */
export const chatViews: ObjectViews = { row, sections, load };
