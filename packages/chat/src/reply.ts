/**
 * The `chat/reply` step: one round of an answer. It builds the prompt from the
 * chat's unanswered messages, continues the chat's harness session, records the
 * reply as a fact and looks again for messages that came meanwhile; the flow
 * goes round again while there are some. The kernel keeps no prompt text.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AskTimeoutError, attachmentDir, isRecord, messageOf, safeFileName, type AskOutcome, type AskRequest, type JsonValue, type PluginStepResult, type RunObject, type StepAsker, type StepContext } from "@operad-io/engine";
import { emptyFold, foldLines, maskSecrets, type FoldEntry, type FoldState } from "@operad-io/harness-process";
import {
  allEntries,
  allMessages,
  chatFacts,
  IMAGE_TYPES,
  chatData,
  type ChatData,
  type CostQuality,
  chatRef,
  currentSession,
  ENTRY_FACT,
  latestRunOf,
  MESSAGE_FACT,
  RUN_FACT,
  newMessageId,
  promptFor,
  unanswered,
  usageOf,
  worseQuality,
  CHAT_TYPE,
  type EntryData,
  type Message,
  type MessageData,
} from "./model.ts";

/**
 * Brings the chat object in line with its facts: the session after a reply, and
 * the model and the cost so far, summed from the replies recorded. Reading the
 * facts, not adding to the object, makes a rerun after a crash end in the same state.
 */
async function syncChat(ctx: StepContext, id: string, session: string | undefined): Promise<void> {
  const fresh = await ctx.store.get(CHAT_TYPE, id);
  if (fresh === undefined) return;
  const next: Record<string, unknown> = { ...fresh.data };
  if (session !== undefined) next.session = session;
  let micros: number | undefined;
  let quality: CostQuality | undefined;
  for (const message of allMessages(ctx.store, id)) {
    if (message.role !== "assistant") continue;
    if (message.model !== undefined) next.lastModel = message.model;
    if (message.costMicros !== undefined) {
      micros = (micros ?? 0) + message.costMicros;
      quality = worseQuality(quality, message.costQuality);
    }
  }
  if (micros !== undefined) next.costMicros = micros;
  if (quality !== undefined) next.costQuality = quality;
  if (JSON.stringify(next) !== JSON.stringify(fresh.data)) {
    await ctx.store.put(CHAT_TYPE, id, next, "step:chat/reply");
  }
}

/** The question a read-only chat asks when the call is not known. */
export const WORKTREE_QUESTION =
  "The agent wants to change code, and this chat is read-only. Open a worktree for it?";

/** How the worktree question starts and ends; what is between names the call. */
const WORKTREE_QUESTION_START = "The agent wants to ";
const WORKTREE_QUESTION_END = " in this read-only chat. Open a worktree for it?";

/** The longest call the question shows; the ask keeps the whole call. */
export const WORKTREE_CALL_LIMIT = 120;

/** What a read-only chat tells its agent after it refused a call. */
export const READ_ONLY_REFUSAL =
  "The call was refused because this chat is read-only. Answer in the chat or use read-only commands.";

/** The answers to the worktree question. */
export const WORKTREE_CHOICES = ["yes", "no"] as const;

/** The event a "yes" sends; the plugin that owns the working directory acts on it. */
export const WORKTREE_EVENT = "chat.worktree";

/** The call a harness question asks about. */
export interface WorktreeCall {
  readonly kind: "command" | "path";
  readonly value: string;
  readonly tool?: string;
}

/** The call behind a write question: its grant, or the words of a question with no session. */
function worktreeCall(request: AskRequest): WorktreeCall | undefined {
  const resume = request.resume;
  if (isRecord(resume) && isRecord(resume.grant)) {
    const grant = resume.grant;
    if ((grant.kind === "command" || grant.kind === "path") && typeof grant.value === "string" && grant.value.length > 0) {
      return {
        kind: grant.kind,
        value: grant.value,
        ...(typeof grant.tool === "string" ? { tool: grant.tool } : {}),
      };
    }
  }
  const command = /^Run this command\? ([\s\S]+)$/.exec(request.prompt);
  if (command?.[1] !== undefined && command[1].trim().length > 0) {
    return { kind: "command", value: command[1] };
  }
  const path = /^Let (write|edit) use this path\? ([\s\S]+)$/.exec(request.prompt);
  if (path?.[1] !== undefined && path[2] !== undefined && path[2].trim().length > 0) {
    return { kind: "path", value: path[2], tool: path[1] };
  }
  return undefined;
}

/** One line, cut to what a question can show. */
function cutCall(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= WORKTREE_CALL_LIMIT
    ? oneLine
    : `${oneLine.slice(0, WORKTREE_CALL_LIMIT - 1)}…`;
}

/** The worktree question for one call. */
export function worktreeQuestion(call: WorktreeCall): string {
  const what =
    call.kind === "command"
      ? `run \`${cutCall(call.value)}\``
      : `${call.tool === "edit" ? "edit" : "write"} \`${cutCall(call.value)}\``;
  return `${WORKTREE_QUESTION_START}${what}${WORKTREE_QUESTION_END}`;
}

/** Whether a prompt is a worktree question, including the older one without a call. */
export function isWorktreeQuestion(prompt: string): boolean {
  return (
    prompt === WORKTREE_QUESTION ||
    (prompt.startsWith(WORKTREE_QUESTION_START) && prompt.endsWith(WORKTREE_QUESTION_END))
  );
}

/** The session and the full call a late answer needs; the full call stays in the history. */
function worktreeResume(request: AskRequest, call: WorktreeCall | undefined): JsonValue {
  const session = sessionOnly(request.resume);
  return {
    ...(session === null ? {} : session),
    ...(call === undefined
      ? {}
      : {
          call: {
            kind: call.kind,
            value: call.value,
            ...(call.tool === undefined ? {} : { tool: call.tool }),
          },
        }),
  };
}

/**
 * Whether a harness question is about a call in the working directory: a
 * path write or edit, or a shell command. A read-only chat lets no such call
 * through on a one-time permission (the profile already let the read-only ones
 * run), so each becomes the worktree question.
 */
export function isWriteQuestion(request: AskRequest): boolean {
  const resume = request.resume;
  if (isRecord(resume) && isRecord(resume.grant)) {
    const grant = resume.grant;
    if (grant.kind === "command") return true;
    return grant.kind === "path" && (grant.tool === "write" || grant.tool === "edit");
  }
  // A question with no session to continue carries no grant; its words say what it is about.
  return /^(?:Run this command\?|Let (?:write|edit) use this path\?)/.test(request.prompt);
}

function failed(reason: string, message: string): PluginStepResult {
  return { result: "failed", data: { reason, message } };
}

/**
 * The asker a read-only chat's harness gets: a question about writing a file
 * becomes the worktree question and never a one-time permission; any other
 * question goes where it would have gone.
 */
function readOnlyAsker(ctx: StepContext, onYes: () => Promise<void>): StepAsker {
  return {
    async ask(request): Promise<AskOutcome> {
      const write = isWriteQuestion(request);
      const call = write ? worktreeCall(request) : undefined;
      const shaped: AskRequest = write
        ? {
            prompt: call === undefined ? WORKTREE_QUESTION : worktreeQuestion(call),
            choices: [...WORKTREE_CHOICES],
            ...(request.resume === undefined ? {} : { resume: worktreeResume(request, call) }),
            ...(request.onTimeout === undefined ? {} : { onTimeout: request.onTimeout }),
            ...(request.graceSecs === undefined ? {} : { graceSecs: request.graceSecs }),
          }
        : request;
      try {
        const answer = await ctx.ask(shaped);
        if (shaped === request) return { kind: "answered", answer };
        if (answer.choice === "yes") await onYes();
        // The call itself is never let through in the main clone. A no says why.
        return {
          kind: "answered",
          answer: {
            choice: "reject_once",
            ...(answer.choice === "yes" ? {} : { note: READ_ONLY_REFUSAL }),
            ...(answer.actor === undefined ? {} : { actor: answer.actor }),
          },
        };
      } catch (error) {
        if (error instanceof AskTimeoutError) {
          return {
            kind: "timeout",
            waitId: error.waitId,
            prompt: error.prompt,
            choices: error.choices,
          };
        }
        throw error;
      }
    },
    useGrant: (waitId) => ctx.useGrant(waitId),
  };
}

/** What a late answer needs: the session, and no permission for the call. */
function sessionOnly(resume: unknown): { readonly session: string } | null {
  if (isRecord(resume) && typeof resume.session === "string") {
    return { session: resume.session };
  }
  return null;
}

/** The params of the step the kernel gives back after a question was answered. */
function answeredQuestion(
  params: unknown,
): { readonly prompt: string; readonly choice: string; readonly note?: string } | undefined {
  if (!isRecord(params) || !isRecord(params.askAnswer)) return undefined;
  const { prompt, choice, note } = params.askAnswer;
  if (typeof prompt !== "string" || typeof choice !== "string") return undefined;
  return { prompt, choice, ...(typeof note === "string" ? { note } : {}) };
}

/** The harnesses that take an image as input; any other gets every file as a path. */
export const IMAGE_HARNESSES = ["claude", "pi"] as const;

/** The largest image given as image input; a bigger one goes as a path only. */
export const IMAGE_INPUT_MAX_BYTES = 5 * 1024 * 1024;

/** An image given to a harness: where it is, and its media type. */
export interface ImageInput {
  readonly path: string;
  readonly mediaType: string;
}

/**
 * The images of the messages to answer that the harness takes as input. Only a
 * file under this chat's attachment directory counts: a path a message names
 * from elsewhere is never read.
 */
export function imagesOf(pending: readonly Message[], harness: string, directory: string): readonly ImageInput[] {
  if (!(IMAGE_HARNESSES as readonly string[]).includes(harness)) return [];
  const images: ImageInput[] = [];
  for (const message of pending) {
    for (const file of message.attachments) {
      if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) continue;
      if (!file.path.startsWith(`${directory}/`) || file.path.includes("/../")) continue;
      if (file.size > IMAGE_INPUT_MAX_BYTES) continue;
      images.push({ path: file.path, mediaType: file.type });
    }
  }
  return images;
}

/** What a chat's `refresh` step gives back. */
interface Live {
  readonly cwd: string;
  readonly access: Readonly<Record<string, JsonValue>>;
  readonly skills: readonly string[];
  /** Servers the harness starts for the agent, by name, each as a command. */
  readonly mcpServers: Readonly<Record<string, JsonValue>>;
}

/**
 * The working directory, access profile and skills for this reply: the
 * chat's own, or what its `refresh` step says now. A reply that cannot read
 * them fails; it never falls back to the older, possibly looser, copy.
 */
async function liveSettings(
  ctx: StepContext,
  chat: ChatData,
  object: RunObject,
  runStep: NonNullable<StepContext["runStep"]>,
): Promise<Live | PluginStepResult> {
  const own: Live = { cwd: chat.cwd, access: chat.access, skills: chat.skills, mcpServers: {} };
  if (chat.refresh === undefined) return own;
  if (ctx.stepLoaded !== undefined && !ctx.stepLoaded(chat.refresh)) {
    return failed("settings", `"${chat.refresh}", which gives this chat's settings, is not loaded`);
  }
  let outcome: PluginStepResult;
  try {
    outcome = await runStep(chat.refresh, { chat: object.id }, { runId: ctx.runId, object, params: ctx.params, signal: ctx.signal });
  } catch (error) {
    return failed("settings", messageOf(error));
  }
  const data = isRecord(outcome.data) ? outcome.data : {};
  if (outcome.result !== "done") {
    return failed("settings", typeof data.message === "string" ? data.message : "the chat's settings could not be read");
  }
  if (typeof data.cwd !== "string" || data.cwd.length === 0 || !isRecord(data.access) || !Array.isArray(data.skills)) {
    return failed("settings", "the chat's settings came back in a shape the chat cannot use");
  }
  return {
    cwd: data.cwd,
    access: data.access as Record<string, JsonValue>,
    skills: data.skills.filter((item): item is string => typeof item === "string"),
    mcpServers: isRecord(data.mcpServers) ? (data.mcpServers as Record<string, JsonValue>) : {},
  };
}

/**
 * The profile with the chat's attachment directory readable and nothing else
 * added: the access profile's `readPaths` lets reads through a deny of the
 * operad home, and a write there still asks.
 */
export function withAttachmentReads(
  access: Readonly<Record<string, JsonValue>>,
  directory: string,
): Readonly<Record<string, JsonValue>> {
  const own = Array.isArray(access.readPaths) ? access.readPaths : [];
  return { ...access, readPaths: [...own, directory] };
}

/** How much of a tool call's output a fact keeps; the rest goes to a file. */
export const TOOL_OUTPUT_FACT_BYTES = 4 * 1024;

/** Cuts text to a byte count without splitting a character. */
function cutUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** The file that holds a tool call's whole output, under the chat's own directory. */
export function toolOutputPath(home: string, chat: string, runId: string, callId: string): string {
  return join(
    attachmentDir(home, CHAT_TYPE, chat),
    "tool-output",
    safeFileName(runId),
    `${safeFileName(callId)}.txt`,
  );
}

/** The chat's own secret values, so nothing recorded or written can carry one. */
export async function secretValues(ctx: Pick<StepContext, "secrets">): Promise<readonly string[]> {
  try {
    const values: string[] = [];
    for (const name of await ctx.secrets.names()) {
      const secret = await ctx.secrets.get(name);
      if (secret !== undefined) values.push(secret.reveal());
    }
    return values;
  } catch {
    return [];
  }
}

/** The entries to record: what finished, and the reply a stopped run got only half way through. */
function entriesToRecord(
  folded: FoldState,
  options: { readonly finalText?: string | undefined; readonly stopped: boolean },
  secrets: readonly string[],
): readonly (FoldEntry | { readonly kind: "stopped"; readonly text: string })[] {
  const entries: (FoldEntry | { readonly kind: "stopped"; readonly text: string })[] = [...folded.entries];
  // What is still only an increment is not an entry. A stopped run keeps the
  // text it got half way through; finished text and thinking are already above.
  if (options.stopped && folded.text.length > 0) entries.push({ kind: "stopped", text: folded.text });
  // The final reply is a chat.message of its own; its text is not an entry too.
  if (options.finalText !== undefined) {
    const final = options.finalText.trim();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      // `finalText` is already masked, so compare the entry after masking too.
      if (entry?.kind === "text" && maskSecrets(entry.text, secrets).trim() === final) {
        entries.splice(index, 1);
        break;
      }
    }
  }
  return entries;
}

/** One folded entry as a fact's data, with secrets masked and a long output written to a file. */
async function entryData(
  ctx: StepContext,
  chat: string,
  runId: string,
  entry: FoldEntry | { readonly kind: "stopped"; readonly text: string },
  secrets: readonly string[],
): Promise<EntryData> {
  if (entry.kind !== "tool") {
    return { runId, kind: entry.kind, text: maskSecrets(entry.text, secrets) };
  }
  const output = entry.output === null ? null : maskSecrets(entry.output, secrets);
  const data: EntryData = {
    runId,
    kind: "tool",
    callId: maskSecrets(entry.callId, secrets),
    toolName: maskSecrets(entry.toolName, secrets),
    input: entry.input === null ? null : maskSecrets(entry.input, secrets),
    result: entry.result,
    startedAt: entry.at,
    durationMs: entry.durationMs,
    output,
    error: entry.error === null ? null : maskSecrets(entry.error, secrets),
    ...(entry.outputTruncated ? { outputTruncated: true } : {}),
  };
  // The harness's output decides whether it needs a file; masking does not
  // make a long output short enough to leave no file behind.
  if (output === null || new TextEncoder().encode(entry.output ?? "").length <= TOOL_OUTPUT_FACT_BYTES) return data;
  const path = toolOutputPath(ctx.home, chat, runId, entry.callId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output, "utf8");
  return { ...data, output: cutUtf8(output, TOOL_OUTPUT_FACT_BYTES), outputPath: path };
}

/** The key that tells a repeated entry from a new one. A tool call is its call id. */
function entryKey(entry: EntryData): string {
  return entry.kind === "tool" ? `tool:${entry.callId ?? ""}` : `${entry.kind}:${entry.text ?? ""}`;
}

/**
 * Records the finished entries on the chat. A step that runs again after a
 * restart emits the same tool calls again: a call id already recorded is
 * skipped, and text that an unanswered attempt already left is not added twice.
 */
async function recordEntries(
  ctx: StepContext,
  chat: string,
  folded: FoldState,
  options: { readonly finalText?: string | undefined; readonly stopped: boolean },
): Promise<void> {
  const secrets = await secretValues(ctx);
  const wanted = entriesToRecord(folded, options, secrets);
  if (wanted.length === 0) return;
  const existing = allEntries(ctx.store, chat);
  const lastReply = new Map<string, number>();
  for (const message of allMessages(ctx.store, chat)) {
    if (message.role !== "assistant" || message.runId === undefined) continue;
    lastReply.set(message.runId, Math.max(lastReply.get(message.runId) ?? 0, message.sequence));
  }
  // An entry with no reply after it belongs to an attempt that never finished.
  const unansweredEntries = existing.filter((entry) => {
    const reply = lastReply.get(entry.runId);
    return reply === undefined || reply < entry.sequence;
  });
  const counts = new Map<string, number>();
  for (const entry of unansweredEntries) {
    const key = entryKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const callIds = new Set(
    existing
      .filter((entry) => entry.kind === "tool" && entry.callId !== undefined)
      .map((entry) => entry.callId as string),
  );
  for (const entry of wanted) {
    if (entry.kind === "tool" && callIds.has(entry.callId)) continue;
    const data = await entryData(ctx, chat, ctx.runId, entry, secrets);
    if (data.kind === "tool") {
      if (data.callId !== undefined) callIds.add(data.callId);
    } else {
      const key = entryKey(data);
      const seen = counts.get(key) ?? 0;
      if (seen > 0) {
        counts.set(key, seen - 1);
        continue;
      }
    }
    await ctx.facts.append({ type: ENTRY_FACT, object: chatRef(chat), data });
  }
}

/** Runs one round of an answer; see the file's comment. */
export async function runReply(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
  const object = ctx.object;
  if (object === undefined || object.type !== CHAT_TYPE) {
    return failed("object", "chat:reply runs on a chat");
  }
  const stored = await ctx.store.get(CHAT_TYPE, object.id);
  if (stored === undefined) return failed("object", `there is no chat ${object.id}`);
  const chat = chatData(stored.data);
  const messages = allMessages(ctx.store, object.id);
  const pending = unanswered(messages);
  if (pending.length === 0) {
    // A run that stopped after recording a reply still owes the chat its model and cost.
    await syncChat(ctx, object.id, undefined);
    return { result: "done", data: { answered: 0 } };
  }

  const runStep = ctx.runStep;
  if (runStep === undefined) return failed("host", "the kernel did not offer a way to run the agent");
  const use = `${chat.harness}/agent`;
  if (ctx.stepLoaded !== undefined && !ctx.stepLoaded(use)) {
    return failed("harness", `the agent "${chat.harness}" is not loaded`);
  }

  // A model the agent cannot take fails the reply by name; it never falls back.
  if (chat.model !== undefined && ctx.harnessModels?.(chat.harness)?.list.includes(chat.model) !== true) {
    return failed("model", `the agent "${chat.harness}" cannot use the model "${chat.model}"`);
  }
  // The same for an effort: the agent's list is the only one that can take it.
  const efforts = ctx.harnessEfforts?.(chat.harness);
  if (chat.effort !== undefined && efforts?.list.includes(chat.effort) !== true) {
    return failed("effort", `the agent "${chat.harness}" cannot use the effort "${chat.effort}"`);
  }
  const effortFlag = efforts?.flag ?? (chat.harness === "pi" ? "--thinking" : "--effort");

  const settled = await liveSettings(ctx, chat, object, runStep);
  if ("result" in settled) return settled;
  const live = settled;

  const resumed = isRecord(params) ? params : {};
  const session =
    typeof resumed.resumeSession === "string" ? resumed.resumeSession : currentSession(chat, messages);
  const readOnly = live.access.readOnly === true;
  let worktreeAsked = 0;
  const asker = readOnly
    ? readOnlyAsker(ctx, async () => {
        worktreeAsked += 1;
        await ctx.emit({
          type: WORKTREE_EVENT,
          key: `${ctx.runId}:${worktreeAsked}`,
          object: `${CHAT_TYPE}:${object.id}`,
        });
      })
    : undefined;

  // A "yes" that came back after the wait (the grace had passed) is the same
  // answer as one given live. A "no" carries the same refusal a live answer gets.
  const late = answeredQuestion(params);
  const lateWorktree = readOnly && late !== undefined && isWorktreeQuestion(late.prompt);
  if (lateWorktree && late.choice === "yes") {
    await ctx.emit({
      type: WORKTREE_EVENT,
      key: `${ctx.runId}:late`,
      object: `${CHAT_TYPE}:${object.id}`,
    });
  }
  const askAnswer =
    lateWorktree && late.choice !== "yes"
      ? {
          prompt: late.prompt,
          choice: late.choice,
          note: late.note === undefined ? READ_ONLY_REFUSAL : `${READ_ONLY_REFUSAL}\n${late.note}`,
        }
      : resumed.askAnswer;

  // The files sent with a message: images as input where the harness takes
  // them, every file as a path, and the chat's own attachment directory open to reads.
  const directory = attachmentDir(ctx.home, CHAT_TYPE, object.id);
  const images = imagesOf(pending, chat.harness, directory);
  const access = messages.some((message) => message.attachments.length > 0)
    ? withAttachmentReads(live.access, directory)
    : live.access;

  // The harness hands each log line over as it writes it; the fold keeps what
  // is finished and what is still being written. None of this is stored until
  // the harness returns, so the final reply can be left out of the entries.
  let folded = emptyFold;
  const receiver = (line: string): void => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    folded = foldLines([value], folded);
  };

  // The run is a fact before the agent starts: a view finds the step's log by it.
  if (latestRunOf(chatFacts(ctx.store, object.id)) !== ctx.runId) {
    await ctx.facts.append({ type: RUN_FACT, object: chatRef(object.id), data: { runId: ctx.runId } });
  }

  let outcome: PluginStepResult;
  try {
    outcome = await runStep(
      use,
      {
        prompt: promptFor(pending, new Set(images.map((image) => image.path))),
        ...(images.length === 0 ? {} : { images }),
        cwd: live.cwd,
        ...(chat.model === undefined && chat.effort === undefined
          ? {}
          : {
              args: [
                ...(chat.model === undefined ? [] : ["--model", chat.model]),
                ...(chat.effort === undefined ? [] : [effortFlag, chat.effort]),
              ],
            }),
        ...(chat.effort === undefined ? {} : { effort: chat.effort }),
        ...(live.skills.length === 0 ? {} : { skills: live.skills }),
        // Operad's own tools, so the agent never runs the `operad` command.
        operadTools: { home: ctx.home },
        ...(Object.keys(live.mcpServers).length === 0 ? {} : { mcpServers: live.mcpServers }),
        ...(session === undefined ? {} : { resumeSession: session }),
        ...(askAnswer === undefined ? {} : { askAnswer }),
      },
      {
        runId: ctx.runId,
        cwd: live.cwd,
        object,
        params: ctx.params,
        access,
        ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
        signal: ctx.signal,
        receiver,
        ...(asker === undefined ? {} : { asker }),
      },
    );
  } catch (error) {
    await recordEntries(ctx, object.id, folded, { stopped: true });
    return failed("harness", messageOf(error));
  }

  if (outcome.result === "waiting") {
    await recordEntries(ctx, object.id, folded, { stopped: true });
    return { result: "waiting", ...(outcome.data === undefined ? {} : { data: outcome.data }) };
  }
  const data = isRecord(outcome.data) ? outcome.data : {};
  // A harness that stopped may name the part it wrote in its result instead of
  // sending finished increments; either way the half reply is kept.
  if (outcome.result !== "done" && folded.text.length === 0 && typeof data.finalMessage === "string" && data.finalMessage.trim().length > 0) {
    folded = { ...folded, text: data.finalMessage.trim() };
  }
  if (outcome.result === "interrupted") {
    await recordEntries(ctx, object.id, folded, { stopped: true });
    return { result: "interrupted", data };
  }
  if (outcome.result !== "done") {
    await recordEntries(ctx, object.id, folded, { stopped: true });
    return {
      result: "failed",
      data: {
        reason: typeof data.reason === "string" ? data.reason : "harness",
        message: typeof data.message === "string" ? data.message : `the agent ended "${outcome.result}"`,
      },
    };
  }
  const said = typeof data.finalMessage === "string" ? data.finalMessage.trim() : "";
  const text = maskSecrets(said, await secretValues(ctx));
  if (text.length === 0) {
    await recordEntries(ctx, object.id, folded, { stopped: true });
    return failed("empty", "the agent gave no reply");
  }
  const sessionId = typeof data.sessionId === "string" && data.sessionId.length > 0 ? data.sessionId : undefined;

  const usage = usageOf(data.usage);

  await recordEntries(ctx, object.id, folded, { finalText: text, stopped: false });

  // The reply is a fact before the step counts as done: a rerun reads it and
  // does not answer the same messages twice.
  const reply: MessageData = {
    id: newMessageId(),
    role: "assistant",
    from: { via: chat.harness, id: chat.harness },
    text,
    attachments: [],
    source: { kind: chat.harness, ref: null },
    replyTo: pending.map((message) => message.id),
    runId: ctx.runId,
    ...(sessionId === undefined ? {} : { session: sessionId }),
    ...usage,
  };
  await ctx.facts.append({ type: MESSAGE_FACT, object: chatRef(object.id), data: reply });

  // The chat's own reference follows; read again, so a change made meanwhile stays.
  await syncChat(ctx, object.id, sessionId);

  const left = unanswered(allMessages(ctx.store, object.id));
  return { result: left.length > 0 ? "more" : "done", data: { answered: pending.length, left: left.length } };
}
