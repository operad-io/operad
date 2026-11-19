/** How a chat shows in a list and on its page: a row and a transcript. */

import { attachmentUrl, decodeCursor, encodeCursor } from "@operad-io/engine";
import type {
  JsonValue,
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
import { readChatSkills, skillSummaries, type ObjectReader } from "./skills.ts";
import { foldLogTail, agentLogPath } from "./tail.ts";
import { agentLine, allMessages, answeredOfFact, attachmentsOf, chatData, chatRef, COMMAND_FACT, commandOfFact, ENTRY_FACT, entryOfFact, IMAGE_TYPES, lastReplyContext, latestRunOf, MESSAGE_CHANGE_FACT, MESSAGE_FACT, messageChangeOfFact, messageFactsInForce, modelAndCost, queuedData, queuedMessages, queuedOf, RUN_FACT, stopOfFact, unanswered, ANSWER_FACT, type Attachment, type ChatContext, type Command, type Entry, type Message, type MessageChange } from "./model.ts";
import type { TailRead } from "./tail.ts";

/** How many messages of a chat one page of the transcript holds. */
export const TRANSCRIPT_PAGE = 50;

/** How a transcript labels the model's messages when nothing sets a speaker. */
export const DEFAULT_SPEAKER = "Operad Bot";

/** The one section of a chat. */
export const TRANSCRIPT = "transcript";

function row(object: StoredObject): ObjectRow {
  const chat = chatData(object.data);
  const note = [
    ...(chat.harness.length > 0 ? [agentLine(chat)] : []),
    ...(chat.accessLevel !== chat.accessDefault ? [chat.accessLevel ?? ""] : []),
  ].filter((part) => part.length > 0);
  const queued = queuedOf(object.data.queued);
  const data: Record<string, JsonValue> = {
    ...(chat.scheduled === undefined ? {} : { scheduled: chat.scheduled }),
    ...(queued.length === 0 ? {} : { queued: queued as unknown as JsonValue }),
  };
  return {
    id: object.id,
    title: chat.title.length > 0 ? chat.title : object.id,
    state: chat.closed ? "closed" : "open",
    ...(note.length === 0 ? {} : { note: note.join(" · ") }),
    ...(chat.closed ? { final: true } : {}),
    ...(typeof chat.parent === "string" && chat.parent.length > 0 ? { parent: chat.parent } : {}),
    ...(Object.keys(data).length === 0 ? {} : { data }),
  };
}

function sections(): readonly ViewSection[] {
  return [{ id: TRANSCRIPT, title: "Transcript", live: true }];
}

/** The context the chat's detail page and transcript show: its last finished reply's. */
async function chatContext(ctx: ViewContext, object: StoredObject): Promise<ChatContext | undefined> {
  return lastReplyContext(chatData(object.data), allMessages(ctx.store, object.id));
}

function minute(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

/** One command as a transcript entry: who, the command and how it went. */
export function commandMarkdown(command: Command): string {
  const via = command.from.via.length > 0 ? ` via ${command.from.via}` : "";
  return `**you**${via} · ${minute(command.at)} — \`${command.command.replace(/`/g, "\\`")}\`\n\n${command.outcome}`;
}

/** One withdrawn message as the history entry that says what happened to it. */
export function withdrawalMarkdown(change: MessageChange): string {
  const via = change.by.via.length > 0 ? ` via ${change.by.via}` : "";
  return `**you**${via} · ${minute(change.at)} — \`withdraw ${change.id}\`\n\nThe message was withdrawn and was not sent to the agent.`;
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

/** Text as a Markdown block: its lines stay, only the space around them goes. */
function block(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
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
  // The line a crash or restart leaves is shown for every harness, as a failure is.
  if (entry.kind === "stopped" && entry.interrupted === true) {
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
  const said = block(entry.text);
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

/** The facts a turn shows: messages, commands, withdraw entries and finished entries. */
function shownFact(fact: PluginFact): boolean {
  if (fact.type === MESSAGE_CHANGE_FACT) return messageChangeOfFact(fact)?.kind === "withdraw";
  return fact.type === MESSAGE_FACT || fact.type === COMMAND_FACT || fact.type === ENTRY_FACT;
}

/** What one run took: the messages its reply or answer fact names, and whether either says so. */
interface RunTaken {
  readonly ids: ReadonlySet<string>;
  readonly known: boolean;
}

/**
 * The messages each run took. A reply names them in `replyTo`; a run that ended
 * without a reply names the ones it took in `chat.answered`. A run with neither
 * says nothing, so an older chat keeps the order it recorded.
 */
function takenByRun(facts: readonly PluginFact[]): ReadonlyMap<string, RunTaken> {
  const found = new Map<string, { readonly ids: Set<string>; known: boolean }>();
  const add = (runId: unknown, ids: readonly string[], known: boolean): void => {
    if (typeof runId !== "string" || runId.length === 0) return;
    const run = found.get(runId) ?? { ids: new Set<string>(), known: false };
    for (const id of ids) run.ids.add(id);
    run.known = run.known || known;
    found.set(runId, run);
  };
  for (const fact of facts) {
    if (fact.type === MESSAGE_FACT && fact.data.role === "assistant") {
      const replyTo = fact.data.replyTo;
      const ids = Array.isArray(replyTo)
        ? replyTo.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      add(fact.data.runId, ids, Array.isArray(replyTo));
    } else if (fact.type === ANSWER_FACT) {
      add(fact.data.runId, answeredOfFact(fact), true);
    }
  }
  return found;
}

interface RunChunk {
  readonly chunk: Chunk;
  readonly span: number;
}

/**
 * The chunks of each run, from the run fact to its reply. A message the run
 * took while it wrote is in that span, so it is ordered with the run's items
 * rather than left as a chunk above all of them. A message the run did not take
 * waits for the next round, so it stays out of the reply's items. Content before
 * the first run fact, and a store that predates run facts, keeps the older
 * chunking.
 */
function runChunks(
  facts: readonly PluginFact[],
): { readonly chunks: readonly RunChunk[]; readonly consumed: ReadonlySet<number>; readonly spans: readonly number[] } | undefined {
  const starts: { readonly index: number; readonly runId: string }[] = [];
  facts.forEach((fact, index) => {
    if (fact.type === RUN_FACT && typeof fact.data.runId === "string" && fact.data.runId.length > 0) {
      starts.push({ index, runId: fact.data.runId });
    }
  });
  if (starts.length === 0) return undefined;
  const taken = takenByRun(facts);
  const spans = facts.map(() => -1);
  const chunks: RunChunk[] = [];
  const consumed = new Set<number>();
  starts.forEach((start, at) => {
    const end = starts[at + 1]?.index ?? facts.length;
    for (let index = start.index; index < end; index += 1) spans[index] = start.index;
    const took = taken.get(start.runId);
    let turn: PluginFact[] = [];
    for (let index = start.index + 1; index < end; index += 1) {
      const fact = facts[index];
      if (fact === undefined || !shownFact(fact)) continue;
      // A person's message that this run's reply does not name was not given
      // to the agent; it is the next round's, not part of this reply.
      if (fact.type === MESSAGE_FACT && fact.data.role === "user") {
        const id = typeof fact.data.id === "string" ? fact.data.id : undefined;
        if (id !== undefined && took?.known === true && !took.ids.has(id)) continue;
      }
      turn.push(fact);
      consumed.add(index);
      if (fact.type === MESSAGE_FACT && fact.data.role === "assistant" && fact.data.runId === start.runId) {
        chunks.push({ chunk: chunkOf(turn), span: start.index });
        turn = [];
      }
    }
    if (turn.length > 0) chunks.push({ chunk: chunkOf(turn), span: start.index });
  });
  return { chunks, consumed, spans };
}

/** A turn is the entries of a run and the reply they led to, so a page never splits them. */
function legacyChunksOf(facts: readonly PluginFact[]): readonly Chunk[] {
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
    if (
      fact.type === MESSAGE_FACT ||
      fact.type === COMMAND_FACT ||
      (fact.type === MESSAGE_CHANGE_FACT && messageChangeOfFact(fact)?.kind === "withdraw")
    ) {
      chunks.push(chunkOf([fact]));
    }
    index += 1;
  }
  return chunks;
}

function chunksOf(facts: readonly PluginFact[]): readonly Chunk[] {
  const runs = runChunks(facts);
  if (runs === undefined) return legacyChunksOf(facts);
  // A chunk carries the run span it belongs to. A run's own chunks come before
  // what its span left out: a message it did not take waits above the next
  // round, below this reply, rather than splitting the reply's items.
  const placed: { readonly chunk: Chunk; readonly span: number; readonly after: boolean }[] = runs.chunks.map(
    (run) => ({ chunk: run.chunk, span: run.span, after: false }),
  );
  const rest = (first: number, chunk: Chunk): void => {
    placed.push({ chunk, span: runs.spans[first] ?? -1, after: true });
  };
  let index = 0;
  while (index < facts.length) {
    if (runs.consumed.has(index)) {
      index += 1;
      continue;
    }
    const fact = facts[index];
    if (fact === undefined) break;
    if (
      fact.type === MESSAGE_FACT ||
      fact.type === COMMAND_FACT ||
      (fact.type === MESSAGE_CHANGE_FACT && messageChangeOfFact(fact)?.kind === "withdraw")
    ) {
      rest(index, chunkOf([fact]));
      index += 1;
      continue;
    }
    if (fact.type === ENTRY_FACT) {
      const runId = typeof fact.data.runId === "string" ? fact.data.runId : undefined;
      let end = index + 1;
      while (
        end < facts.length &&
        !runs.consumed.has(end) &&
        facts[end]?.type === ENTRY_FACT &&
        (runId === undefined || facts[end]?.data.runId === runId)
      ) {
        end += 1;
      }
      rest(index, chunkOf(facts.slice(index, end)));
      index = end;
      continue;
    }
    index += 1;
  }
  return placed
    .sort(
      (left, right) =>
        left.span - right.span ||
        (left.after === right.after ? 0 : left.after ? 1 : -1) ||
        (left.chunk.facts[0]?.sequence ?? 0) - (right.chunk.facts[0]?.sequence ?? 0),
    )
    .map((item) => item.chunk);
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

/** When one shown item happened, for ordering a turn with a message sent during it. */
function shownAt(fact: PluginFact): number {
  const entry = fact.type === ENTRY_FACT ? entryOfFact(fact) : undefined;
  return entry !== undefined && typeof entry.startedAt === "number" ? entry.startedAt : fact.at;
}

/**
 * The facts of a turn in time order, when the entries carry times. A store whose
 * entries carry none keeps the order it recorded, so an older chat reads as it
 * always did. Messages and commands always carry their fact's time.
 */
function turnFacts(facts: readonly PluginFact[]): readonly PluginFact[] {
  const timed = facts.some((fact) => {
    const entry = fact.type === ENTRY_FACT ? entryOfFact(fact) : undefined;
    return entry !== undefined && typeof entry.startedAt === "number";
  });
  if (!timed) return facts;
  return facts
    .map((fact, index) => ({ fact, index, at: shownAt(fact) }))
    .sort((left, right) => left.at - right.at || left.index - right.index)
    .map((item) => item.fact);
}

function rendered(chunk: Chunk, speaker: string, home: string | undefined, harness: string): readonly string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  const flush = (): void => {
    if (lines.length > 0) blocks.push(lines.join("\n"));
    lines = [];
  };
  for (const fact of turnFacts(chunk.facts)) {
    if (fact.type === COMMAND_FACT) {
      flush();
      const command = commandOfFact(fact);
      if (command !== undefined) blocks.push(commandMarkdown(command));
      continue;
    }
    if (fact.type === MESSAGE_CHANGE_FACT) {
      flush();
      const change = messageChangeOfFact(fact);
      if (change?.kind === "withdraw") blocks.push(withdrawalMarkdown(change));
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

/** The changing part of a transcript: its tail, what the reply is doing, and where finished content pauses. */
interface Live {
  readonly tail?: string | undefined;
  readonly status?: SectionStatus | undefined;
  /** The last fact before a message the live tail holds, so a client reads it again with the reply. */
  readonly cut?: number | undefined;
}

interface TailItem {
  readonly at?: number | undefined;
  readonly order: number;
  readonly markdown: string;
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

/** One shown fact as a tail line, for a message the live reply is holding. */
function factTailItem(fact: PluginFact, speaker: string, home: string | undefined, harness: string): string | undefined {
  if (fact.type === COMMAND_FACT) {
    const command = commandOfFact(fact);
    return command === undefined ? undefined : commandMarkdown(command);
  }
  if (fact.type === ENTRY_FACT) {
    const entry = entryOfFact(fact);
    return entry === undefined ? undefined : entryMarkdown(entry, speaker, harness);
  }
  if (fact.type === MESSAGE_CHANGE_FACT) {
    const change = messageChangeOfFact(fact);
    return change?.kind === "withdraw" ? withdrawalMarkdown(change) : undefined;
  }
  if (fact.type !== MESSAGE_FACT) return undefined;
  const message = messageFrom(fact);
  return message === undefined ? undefined : messageMarkdown(message, speaker, home);
}

/**
 * The tail of a reply that has a message sent during it. The message is a fact
 * but the reply's items are still in the log: both are put in time order, so
 * the live tail and the stored transcript place the message alike. `cut` is the
 * fact before the first such message; finished content stops there until the
 * run ends or the message can be appended with the rest.
 */
function heldTail(
  facts: readonly PluginFact[],
  cut: number,
  log: readonly TailItem[],
  speaker: string,
  home: string | undefined,
  harness: string,
): string | undefined {
  const held: TailItem[] = [];
  for (const fact of facts) {
    if (fact.sequence <= cut) continue;
    const markdown = factTailItem(fact, speaker, home, harness);
    if (markdown === undefined) continue;
    held.push({ at: shownAt(fact), order: held.length, markdown });
  }
  const all = [...held, ...log.map((item, index) => ({ ...item, order: held.length + index }))];
  const fallback = log.at(-1)?.at ?? 0;
  const ordered = all
    .map((item) => ({ ...item, sort: item.at ?? fallback }))
    .sort((left, right) => left.sort - right.sort || left.order - right.order);
  const lines = ordered.map((item) => item.markdown).filter((line) => line.trim().length > 0);
  return lines.length === 0 ? undefined : lines.join("\n\n");
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
  let cut: number | undefined;
  if (runId !== undefined && chat.harness.length > 0 && ctx.runTimes !== undefined && times !== undefined && times.endedAt === null) {
    secrets = await secretValues(ctx);
    const said = new Set<string>();
    const calls = new Set<string>();
    let runStart = -1;
    for (const fact of facts) {
      if (fact.type === RUN_FACT && fact.data.runId === runId) runStart = fact.sequence;
      if (fact.data.runId !== runId) continue;
      if (fact.type === MESSAGE_FACT && fact.data.role === "assistant" && typeof fact.data.text === "string") {
        said.add(fact.data.text.trim());
      }
      const entry = fact.type === ENTRY_FACT ? entryOfFact(fact) : undefined;
      if (entry?.kind === "tool" && entry.callId !== undefined) calls.add(entry.callId);
      else if (entry?.text !== undefined) said.add(entry.text.trim());
    }
    called = calls;
    // A person's message after the run began is inside the reply. Its fact is
    // already stored while the reply's own items are still in the log.
    const during = runStart < 0
      ? undefined
      : facts.find(
          (fact) =>
            fact.sequence > runStart &&
            fact.type === MESSAGE_FACT &&
            fact.data.role === "user",
        );
    cut = during?.sequence === undefined ? undefined : during.sequence - 1;
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
      const items: TailItem[] = [];
      const push = (at: number | null | undefined, markdown: string | undefined): void => {
        if (markdown === undefined || markdown.trim().length === 0) return;
        items.push({ ...(at === null || at === undefined ? {} : { at }), order: items.length, markdown });
      };
      // A finished entry is shown until the facts hold it; then `said` and `called` drop it.
      for (const entry of read.state.entries) {
        // Radian gives no text or thinking increments; its chats show tool lines only.
        if (chat.harness === "radian" && entry.kind !== "tool") continue;
        if (entry.kind === "tool") {
          if (calls.has(maskSecrets(entry.callId, secrets))) continue;
          push(
            entry.at,
            entryMarkdown(
              {
                ...entry,
                toolName: maskSecrets(entry.toolName, secrets),
                input: entry.input === null ? null : maskSecrets(entry.input, secrets),
                error: entry.error === null ? null : maskSecrets(entry.error, secrets),
              },
              speaker,
              chat.harness,
            ),
          );
          continue;
        }
        const text = fresh(entry.text);
        if (text === undefined) continue;
        push(entry.at, entryMarkdown({ ...entry, text }, speaker, chat.harness));
      }
      // Radian gives no text or thinking increments; its chats show the tool lines only.
      if (chat.harness !== "radian") {
        const thinking = fresh(read.state.thinking);
        if (thinking !== undefined) push(read.lastAt, thinking.split(/\r?\n/).map((line) => `> ${line}`).join("\n"));
        const text = fresh(read.state.text);
        if (text !== undefined) push(read.lastAt, `**${speaker}:** ${block(text)}`);
      }
      for (const call of read.state.calls) {
        if (calls.has(maskSecrets(call.callId, secrets))) continue;
        const input = call.input === null ? "" : flat(maskSecrets(call.input, secrets));
        const what = input.length === 0 ? "" : ` ${inlineCode(input.length <= 160 ? input : `${input.slice(0, 159)}…`)}`;
        push(call.at, `tool ${maskSecrets(call.toolName, secrets)} since ${clock(call.at)}${what}`);
      }
      tail = cut === undefined
        ? (items.length === 0 ? undefined : items.map((item) => item.markdown).join("\n\n"))
        : heldTail(facts, cut, items, speaker, ctx.home, chat.harness);
    }
    // The log may not exist yet; the mid-run message still belongs in the tail.
    if (cut !== undefined && tail === undefined) {
      tail = heldTail(facts, cut, [], speaker, ctx.home, chat.harness);
    }
  }
  const status = statusOf(facts, pending, runId, times, read, called, secrets);
  return {
    ...(tail === undefined ? {} : { tail }),
    ...(status === undefined ? {} : { status }),
    ...(cut === undefined ? {} : { cut }),
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
  const facts = messageFactsInForce(allFacts(ctx, ref));
  const messages = facts
    .map(messageFrom)
    .filter((message): message is Message => message !== undefined);
  const queued = queuedData(queuedMessages(messages, facts));
  const queueData: Record<string, JsonValue> = {
    queued: queued as unknown as JsonValue,
    queuedCount: queued.length,
  };
  const live = await liveOf(ctx, object, facts, speaker);
  const { cut, ...liveContent } = live;
  // A message the live tail holds stays unread as finished content until the
  // run ends, so the same facts then arrive together with the reply's items.
  const finished = cut === undefined ? facts : facts.filter((fact) => fact.sequence <= cut);
  const context = await chatContext(ctx, object);
  const since = markAfter(options.after);
  if (since !== undefined) {
    // Only what was recorded after the mark, in the same Markdown as a full read.
    const chunks = chunksOf(finished.filter((fact) => fact.sequence > since));
    const blocks = chunks.flatMap((chunk) => rendered(chunk, speaker, ctx.home, chat.harness));
    return {
      markdown: blocks.join("\n\n---\n\n"),
      mark: markOf(Math.max(since, chunks.at(-1)?.last ?? 0)),
      delta: true,
      ...liveContent,
      ...(context === undefined ? {} : { context }),
      data: queueData,
    };
  }
  const pages = pagesOf(ref, chunksOf(finished));
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
    ...liveContent,
    ...(context === undefined ? {} : { context }),
    data: queueData,
  };
}

/** Reads an object through its type's `prepare`, or the store when the view has none. */
function objectReader(ctx: ViewContext): ObjectReader {
  return async (type, id) =>
    ctx.refreshedObject === undefined ? ctx.store.get(type, id) : ctx.refreshedObject(type, id);
}

/** The views of the chat type. */
export const chatViews: ObjectViews = {
  row,
  sections,
  context: chatContext,
  skills: async (ctx, object) =>
    skillSummaries(await readChatSkills(chatData(object.data), objectReader(ctx))),
  load,
};
