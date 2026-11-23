/** How a chat shows in a list and on its page: a row and a transcript. */

import { attachmentDir, attachmentUrl, CursorError, decodeCursor, DEFAULT_SECTION_CAP_BYTES, encodeCursor, formatElapsed, isRecord, parseObjectId } from "@operad-io/engine";
import type {
  JsonValue,
  ObjectRef,
  ObjectRow,
  ObjectViews,
  PluginFact,
  SectionContent,
  SectionPage,
  SectionRetry,
  SectionStatus,
  StoredObject,
  ViewContext,
  ViewSection,
} from "@operad-io/engine";
import { join } from "node:path";
import { maskSecrets, type FoldEntry } from "@operad-io/harness-process";
import { secretValues } from "./reply.ts";
import { readChatSkills, skillSummaries, type ObjectReader } from "./skills.ts";
import { foldLogTail, agentLogPath } from "./tail.ts";
import { segmentsOf, type Segment } from "./segments.ts";
import { agentLine, answeredOfFact, attachmentsOf, CHAT_TYPE, deliveryHeader, deliveryOf, chatData, chatRef, COMMAND_FACT, commandOfFact, ENTRY_FACT, entryOfFact, factsOf, IMAGE_TYPES, lastReplyContext, latestRunOf, MESSAGE_CHANGE_FACT, MESSAGE_FACT, memoryShownOf, memoryUsedLine, memoryWroteLine, messageChangeOfFact, messageFactsInForce, modelAndCost, queuedData, queuedMessages, queuedOf, readChat, RUN_FACT, stopOfFact, timingsOf, unanswered, ANSWER_FACT, type Attachment, type ChatContext, type ChatRead, type Command, type Entry, type Message, type MemoryShown, type MessageChange, type ToolResult } from "./model.ts";
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
    ...(queued.length === 0
      ? {}
      : { queued: queued as unknown as JsonValue, queuedCount: queued.length }),
  };
  return {
    id: object.id,
    title: chat.title.length > 0 ? chat.title : object.id,
    // A run of a routine is in neither list: its state is in no filter.
    state: chat.run === true ? "run" : chat.closed ? "closed" : "open",
    ...(note.length === 0 ? {} : { note: note.join(" · ") }),
    ...(chat.closed || chat.run === true ? { final: true } : {}),
    ...(typeof chat.parent === "string" && chat.parent.length > 0 ? { parent: chat.parent } : {}),
    ...(Object.keys(data).length === 0 ? {} : { data }),
  };
}

function sections(): readonly ViewSection[] {
  return [{ id: TRANSCRIPT, title: "Transcript", live: true }];
}

/** The context the chat's detail page and transcript show: its last finished reply's. */
function chatContext(object: StoredObject, read: ChatRead): ChatContext | undefined {
  return lastReplyContext(chatData(object.data), read.messages, read.facts);
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
  if (message.delivery !== undefined) {
    return [`**${deliveryHeader(message.delivery)}** · ${minute(message.at)}`, message.text].filter((part) => part.length > 0).join("\n\n");
  }
  if (message.role === "recap") return [`**Recap** · ${minute(message.at)}`, message.text].join("\n\n");
  const who = message.role === "assistant" ? speaker : "you";
  const via = message.role === "user" && message.source.kind.length > 0 ? ` via ${message.source.kind}` : "";
  const head = `**${who}**${via} · ${minute(message.at)}`;
  const used = message.role === "assistant" ? modelAndCost(message.model, message.costMicros, message.costQuality) : [];
  const under = used.length > 0 ? `*${used.join(" · ")}*` : "";
  const memoryLines = message.role === "assistant"
    ? [memoryWroteLine(message.memory), memoryUsedLine(message.memory)].flatMap((line) => (line === undefined ? [] : [`*${line}*`]))
    : [];
  const body = [message.text, ...message.attachments.map((file) => attachmentMarkdown(file, home)), under, ...memoryLines].filter((part) => part.length > 0);
  return [head, ...body].join("\n\n");
}

/**
 * How the transcript labels the model's messages now. The chat's own setting
 * applies; a parent object that names a speaker (a bot) speaks for its chats.
 * It is read at every draw, so a changed name shows on the messages already
 * recorded too.
 */
async function speakerOf(ctx: ViewContext, object: StoredObject, refresh = false): Promise<string> {
  const parent = chatData(object.data).parent;
  if (parent !== undefined) {
    const ref = parseObjectId(parent);
    if (ref !== undefined) {
      const owner = refresh && ctx.refreshedObject !== undefined
        ? await ctx.refreshedObject(ref.type, ref.id)
        : await ctx.store.get(ref.type, ref.id);
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
  if (data.role !== "user" && data.role !== "assistant" && data.role !== "delivery" && data.role !== "recap") return undefined;
  const delivery = data.role === "delivery" ? deliveryOf(data.delivery) : undefined;
  if (data.role === "delivery" && delivery === undefined) return undefined;
  const from = isRecord(data.from) ? data.from : {};
  const source = typeof data.source === "object" && data.source !== null ? (data.source as Record<string, unknown>) : {};
  const timings = timingsOf(data.timings);
  const memory = memoryShownOf(data.memory);
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
    ...(delivery === undefined ? {} : { delivery }),
    ...(typeof data.runId === "string" && data.runId.length > 0 ? { runId: data.runId } : {}),
    ...(typeof data.model === "string" && data.model.length > 0 ? { model: data.model } : {}),
    ...(timings === undefined ? {} : { timings }),
    ...(memory === undefined ? {} : { memory }),
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
  const took = entry.durationMs === undefined ? "" : ` ${formatElapsed(entry.durationMs)}`;
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

/** What a process group did: category ids, never sentences; a client words them. */
export const PROCESS_CATEGORIES = ["read", "edit", "run", "search", "other"] as const;

export type ProcessCategory = (typeof PROCESS_CATEGORIES)[number];

/** One message of a reply's input or answer. */
export interface ReplyMessage {
  readonly id: string;
  readonly text: string;
  /** When it was recorded, in milliseconds since the epoch. */
  readonly at: number;
  /** `true` when the text was shortened to fit the size cap; read the page with `full=true` for it whole. */
  readonly cut?: true | undefined;
}

/** The recorded start of a tool call's output and how many lines it has. */
export interface ReplyOutput {
  /** The recorded output, its first 4 KB at most; empty when it printed nothing. */
  readonly text: string;
  /** How many lines the recorded output has; a final newline adds no empty line. */
  readonly lines: number;
  /** The server address of the file that holds the whole output, when it was longer than 4 KB. */
  readonly url?: string | undefined;
  /** Whether the recorded output was cut; `url` then holds the rest. */
  readonly truncated?: true | undefined;
}

export interface ReplyThinkingItem {
  readonly kind: "thinking";
  readonly text: string;
  readonly at?: number | undefined;
  /** `true` when the text was shortened to fit the size cap. */
  readonly cut?: true | undefined;
}

export interface ReplyTextItem {
  readonly kind: "text";
  readonly text: string;
  readonly at?: number | undefined;
  /** `true` when the text was shortened to fit the size cap. */
  readonly cut?: true | undefined;
}

export interface ReplyToolItem {
  readonly kind: "tool";
  readonly callId: string;
  readonly name: string;
  readonly input: string | null;
  /** When the call started; absent for a call whose log had no start line. */
  readonly at?: number | undefined;
  /** Absent while the call is still running. */
  readonly durationMs?: number | undefined;
  readonly failed: boolean;
  /** Absent while the call is still running. */
  readonly result?: ToolResult | undefined;
  readonly output: ReplyOutput;
  /** `true` when the input was shortened to fit the size cap. */
  readonly cut?: true | undefined;
}

export type ReplyItem = ReplyThinkingItem | ReplyTextItem | ReplyToolItem;

/** The thinking and tool calls one turn did, with the categories they fall in. */
export interface ReplyProcess {
  readonly categories: readonly ProcessCategory[];
  readonly items: readonly ReplyItem[];
}

/** One reply: its input, its process grouped per turn, and its answer when it finished. */
export interface ReplyBlock {
  readonly runId: string;
  readonly input: readonly ReplyMessage[];
  readonly process: readonly ReplyProcess[];
  readonly answer?: ReplyMessage | undefined;
  /** The memory notes the reply wrote and used, when it did either. */
  readonly memory?: MemoryShown | undefined;
  /** How long the reply took, when its harness reported the timings. */
  readonly durationMs?: number | undefined;
}

/** The category a tool name falls in. */
export function toolCategory(name: string): ProcessCategory {
  const lower = name.toLowerCase();
  if (["read", "ls", "notebookread"].includes(lower)) return "read";
  if (["write", "edit", "multiedit", "notebookedit"].includes(lower)) return "edit";
  if (["bash", "shell", "shell_command", "command", "terminal", "exec", "run"].includes(lower)) return "run";
  if (["grep", "glob", "search", "websearch", "webfetch", "find"].includes(lower)) return "search";
  return "other";
}

function lineCount(text: string): number {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return clean.length === 0 ? 0 : clean.split("\n").length;
}

function replyOutput(
  text: string | null | undefined,
  path: string | undefined,
  truncated: boolean | undefined,
  home: string | undefined,
): ReplyOutput {
  const said = text ?? "";
  const url = path === undefined || home === undefined ? undefined : attachmentUrl(home, path);
  return {
    text: said,
    lines: lineCount(said),
    ...(url === undefined ? {} : { url }),
    ...(truncated === true ? { truncated: true as const } : {}),
  };
}

function replyItemOfEntry(entry: Entry, home: string | undefined): ReplyItem | undefined {
  if (entry.kind === "tool") {
    return {
      kind: "tool",
      callId: entry.callId ?? "",
      name: entry.toolName ?? "tool",
      input: entry.input ?? null,
      ...(typeof entry.startedAt === "number" ? { at: entry.startedAt } : {}),
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      failed: entry.result === "failed",
      result: entry.result,
      output: replyOutput(entry.output, entry.outputPath, entry.outputTruncated || entry.outputPath !== undefined, home),
    };
  }
  if (entry.kind !== "text" && entry.kind !== "thinking") return undefined;
  const text = entry.text?.trim();
  if (text === undefined || text.length === 0) return undefined;
  return {
    kind: entry.kind,
    text,
    ...(typeof entry.startedAt === "number" ? { at: entry.startedAt } : {}),
  };
}

function replyItemOfFold(entry: FoldEntry, secrets: readonly string[]): ReplyItem | undefined {
  if (entry.kind === "tool") {
    return {
      kind: "tool",
      callId: maskSecrets(entry.callId, secrets),
      name: maskSecrets(entry.toolName, secrets),
      input: entry.input === null ? null : maskSecrets(entry.input, secrets),
      ...(entry.at === null ? {} : { at: entry.at }),
      durationMs: entry.durationMs,
      failed: entry.result === "failed",
      result: entry.result,
      output: replyOutput(
        entry.output === null ? null : maskSecrets(entry.output, secrets),
        undefined,
        entry.outputTruncated,
        undefined,
      ),
    };
  }
  const text = maskSecrets(entry.text, secrets).trim();
  if (text.length === 0) return undefined;
  return {
    kind: entry.kind,
    text,
    ...(entry.at === undefined ? {} : { at: entry.at }),
  };
}

function replyItemOfOpenCall(
  call: { readonly callId: string; readonly toolName: string; readonly input: string | null; readonly at: number; readonly output: string | null; readonly outputTruncated: boolean },
  secrets: readonly string[],
): ReplyToolItem {
  return {
    kind: "tool",
    callId: maskSecrets(call.callId, secrets),
    name: maskSecrets(call.toolName, secrets),
    input: call.input === null ? null : maskSecrets(call.input, secrets),
    at: call.at,
    failed: false,
    output: replyOutput(
      call.output === null ? null : maskSecrets(call.output, secrets),
      undefined,
      call.outputTruncated,
      undefined,
    ),
  };
}

function addCategory(categories: ProcessCategory[], name: string): void {
  const category = toolCategory(name);
  if (!categories.includes(category)) categories.push(category);
}

interface OpenGroups {
  readonly groups: { readonly categories: ProcessCategory[]; readonly items: ReplyItem[] }[];
  categories: ProcessCategory[];
  items: ReplyItem[];
}

function openGroups(): OpenGroups {
  return { groups: [], categories: [], items: [] };
}

function closeGroup(state: OpenGroups): void {
  if (state.items.length > 0) state.groups.push({ categories: state.categories, items: state.items });
  state.categories = [];
  state.items = [];
}

function appendItem(state: OpenGroups, item: ReplyItem): void {
  state.items.push(item);
  if (item.kind === "tool") addCategory(state.categories, item.name);
}

/** The process of one turn's facts, split where a message the reply took arrived. */
function processOf(chunk: Chunk, home: string | undefined, extra: readonly ReplyItem[] = []): readonly ReplyProcess[] {
  const events: { readonly at?: number | undefined; readonly order: number; readonly message?: Message; readonly item?: ReplyItem }[] = [];
  for (const fact of turnFacts(chunk.facts)) {
    const message = fact.type === MESSAGE_FACT ? messageFrom(fact) : undefined;
    if (message?.role === "user") {
      events.push({ at: shownAt(fact), order: events.length, message });
      continue;
    }
    if (fact.type !== ENTRY_FACT) continue;
    const entry = entryOfFact(fact);
    const item = entry === undefined ? undefined : replyItemOfEntry(entry, home);
    if (item !== undefined) events.push({ ...(item.at === undefined ? {} : { at: item.at }), order: events.length, item });
  }
  // The log's unfinished items follow the facts; their times put them before a
  // message that arrived while the reply was still writing.
  for (const item of extra) events.push({ ...(item.at === undefined ? {} : { at: item.at }), order: events.length, item });
  if (extra.length > 0) {
    const times = events.flatMap((event) => (event.at === undefined ? [] : [event.at]));
    const fallback = times.length === 0 ? Number.MAX_SAFE_INTEGER : Math.max(...times);
    events.sort(
      (left, right) => (left.at ?? fallback) - (right.at ?? fallback) || left.order - right.order,
    );
  }
  const state = openGroups();
  for (const event of events) {
    if (event.message !== undefined) closeGroup(state);
    else if (event.item !== undefined) appendItem(state, event.item);
  }
  closeGroup(state);
  return state.groups;
}

function processOfItems(items: readonly ReplyItem[]): readonly ReplyProcess[] {
  if (items.length === 0) return [];
  const state = openGroups();
  for (const item of items) appendItem(state, item);
  closeGroup(state);
  return state.groups;
}

function replyMessage(message: Message): ReplyMessage {
  return { id: message.id, text: message.text, at: message.at };
}

function messagesInTime(messages: readonly Message[]): readonly ReplyMessage[] {
  return [...messages].sort((left, right) => left.sequence - right.sequence).map(replyMessage);
}

interface LiveReply {
  readonly runId: string;
  readonly items: readonly ReplyItem[];
}

/** The structured form of each reply, with the live reply's unfinished items when one runs. */
interface BuiltReply {
  readonly block: ReplyBlock;
  /** The finished chunk the reply came from; absent for a reply still being written. */
  readonly chunk?: Chunk | undefined;
  /** The answer's fact position; absent while the reply is still being written. */
  readonly answerSequence?: number | undefined;
}

/** The assistant message a chunk ends with, when it has one. */
function answerIn(chunk: Chunk): Message | undefined {
  return chunk.facts
    .map((fact) => (fact.type === MESSAGE_FACT ? messageFrom(fact) : undefined))
    .find((message) => message?.role === "assistant");
}

/** The last answer before `sequence`, so a window's first reply still names its input. */
function answerBefore(chunks: readonly Chunk[], sequence: number): number {
  let previous = -1;
  for (const chunk of chunks) {
    const answer = answerIn(chunk);
    if (answer === undefined) continue;
    if (answer.sequence >= sequence) break;
    previous = answer.sequence;
  }
  return previous;
}

/**
 * The replies already finished among `chunks`, in order. `previousAnswer` is
 * the answer before the first chunk, so a page or a read after a mark builds
 * only the replies it carries while keeping an older reply's input right.
 */
function storedReplies(
  chunks: readonly Chunk[],
  messages: readonly Message[],
  home: string | undefined,
  previousAnswer = -1,
): readonly BuiltReply[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const blocks: BuiltReply[] = [];
  let previous = previousAnswer;
  for (const chunk of chunks) {
    const answer = answerIn(chunk);
    if (answer === undefined) continue;
    const runId = answer.runId ?? chunk.runId;
    if (runId === undefined) continue;
    const named = answer.replyTo === undefined || answer.replyTo.length === 0
      ? []
      : answer.replyTo
          .map((id) => byId.get(id))
          .filter((message): message is Message => message !== undefined && message.role === "user");
    const input = named.length > 0
      ? named
      : messages.filter(
          (message) =>
            message.role === "user" &&
            message.sequence > previous &&
            message.sequence < answer.sequence,
        );
    blocks.push({
      block: {
        runId,
        input: messagesInTime(input),
        process: processOf(chunk, home),
        answer: replyMessage(answer),
        ...(answer.memory === undefined ? {} : { memory: answer.memory }),
        ...(answer.timings === undefined ? {} : { durationMs: answer.timings.totalMs }),
      },
      chunk,
      answerSequence: answer.sequence,
    });
    previous = answer.sequence;
  }
  return blocks;
}

/** The one reply still being written, with the log's unfinished items. */
function liveReply(
  facts: readonly PluginFact[],
  messages: readonly Message[],
  live: LiveReply,
  home: string | undefined,
): BuiltReply | undefined {
  const chunks = chunksOf(facts);
  let target = -1;
  chunks.forEach((chunk, index) => {
    if (chunk.runId === live.runId) target = index;
  });
  const chunk = target < 0 ? undefined : chunks[target];
  const answer = chunk?.facts
    .map((fact) => (fact.type === MESSAGE_FACT ? messageFrom(fact) : undefined))
    .find((message) => message?.role === "assistant");
  if (chunk !== undefined && answer === undefined) {
    return {
      block: {
        runId: chunk.runId ?? live.runId,
        input: messagesInTime(unanswered(messages, facts)),
        process: processOf(chunk, home, live.items),
      },
      chunk,
    };
  }
  const pending = unanswered(messages, facts);
  if (pending.length === 0 && live.items.length === 0) return undefined;
  return {
    block: {
      runId: live.runId,
      input: messagesInTime(pending),
      process: processOfItems(live.items),
    },
  };
}

/** The deliveries recorded in the chunks shown, as the transcript's data names them. */
function deliveriesData(chunks: readonly Chunk[]): JsonValue[] {
  const found: JsonValue[] = [];
  for (const chunk of chunks) {
    for (const fact of chunk.facts) {
      const message = fact.type === MESSAGE_FACT ? messageFrom(fact) : undefined;
      const delivery = message?.delivery;
      if (message === undefined || delivery === undefined) continue;
      found.push({
        id: message.id,
        at: message.at,
        routine: delivery.routine,
        ...(delivery.routineId === undefined ? {} : { routineId: delivery.routineId }),
        runId: delivery.runId,
        ...(delivery.failed === true ? { failed: true } : {}),
      });
    }
  }
  return found;
}

function withDeliveries(base: Readonly<Record<string, JsonValue>>, chunks: readonly Chunk[]): Readonly<Record<string, JsonValue>> {
  const deliveries = deliveriesData(chunks);
  return deliveries.length === 0 ? base : { ...base, deliveries };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * The transcript's data, cut to fit its budget: tool output text first, then
 * the other reply text, and at last the oldest reply blocks. A read that still
 * did not fit would be refused, so this always answers within the budget.
 * Every reply is measured once and a running total is kept, so the work is
 * linear in the size of the page; `measure` is a seam for tests.
 */
export function replyData(
  replies: readonly ReplyBlock[],
  maxBytes: number,
  base: Readonly<Record<string, JsonValue>> = {},
  measure: (value: unknown) => number = jsonBytes,
): Readonly<Record<string, JsonValue>> {
  const data = (shown: readonly ReplyBlock[], extra: Readonly<Record<string, JsonValue>> = base) =>
    ({ ...extra, replies: shown }) as unknown as Readonly<Record<string, JsonValue>>;
  const whole = data(replies);
  if (measure(whole) <= maxBytes) return whole;
  // A tool's output is the largest part and the least useful to a structured
  // client, so it goes first, keeping its line count and `truncated`.
  const blanked = replies.map((reply) => ({
    ...reply,
    process: reply.process.map((group) => ({
      ...group,
      items: group.items.map((item) => {
        if (item.kind !== "tool" || item.output.text.length === 0) return item;
        return {
          ...item,
          output: { ...item.output, text: "", truncated: true as const },
        };
      }),
    })),
  }));
  // The page's size is the wrapper (the base and an empty list), each reply,
  // and the commas between replies; each part is measured once.
  const overhead = measure(data([]));
  const sizes = blanked.map((reply) => measure(reply));
  let sum = sizes.reduce((total, size) => total + size, 0);
  const sizeOf = (count: number, inner: number): number => overhead + inner + Math.max(0, count - 1);
  if (sizeOf(blanked.length, sum) <= maxBytes) return data(blanked);
  // Shortening goes in three passes, each the oldest reply first and whole
  // reply by whole reply, so the newest stays whole the longest. Pass 1
  // shortens everything that is not an answer (thinking, text, tool input and
  // the input messages, which keep a preview). Pass 2 shortens answers to a
  // preview of about two lines. Pass 3 goes below the preview, and only then
  // are replies dropped.
  const cuts: ReplyBlock[] = [...blanked];
  const step = (at: number, caps: ReplyCaps): boolean => {
    const original = cuts[at];
    if (original === undefined) return false;
    const cut = cutReply(original, caps);
    const size = measure(cut);
    sum += size - (sizes[at] ?? 0);
    sizes[at] = size;
    cuts[at] = cut;
    return sizeOf(cuts.length, sum) <= maxBytes;
  };
  const passes: readonly (readonly ReplyCaps[])[] = [
    FREE_CAPS.map((free) => ({ free, input: Math.max(free, PREVIEW_BYTES), answer: Infinity })),
    [{ free: 0, input: PREVIEW_BYTES, answer: PREVIEW_BYTES }],
    [64, 0].map((all) => ({ free: all, input: all, answer: all })),
  ];
  for (const pass of passes) {
    for (let at = 0; at < cuts.length; at += 1) {
      for (const caps of pass) if (step(at, caps)) return data(cuts);
    }
  }
  // Even empty text leaves too much structure: the oldest replies go.
  for (let drop = 1; drop <= cuts.length; drop += 1) {
    sum -= sizes[drop - 1] ?? 0;
    if (sizeOf(cuts.length - drop, sum) <= maxBytes) return data(cuts.slice(drop));
  }
  // The base is the only thing left; it is small in every caller but is cut
  // last rather than letting the read be refused.
  if (overhead <= maxBytes) return data([]);
  return (measure({ replies: [] }) <= maxBytes ? { replies: [] } : {}) as Readonly<Record<string, JsonValue>>;
}

/** The preview an older reply's answer and input keep while anything else can still be cut: about two lines. */
const PREVIEW_BYTES = 200;
const FREE_CAPS: readonly number[] = [128, 0];

/** Byte caps for the three kinds of text in a reply; `Infinity` leaves a kind whole. */
interface ReplyCaps {
  readonly free: number;
  readonly input: number;
  readonly answer: number;
}

/**
 * Text cut to fit a byte budget, ending with an ellipsis when it was longer.
 * The cut is at a line or sentence end when one is in the last quarter of what
 * fits, and never inside a code point.
 */
function shorten(text: string, capBytes: number): string {
  if (capBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= capBytes) return text;
  if (capBytes <= 3) return "";
  let end = Math.min(text.length, capBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") + 3 > capBytes) end -= 1;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  if (end === 0) return "";
  const head = text.slice(0, end);
  const floor = Math.floor(end * 0.75);
  const newline = head.lastIndexOf("\n");
  if (newline > 0 && newline >= floor) {
    const line = head.slice(0, newline).trimEnd();
    if (line !== "") return `${line}…`;
  }
  const sentence = /[.!?。！？](?=\s|$)/g;
  let stop = -1;
  for (let found = sentence.exec(head); found !== null; found = sentence.exec(head)) stop = found.index + 1;
  if (stop > 0 && stop >= floor) return `${head.slice(0, stop)}…`;
  return `${head}…`;
}

/** One reply with its free text cut to a budget; every text that got shorter says `cut`. */
function cutReply(reply: ReplyBlock, caps: ReplyCaps): ReplyBlock {
  const text = (original: string, capBytes: number): { readonly text: string; readonly cut?: true } => {
    const shortened = shorten(original, capBytes);
    return shortened === original ? { text: shortened } : { text: shortened, cut: true };
  };
  const message = (block: ReplyMessage, capBytes: number): ReplyMessage => ({ ...block, ...text(block.text, capBytes) });
  const item = (entry: ReplyItem): ReplyItem => {
    if (entry.kind === "tool") {
      if (entry.input === null) return entry;
      const shortened = shorten(entry.input, caps.free);
      return shortened === entry.input ? entry : { ...entry, input: shortened, cut: true };
    }
    return { ...entry, ...text(entry.text, caps.free) };
  };
  return {
    ...reply,
    input: reply.input.map((block) => message(block, caps.input)),
    ...(reply.answer === undefined ? {} : { answer: message(reply.answer, caps.answer) }),
    process: reply.process.map((group) => ({
      ...group,
      items: group.items.map(item),
    })),
  };
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

interface Chunk {
  readonly facts: readonly PluginFact[];
  /** How many messages, not entries, the chunk holds. */
  readonly messages: number;
  readonly last: number;
  /** The run a run chunk belongs to; absent for a message or older chunk. */
  readonly runId?: string | undefined;
}

function chunkOf(facts: readonly PluginFact[], runId?: string): Chunk {
  return {
    facts,
    messages: facts.filter((fact) => fact.type === MESSAGE_FACT || fact.type === COMMAND_FACT).length,
    last: facts.at(-1)?.sequence ?? 0,
    ...(runId === undefined ? {} : { runId }),
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
        chunks.push({ chunk: chunkOf(turn, start.runId), span: start.index });
        turn = [];
      }
    }
    if (turn.length > 0) chunks.push({ chunk: chunkOf(turn, start.runId), span: start.index });
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

/** The changing part of a transcript: its tail, what the reply is doing, and where finished content pauses. */
interface Live {
  readonly tail?: string | undefined;
  readonly status?: SectionStatus | undefined;
  readonly retry?: SectionRetry | undefined;
  /** The last fact before a message the live tail holds, so a client reads it again with the reply. */
  readonly cut?: number | undefined;
  /** The run still being written, so its structured reply can take the unfinished items. */
  readonly run?: string | undefined;
  /** The process items the log holds and the facts do not, oldest first. */
  readonly items?: readonly ReplyItem[] | undefined;
}

/** One line for a model request the agent is waiting to try again. */
function retryMarkdown(retry: SectionRetry): string {
  const reason = flat(retry.reason);
  return `Retrying the model request (${retry.attempt} of ${retry.maxAttempts})${reason.length === 0 ? "" : `: ${reason}`}`;
}

interface TailItem {
  readonly at?: number | undefined;
  readonly order: number;
  readonly markdown: string;
  readonly item?: ReplyItem | undefined;
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
  messages: readonly Message[],
  speaker: string,
): Promise<Live> {
  const chat = chatData(object.data);
  const runId = latestRunOf(facts);
  const pending = statusPending(messages, facts);
  const times = runId !== undefined && ctx.runTimes !== undefined ? await ctx.runTimes(runId) : undefined;
  let tail: string | undefined;
  let read: TailRead | undefined;
  let retry: SectionRetry | undefined;
  let called: ReadonlySet<string> = new Set<string>();
  let secrets: readonly string[] = [];
  let cut: number | undefined;
  let items: readonly ReplyItem[] | undefined;
  let liveRun: string | undefined;
  if (runId !== undefined && chat.harness.length > 0 && ctx.runTimes !== undefined && times !== undefined && times.endedAt === null) {
    liveRun = runId;
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
    const waiting = read?.state.retry;
    // The retry's own line stamps when the wait began; a later line's time
    // would move `until` on every read, so it is not used as a fallback.
    const retryAt = waiting?.at;
    retry =
      waiting === undefined || retryAt === undefined
        ? undefined
        : {
            attempt: waiting.attempt,
            maxAttempts: waiting.maxAttempts,
            until: retryAt + waiting.delayMs,
            reason: maskSecrets(waiting.reason, secrets),
          };
    if (read !== undefined) {
      const fresh = (text: string): string | undefined => {
        const masked = maskSecrets(text, secrets);
        return masked.trim().length === 0 || said.has(masked.trim()) ? undefined : masked;
      };
      const tailItems: TailItem[] = [];
      const push = (at: number | null | undefined, markdown: string | undefined, item?: ReplyItem): void => {
        if (markdown === undefined || markdown.trim().length === 0) return;
        tailItems.push({
          ...(at === null || at === undefined ? {} : { at }),
          order: tailItems.length,
          markdown,
          ...(item === undefined ? {} : { item }),
        });
      };
      // A finished entry is shown until the facts hold it; then `said` and `called` drop it.
      for (const entry of read.state.entries) {
        // Radian gives no text or thinking increments; its chats show tool lines only.
        if (chat.harness === "radian" && entry.kind !== "tool") continue;
        const item = replyItemOfFold(entry, secrets);
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
            item,
          );
          continue;
        }
        const text = fresh(entry.text);
        if (text === undefined) continue;
        push(entry.at, entryMarkdown({ ...entry, text }, speaker, chat.harness), item);
      }
      // Radian gives no text or thinking increments; its chats show the tool lines only.
      if (chat.harness !== "radian") {
        const thinking = fresh(read.state.thinking);
        if (thinking !== undefined) {
          push(
            read.lastAt,
            thinking.split(/\r?\n/).map((line) => `> ${line}`).join("\n"),
            { kind: "thinking", text: thinking.trim(), ...(read.lastAt === undefined ? {} : { at: read.lastAt }) },
          );
        }
        const text = fresh(read.state.text);
        if (text !== undefined) {
          push(read.lastAt, `**${speaker}:** ${block(text)}`, {
            kind: "text",
            text: block(text),
            ...(read.lastAt === undefined ? {} : { at: read.lastAt }),
          });
        }
      }
      for (const call of read.state.calls) {
        if (calls.has(maskSecrets(call.callId, secrets))) continue;
        const input = call.input === null ? "" : flat(maskSecrets(call.input, secrets));
        const what = input.length === 0 ? "" : ` ${inlineCode(input.length <= 160 ? input : `${input.slice(0, 159)}…`)}`;
        push(
          call.at,
          `tool ${maskSecrets(call.toolName, secrets)} since ${clock(call.at)}${what}`,
          replyItemOfOpenCall(call, secrets),
        );
      }
      if (retry !== undefined) push(undefined, retryMarkdown(retry));
      const structured = tailItems.flatMap((item) => (item.item === undefined ? [] : [item.item]));
      if (structured.length > 0) items = structured;
      tail = cut === undefined
        ? (tailItems.length === 0 ? undefined : tailItems.map((item) => item.markdown).join("\n\n"))
        : heldTail(facts, cut, tailItems, speaker, ctx.home, chat.harness);
    } else if (retry !== undefined) {
      tail = retryMarkdown(retry);
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
    ...(retry === undefined ? {} : { retry }),
    ...(cut === undefined ? {} : { cut }),
    ...(liveRun === undefined ? {} : { run: liveRun }),
    ...(items === undefined ? {} : { items }),
  };
}

/** The line that marks where a segment starts: its title and its date (UTC); the date alone while it has no title. */
export function segmentMarker(segment: Segment): string {
  const date = new Date(segment.at).toISOString().slice(0, 10);
  return `### ${segment.title.length > 0 ? `${segment.title} · ` : ""}${date}`;
}

function firstSequence(chunk: Chunk): number {
  return chunk.facts.reduce((least, fact) => Math.min(least, fact.sequence), Number.MAX_SAFE_INTEGER);
}

/** The first chunk after each segment's beginning: where its marker goes. The first segment has none. */
function segmentStarts(chunks: readonly Chunk[], segments: readonly Segment[]): ReadonlyMap<Chunk, Segment> {
  const starts = new Map<Chunk, Segment>();
  for (const segment of segments) {
    if (segment.kind === "first") continue;
    const chunk = chunks.find((candidate) => firstSequence(candidate) > segment.sequence);
    if (chunk !== undefined && !starts.has(chunk)) starts.set(chunk, segment);
  }
  return starts;
}

/** What a chunk renders as, led by the marker of the segment that starts with it. */
function chunkBlocks(
  chunk: Chunk,
  starts: ReadonlyMap<Chunk, Segment>,
  speaker: string,
  home: string | undefined,
  harness: string,
): readonly string[] {
  const start = starts.get(chunk);
  return [...(start === undefined ? [] : [segmentMarker(start)]), ...rendered(chunk, speaker, home, harness)];
}

/** One page of chunks from `start`, by the size rule `pagesOf` follows. */
function pageFrom(ref: ObjectRef, chunks: readonly Chunk[], start: number): Page & { readonly end: number } {
  const pageChunks: Chunk[] = [];
  let messages = 0;
  let index = start;
  while (index < chunks.length) {
    const chunk = chunks[index];
    if (chunk === undefined) break;
    if (pageChunks.length > 0 && messages + chunk.messages > TRANSCRIPT_PAGE) break;
    pageChunks.push(chunk);
    messages += chunk.messages;
    index += 1;
    if (messages >= TRANSCRIPT_PAGE) break;
  }
  const before = chunks[start - 1]?.last;
  return {
    chunks: pageChunks,
    after: before,
    cursor: before === undefined ? undefined : factsCursor(ref, before),
    end: index,
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Where a person's own words ask the transcript to start: `segment:<n>`,
 * `date:<YYYY-MM-DD>` (UTC, the first thing on or after that day) or
 * `message:<id>`. The index of the first chunk shown, or undefined for a cursor
 * that is none of these.
 */
function startOf(
  cursor: string,
  chunks: readonly Chunk[],
  segments: readonly Segment[],
  starts: ReadonlyMap<Chunk, Segment>,
): number | undefined {
  const colon = cursor.indexOf(":");
  if (colon < 0) return undefined;
  const kind = cursor.slice(0, colon);
  const value = cursor.slice(colon + 1);
  if (kind === "segment") {
    const segment = segments.find((candidate) => String(candidate.number) === value);
    if (segment === undefined) throw new CursorError(`chat transcript: there is no segment ${value}`);
    if (segment.kind === "first") return 0;
    const at = chunks.findIndex((chunk) => starts.get(chunk) === segment);
    if (at < 0) throw new CursorError(`chat transcript: segment ${value} has nothing to show`);
    return at;
  }
  if (kind === "date") {
    const day = DAY.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
    if (Number.isNaN(day)) throw new CursorError("chat transcript: a date is written YYYY-MM-DD");
    const at = chunks.findIndex((chunk) => chunk.facts.some((fact) => fact.at >= day));
    if (at < 0) throw new CursorError(`chat transcript: nothing on or after ${value}`);
    return at;
  }
  if (kind === "message") {
    const at = chunks.findIndex((chunk) => chunk.facts.some((fact) => fact.type === MESSAGE_FACT && fact.data.id === value));
    if (at < 0) throw new CursorError(`chat transcript: there is no message ${value}`);
    return at;
  }
  return undefined;
}

async function load(
  ctx: ViewContext,
  object: StoredObject,
  sectionId: string,
  options: { readonly cursor?: string | undefined; readonly after?: string | undefined; readonly full?: boolean | undefined },
): Promise<SectionContent> {
  if (sectionId !== TRANSCRIPT) return { markdown: "" };
  const ref = chatRef(object.id);
  const chat = chatData(object.data);
  const read = readChat(ctx.store, object.id);
  const speaker = await speakerOf(ctx, object, true);
  const facts = messageFactsInForce(read.facts);
  const messages = read.messages;
  const queued = queuedData(queuedMessages(messages, facts));
  const segments = segmentsOf(read.facts, chat.title.length > 0 ? chat.title : object.id);
  const queueData: Record<string, JsonValue> = {
    queued: queued as unknown as JsonValue,
    queuedCount: queued.length,
    // A chat with one segment has nothing to jump between.
    ...(segments.length < 2
      ? {}
      : {
          segments: segments.map((segment) => ({
            number: segment.number,
            at: segment.at,
            kind: segment.kind,
            title: segment.title,
            cursor: `segment:${segment.number}`,
          })) as unknown as JsonValue,
        }),
  };
  const live = await liveOf(ctx, object, facts, messages, speaker);
  const { cut, run: liveRun, items: liveItems, ...liveContent } = live;
  const liveBlock =
    liveRun === undefined
      ? undefined
      : liveReply(facts, messages, { runId: liveRun, items: liveItems ?? [] }, ctx.home);
  const limit = options.full === true ? Number.POSITIVE_INFINITY : ctx.sectionCapBytes ?? DEFAULT_SECTION_CAP_BYTES;
  // A message the live tail holds stays unread as finished content until the
  // run ends, so the same facts then arrive together with the reply's items.
  const finished = cut === undefined ? facts : facts.filter((fact) => fact.sequence <= cut);
  const context = chatContext(object, read);
  const since = markAfter(options.after);
  const finishedChunks = chunksOf(finished);
  if (since !== undefined) {
    // Only what was recorded after the mark, in the same Markdown as a full read.
    const chunks = chunksOf(finished.filter((fact) => fact.sequence > since));
    const sinceStarts = segmentStarts(chunks, segments.filter((segment) => segment.sequence > since));
    const blocks = chunks.flatMap((chunk) => chunkBlocks(chunk, sinceStarts, speaker, ctx.home, chat.harness));
    const markdown = blocks.join("\n\n---\n\n");
    // The replies whose answer is after the mark, and the one still running.
    const sinceChunks = finishedChunks.filter((chunk) => {
      const answer = answerIn(chunk);
      return answer !== undefined && answer.sequence > since;
    });
    const firstSince = sinceChunks
      .map((chunk) => answerIn(chunk)?.sequence)
      .find((sequence): sequence is number => sequence !== undefined);
    const changed = storedReplies(
      sinceChunks,
      messages,
      ctx.home,
      firstSince === undefined ? -1 : answerBefore(finishedChunks, firstSince),
    );
    const replies = liveBlock === undefined ? changed : [...changed, liveBlock];
    const data = replyData(
      replies.map((reply) => reply.block),
      Math.max(0, limit - Buffer.byteLength(markdown, "utf8") - Buffer.byteLength(liveContent.tail ?? "", "utf8")),
      withDeliveries(queueData, chunks),
    );
    return {
      markdown,
      mark: markOf(Math.max(since, chunks.at(-1)?.last ?? 0)),
      delta: true,
      ...liveContent,
      ...(context === undefined ? {} : { context }),
      data,
    };
  }
  const pages = pagesOf(ref, finishedChunks);
  const starts = segmentStarts(finishedChunks, segments);
  const asked = options.cursor === undefined ? undefined : startOf(options.cursor, finishedChunks, segments, starts);
  const after = options.cursor === undefined || asked !== undefined ? undefined : cursorAfter(options.cursor);
  const aligned = pages.findIndex((page) => page.after === after);
  // A page of the table of contents; or one that starts where a segment, a day or
  // a message is, or right after such a page.
  const through = after === undefined ? -1 : finishedChunks.findIndex((chunk) => chunk.last === after);
  const from = asked ?? (aligned < 0 && through >= 0 ? through + 1 : undefined);
  const free = from === undefined ? undefined : pageFrom(ref, finishedChunks, from);
  const index = free === undefined ? aligned : -1;
  const selected = free ?? pages[index < 0 ? 0 : index] ?? pages[0];
  const pageIndex = index < 0 ? 0 : index;
  const pageChunks = selected?.chunks ?? [];
  const firstOnPage = pageChunks[0]?.facts[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
  const onPageBlocks = storedReplies(
    pageChunks,
    messages,
    ctx.home,
    answerBefore(finishedChunks, firstOnPage),
  );
  const lastPage = free === undefined ? pageIndex === pages.length - 1 : free.end >= finishedChunks.length;
  const pageReplies = lastPage && liveBlock !== undefined
    ? [...onPageBlocks, liveBlock]
    : onPageBlocks;
  const blocks = (selected?.chunks ?? []).flatMap((chunk) => chunkBlocks(chunk, starts, speaker, ctx.home, chat.harness));
  const body = blocks.length === 0 && options.cursor === undefined ? "No messages yet." : blocks.join("\n\n---\n\n");
  // Every page says which agent answers, as the row does.
  const markdown = chat.harness.length > 0
    ? `Agent: ${agentLine(chat)}\n\n${body}`
    : body;
  const nextCursor =
    free === undefined
      ? index < 0
        ? undefined
        : pages[index + 1]?.cursor
      : free.end < finishedChunks.length
        ? factsCursor(ref, free.chunks.at(-1)?.last ?? 0)
        : undefined;
  const data = replyData(
    pageReplies.map((reply) => reply.block),
    Math.max(0, limit - Buffer.byteLength(markdown, "utf8") - Buffer.byteLength(liveContent.tail ?? "", "utf8")),
    withDeliveries(queueData, pageChunks),
  );

  // The table of contents: the cursor each page starts at, the first one without.
  const toc: SectionPage[] = pages.map((page, at) =>
    at === 0 || page.cursor === undefined
      ? { label: `Page ${at + 1}` }
      : { label: `Page ${at + 1}`, cursor: page.cursor },
  );
  return {
    markdown,
    mark: markOf(selected?.chunks.at(-1)?.last ?? 0),
    ...(nextCursor === undefined ? {} : { next: nextCursor }),
    ...(toc.length > 1 ? { pages: toc } : {}),
    ...liveContent,
    ...(context === undefined ? {} : { context }),
    data,
  };
}

/** Reads an object through its type's `prepare`, or the store when the view has none. */
function objectReader(ctx: ViewContext): ObjectReader {
  return async (type, id) =>
    ctx.refreshedObject === undefined ? ctx.store.get(type, id) : ctx.refreshedObject(type, id);
}

/**
 * The changing part of the transcript, for the event stream's live push. It
 * is the same tail and status a section read returns, without the finished
 * content, so a client renders what the reply writes as it arrives.
 */
async function tailPush(
  ctx: ViewContext,
  object: StoredObject,
): Promise<{ readonly section: string; readonly tail?: string; readonly status?: SectionStatus; readonly retry?: SectionRetry; readonly data?: Readonly<Record<string, JsonValue>> } | undefined> {
  const read = readChat(ctx.store, object.id);
  const facts = messageFactsInForce(read.facts);
  const messages = read.messages;
  const speaker = await speakerOf(ctx, object);
  const live = await liveOf(ctx, object, facts, messages, speaker);
  const liveBlock = live.run === undefined
    ? undefined
    : liveReply(facts, messages, { runId: live.run, items: live.items ?? [] }, ctx.home);
  const limit = ctx.sectionCapBytes ?? DEFAULT_SECTION_CAP_BYTES;
  const data = liveBlock === undefined
    ? undefined
    : replyData(
        [liveBlock.block],
        Math.max(0, limit - Buffer.byteLength(live.tail ?? "", "utf8")),
      );
  if (live.tail === undefined && live.status === undefined && live.retry === undefined && data === undefined) {
    return undefined;
  }
  return {
    section: TRANSCRIPT,
    ...(live.tail === undefined ? {} : { tail: live.tail }),
    ...(live.status === undefined ? {} : { status: live.status }),
    ...(live.retry === undefined ? {} : { retry: live.retry }),
    ...(data === undefined ? {} : { data }),
  };
}

/** Whether a requested path is one the chat's own facts name, never one a client chose. */
async function file(ctx: ViewContext, object: StoredObject, path: readonly string[]): Promise<boolean> {
  if (
    path.length === 0 ||
    path.some(
      (part) => part.length === 0 || part === "." || part === ".." || part.includes("/") || part.includes("\\"),
    )
  ) {
    return false;
  }
  const requested = join(attachmentDir(ctx.home, CHAT_TYPE, object.id), ...path);
  const named = new Set<string>();
  for (const fact of factsOf(ctx.store, chatRef(object.id))) {
    if (fact.type === MESSAGE_FACT) {
      for (const attachment of attachmentsOf(fact.data.attachments)) named.add(attachment.path);
    } else if (fact.type === ENTRY_FACT) {
      const entry = entryOfFact(fact);
      if (entry?.outputPath !== undefined) named.add(entry.outputPath);
    }
  }
  return named.has(requested);
}

/** The views of the chat type. */
export const chatViews: ObjectViews = {
  row,
  sections,
  context: (ctx, object) => chatContext(object, readChat(ctx.store, object.id)),
  skills: async (ctx, object) =>
    skillSummaries(await readChatSkills(chatData(object.data), objectReader(ctx))),
  file,
  tail: tailPush,
  load,
};
