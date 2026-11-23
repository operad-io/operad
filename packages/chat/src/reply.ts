/**
 * The `chat/reply` step: one round of an answer. It builds the prompt from the
 * chat's unanswered messages, continues the chat's harness session, records the
 * reply as a fact and looks again for messages that came meanwhile; the flow
 * goes round again while there are some. The kernel keeps no prompt text.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AskTimeoutError, type AgentCompaction, attachmentDir, isRecord, messageOf, modelIds, safeFileName, type AskOutcome, type AskRecheck, type AskRequest, type ChoiceInfo, type CostQuality, type JsonValue, type PluginStepResult, type RunObject, type StepAsker, type StepContext, type UsageTokens } from "@operad-io/engine";
import { isAccessLevel, match, MCP_TOOL, withAccessLevel, writeLiveAccess, type AccessLevel } from "@operad-io/access-match";
import {
  appendAlwaysAllow,
  alwaysAllowEntry,
  emptyFold,
  foldLines,
  maskSecrets,
  personStarted,
  readAlwaysAllow,
  type AlwaysAllowEntry,
  type FoldEntry,
  type FoldState,
  type MessageInbox,
} from "@operad-io/harness-process";
import { readSkills, skillMessage } from "./skills.ts";
import {
  ACCESS_FACT,
  ACCESS_LEVEL_INFO,
  accessLevelPath,
  ANSWER_FACT,
  answeredOfFact,
  attachmentsOf,
  ATTEMPT_END_FACT,
  attemptEndedOfFact,
  chatFacts,
  COMMAND_FACT,
  COMPACT_AT,
  COMPACT_FACT,
  COMPACT_FLUSH,
  compactRequested,
  type CommandData,
  IMAGE_TYPES,
  chatData,
  chosenEffort,
  type ChatData,
  type ChatNoteHashes,
  type ChatRead,
  type Entry,
  chatRef,
  currentSession,
  startsAfterNew,
  ENTRY_FACT,
  latestRunOf,
  MESSAGE_FACT,
  RUN_FACT,
  newMessageId,
  promptFor,
  readChat,
  replyContextOf,
  takenIds,
  unanswered,
  usageOf,
  worseQuality,
  timingsOf,
  CHAT_TYPE,
  type EntryData,
  type Message,
  type MessageData,
} from "./model.ts";
import { earlierRecordPointer, noteBlock, noteFilesOf, noteHashesAfter, notesToAttach, notesWrittenHere, readNoteFiles, type NoteFile } from "./notes.ts";
import { queueTestHooks, syncQueuedLocked, takeLocked, withQueueLock } from "./queue.ts";
import { agentLogPath, foldLogTail } from "./tail.ts";

/**
 * Brings the chat object in line with its facts: the session after a reply, and
 * the model and the cost so far, summed from the replies recorded. Reading the
 * facts, not adding to the object, makes a rerun after a crash end in the same state.
 */
async function syncChat(
  ctx: StepContext,
  id: string,
  session: string | undefined,
  contextCwd?: string | undefined,
  noteHashes?: ChatNoteHashes | undefined,
): Promise<void> {
  const fresh = await ctx.store.get(CHAT_TYPE, id);
  if (fresh === undefined) return;
  const next: Record<string, unknown> = { ...fresh.data };
  if (session !== undefined) next.session = session;
  if (contextCwd !== undefined) next.contextCwd = contextCwd;
  if (noteHashes !== undefined) next.noteHashes = noteHashes;
  let micros: number | undefined;
  let quality: CostQuality | undefined;
  let costMissing = false;
  let tokens: UsageTokens | undefined;
  let tokensMissing = false;
  for (const message of readChat(ctx.store, id).messages) {
    if (message.role !== "assistant") continue;
    if (message.model !== undefined) next.lastModel = message.model;
    if (message.costMicros === undefined) costMissing = true;
    else {
      micros = (micros ?? 0) + message.costMicros;
      quality = worseQuality(quality, message.costQuality);
    }
    if (message.tokens === undefined) tokensMissing = true;
    else {
      tokens = {
        input: (tokens?.input ?? 0) + message.tokens.input,
        output: (tokens?.output ?? 0) + message.tokens.output,
        cacheread: (tokens?.cacheread ?? 0) + message.tokens.cacheread,
        cachewrite: (tokens?.cachewrite ?? 0) + message.tokens.cachewrite,
      };
    }
  }
  if (micros !== undefined) {
    next.costMicros = micros;
    next.costQuality = costMissing ? worseQuality(quality, "incomplete") : quality;
  }
  if (tokens !== undefined) next.tokens = tokens;
  if (tokens !== undefined && tokensMissing) next.tokensIncomplete = true;
  else if (tokens !== undefined) delete next.tokensIncomplete;
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

/** The answers to the worktree question: the permission words, then the worktree offer. */
export const WORKTREE_ALLOW_ONCE = "Allow once";
export const WORKTREE_ALLOW_ALWAYS = "Always allow";
export const WORKTREE_DENY = "Deny";
export const WORKTREE_YES = "Open a worktree";
export const WORKTREE_CHOICES = [WORKTREE_ALLOW_ONCE, WORKTREE_ALLOW_ALWAYS, WORKTREE_DENY, WORKTREE_YES] as const;

/** What each worktree answer is, keyed by the words an answer sends. */
const WORKTREE_CHOICE_INFO: Readonly<Record<string, ChoiceInfo>> = {
  [WORKTREE_ALLOW_ONCE]: {
    label: WORKTREE_ALLOW_ONCE,
    hint: "Run this call once in the main clone.",
    role: "primary",
  },
  [WORKTREE_ALLOW_ALWAYS]: {
    label: WORKTREE_ALLOW_ALWAYS,
    hint: "Allow this exact call in every chat.",
  },
  [WORKTREE_DENY]: {
    label: WORKTREE_DENY,
    hint: "Refuse this call.",
  },
  [WORKTREE_YES]: {
    label: WORKTREE_YES,
    hint: "Move this chat to a writable worktree.",
  },
};

/** The worktree question's information for just the choices it offers here. */
export function worktreeChoiceInfo(
  choices: readonly string[] = WORKTREE_CHOICES,
): Readonly<Record<string, ChoiceInfo>> {
  const info: Record<string, ChoiceInfo> = {};
  for (const choice of choices) {
    const entry = WORKTREE_CHOICE_INFO[choice];
    if (entry !== undefined) info[choice] = entry;
  }
  return info;
}

type WorktreeAnswer = "allow_once" | "allow_always" | "deny" | "worktree";

/** The action a worktree answer asks for; the older yes/no and the internal names still answer. */
function worktreeAnswer(choice: string | undefined): WorktreeAnswer {
  switch (choice) {
    case WORKTREE_ALLOW_ONCE:
    case "allow_once":
      return "allow_once";
    case WORKTREE_ALLOW_ALWAYS:
    case "allow_always":
      return "allow_always";
    case WORKTREE_YES:
    case "yes":
      return "worktree";
    default:
      return "deny";
  }
}

/** The event a "yes" sends; the plugin that owns the working directory acts on it. */
export const WORKTREE_EVENT = "chat.worktree";

/** The event dev sends after opening a worktree, so the chat answers the same message there. */
export const WORKTREE_REPLY_EVENT = "dev.chat_reply";

/** Ends the asking reply when a person chooses the worktree; the caller opens it and starts the next reply. */
class WorktreeChosen extends Error {
  constructor() {
    super("the chat now works in a worktree");
    this.name = "WorktreeChosen";
  }
}

/** The call a harness question asks about. */
export interface WorktreeCall {
  readonly kind: "command" | "path";
  readonly value: string;
  readonly tool?: string;
}

/** One worktree call record, wherever it is written: its kind, value and tool. */
function callOf(record: unknown): WorktreeCall | undefined {
  if (!isRecord(record)) return undefined;
  const kind = record.kind;
  const value = record.value;
  const tool = record.tool;
  if ((kind !== "command" && kind !== "path") || typeof value !== "string" || value.length === 0) return undefined;
  return { kind, value, ...(typeof tool === "string" ? { tool } : {}) };
}

/** The call behind a write question: its grant, or the words of a question with no session. */
function worktreeCall(request: AskRequest): WorktreeCall | undefined {
  const resume = request.resume;
  if (isRecord(resume) && isRecord(resume.grant)) {
    const grant = callOf(resume.grant);
    if (grant !== undefined) return grant;
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
          // Either permission answer gives the late call its one-time permission.
          ...(session === null
            ? {}
            : {
                grant: {
                  kind: call.kind,
                  value: call.value,
                  choice: WORKTREE_ALLOW_ONCE,
                  choices: [WORKTREE_ALLOW_ONCE, WORKTREE_ALLOW_ALWAYS],
                  ...(call.kind === "path" && call.tool !== undefined ? { tool: call.tool } : {}),
                },
              }),
        }),
  };
}

/** Whether a user-layer entry covers this exact call and working directory. */
function remembered(entry: AlwaysAllowEntry, call: WorktreeCall, cwd: string): boolean {
  return (
    entry.cwd === cwd &&
    entry.kind === call.kind &&
    entry.value === call.value &&
    (call.kind === "command" || entry.tool === call.tool)
  );
}

/** Reads the user layer, logging a file that had to be treated as empty. */
async function userLayer(ctx: StepContext): Promise<readonly AlwaysAllowEntry[]> {
  const found = await readAlwaysAllow(ctx.home);
  if (found.problem !== undefined) await ctx.logger.write(found.problem);
  return found.entries;
}

/** Writes an `Always allow` answer to the user layer; a failure still lets this call run. */
async function rememberAlways(ctx: StepContext, call: WorktreeCall, cwd: string): Promise<void> {
  try {
    await appendAlwaysAllow(ctx.home, alwaysAllowEntry(call, cwd));
  } catch (error) {
    await ctx.logger.write(
      `Always allow could not be written to the user access file: ${messageOf(error)}; this call runs once`,
    );
  }
}

/** The full call from the grants a late answer brings, when the kernel made one. */
function callFromGrants(access: JsonValue): WorktreeCall | undefined {
  if (!isRecord(access) || !Array.isArray(access["grants"])) return undefined;
  for (const value of access["grants"]) {
    const call = callOf(value);
    if (call !== undefined) return call;
  }
  return undefined;
}

/** The call a late answer names in the worktree question, when no grant carries it. */
function callFromQuestion(prompt: string): WorktreeCall | undefined {
  const command = /^The agent wants to run `([\s\S]+)` in this read-only chat\. Open a worktree for it\?$/.exec(prompt);
  if (command?.[1] !== undefined && command[1].length > 0) return { kind: "command", value: command[1] };
  const path = /^The agent wants to (write|edit) `([\s\S]+)` in this read-only chat\. Open a worktree for it\?$/.exec(prompt);
  if (path?.[1] !== undefined && path[2] !== undefined && path[2].length > 0) {
    return { kind: "path", value: path[2], tool: path[1] };
  }
  return undefined;
}

/**
 * Whether a harness question is about a call in the working directory: a
 * path write or edit, or a shell command. A read-only chat asks the worktree
 * question for each, with the permission answers and the worktree offer.
 */
export function isWriteQuestion(request: AskRequest): boolean {
  // A form is a question about the agent's own choice, never about one call.
  if (request.questions !== undefined && request.questions.length > 0) return false;
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

/** The call a question names in its own resume, when it carries one. */
function resumeCall(resume: unknown): WorktreeCall | undefined {
  return isRecord(resume) ? callOf(resume.call) : undefined;
}

/** The call a question is about, from its grant, its resume or its own words. */
function questionedCall(request: AskRequest): WorktreeCall | undefined {
  // A form carries no call: its questions are the agent's, not the profile's.
  if (request.questions !== undefined && request.questions.length > 0) return undefined;
  return worktreeCall(request) ?? resumeCall(request.resume) ?? callFromQuestion(request.prompt);
}

/** One call in the words `access-match` takes. */
function matcherCall(call: WorktreeCall): { readonly tool: string; readonly input: Record<string, unknown> } {
  if (call.kind === "command") {
    if (call.value.startsWith("mcp ")) {
      const rest = call.value.slice("mcp ".length);
      const at = rest.indexOf(".");
      if (at > 0 && at + 1 < rest.length) {
        return { tool: MCP_TOOL, input: { server: rest.slice(0, at), tool: rest.slice(at + 1) } };
      }
    }
    return { tool: "bash", input: { command: call.value } };
  }
  return { tool: call.tool ?? "write", input: { path: call.value } };
}

/** Who changed the chat's level to `level`, from the latest access fact that did. */
function levelActor(ctx: StepContext, chat: string, level: AccessLevel): { readonly via: string; readonly id: string } | undefined {
  const fact = [...readChat(ctx.store, chat).facts].reverse().find((item) => item.type === ACCESS_FACT && item.data.to === level);
  const by = fact !== undefined && isRecord(fact.data.by) ? fact.data.by : undefined;
  if (by === undefined || typeof by.via !== "string" || typeof by.id !== "string") return undefined;
  return { via: by.via, id: by.id };
}

/**
 * The check a chat's question runs again while it waits. A question about one
 * call is lifted only when the level changed and the new level would not ask
 * that call; a question that is not about a call, or whose ask comes from the
 * profile rather than the level, stays open.
 */
function levelRecheck(
  ctx: StepContext,
  chatId: string,
  cwd: string,
  base: () => Readonly<Record<string, JsonValue>>,
  openedLevel: AccessLevel,
  request: AskRequest,
): (() => Promise<AskRecheck>) | undefined {
  const call = questionedCall(request);
  if (call === undefined) return undefined;
  const judged = matcherCall(call);
  return async () => {
    const stored = await ctx.store.get(CHAT_TYPE, chatId);
    if (stored === undefined) return { ask: true };
    const chat = chatData(stored.data);
    const level = chat.accessLevel ?? "ask";
    if (level === openedLevel) return { ask: true };
    const verdict = match(withAccessLevel(base(), level), { ...judged, cwd });
    if (!verdict.allow) return { ask: true };
    const actor = levelActor(ctx, chatId, level);
    return { ask: false, note: ACCESS_LEVEL_INFO[level].title, ...(actor === undefined ? {} : { actor }) };
  };
}

/** The chat step's own `ctx.ask`, in the shape the harness's asker takes. */
function contextAsker(ctx: StepContext): StepAsker {
  return {
    async ask(request): Promise<AskOutcome> {
      try {
        return { kind: "answered", answer: await ctx.ask(request) };
      } catch (error) {
        if (error instanceof AskTimeoutError) {
          return {
            kind: "timeout",
            waitId: error.waitId,
            prompt: error.prompt,
            choices: error.choices,
            ...(error.choiceInfo === undefined ? {} : { choiceInfo: error.choiceInfo }),
            ...(error.questions === undefined ? {} : { questions: error.questions }),
            ...(error.resume === undefined || error.resume === null ? {} : { resume: error.resume as JsonValue }),
          };
        }
        throw error;
      }
    },
    useGrant: (waitId) => ctx.useGrant(waitId),
  };
}

/** An asker that adds the level recheck to every question about one call. */
function levelAsker(
  ctx: StepContext,
  chatId: string,
  cwd: string,
  base: () => Readonly<Record<string, JsonValue>>,
  initialLevel: AccessLevel,
  inner: StepAsker,
): StepAsker {
  return {
    async ask(request, signal): Promise<AskOutcome> {
      if (request.recheck !== undefined) return inner.ask(request, signal);
      // The question may be opened after the reply started, under a level the
      // owner set meanwhile; changing back to the reply's start level is still
      // a change that may lift this question.
      const stored = await ctx.store.get(CHAT_TYPE, chatId);
      const openedLevel = stored === undefined ? initialLevel : chatData(stored.data).accessLevel ?? "ask";
      const recheck = levelRecheck(ctx, chatId, cwd, base, openedLevel, request);
      return inner.ask(recheck === undefined ? request : { ...request, recheck }, signal);
    },
    useGrant: (waitId) => inner.useGrant(waitId),
  };
}

/** Whether the chat's working directory is no longer `cwd`, the one this reply started in. */
async function movedFrom(ctx: StepContext, chatId: string, cwd: string): Promise<boolean> {
  const stored = await ctx.store.get(CHAT_TYPE, chatId);
  return stored !== undefined && chatData(stored.data).cwd !== cwd;
}

/**
 * The asker a read-only chat's harness gets: a question about writing a file
 * becomes the worktree question, which may let this call run once, remember it
 * with Always allow, refuse it, or open a worktree; any other question goes
 * where it would have gone.
 *
 * Choosing the worktree stops the harness at once through `stop`, even when it
 * swallows the thrown stop: the reply that asked has ended (ADR 0028 D3).
 */
function readOnlyAsker(
  ctx: StepContext,
  chatId: string,
  cwd: string,
  chosen: { run: boolean; readonly stop: AbortController },
  inner: StepAsker,
): StepAsker {
  const person = personStarted(ctx.trigger);
  return {
    async ask(request): Promise<AskOutcome> {
      if (chosen.run) throw new WorktreeChosen();
      // The chat moved to its worktree while this reply ran, so what this
      // reply asks is judged by the main clone's profile and its directory.
      // The reply ends and is answered again in the worktree.
      if (await movedFrom(ctx, chatId, cwd)) {
        chosen.run = true;
        chosen.stop.abort();
        throw new WorktreeChosen();
      }
      const write = isWriteQuestion(request);
      const call = write ? worktreeCall(request) : undefined;
      // An entry from an earlier Always allow lifts the question in any chat a person started.
      if (person && call !== undefined && (await userLayer(ctx)).some((entry) => remembered(entry, call, cwd))) {
        return { kind: "answered", answer: { choice: "allow_once" } };
      }
      const choices = person
        ? [...WORKTREE_CHOICES]
        : [WORKTREE_ALLOW_ONCE, WORKTREE_DENY, WORKTREE_YES];
      const shaped: AskRequest = write
        ? {
            prompt: call === undefined ? WORKTREE_QUESTION : worktreeQuestion(call),
            choices,
            choiceInfo: worktreeChoiceInfo(choices),
            ...(request.resume === undefined ? {} : { resume: worktreeResume(request, call) }),
            ...(request.onTimeout === undefined ? {} : { onTimeout: request.onTimeout }),
            ...(request.graceSecs === undefined ? {} : { graceSecs: request.graceSecs }),
          }
        : request;
      // A question open when the chat moves to its worktree ends with the reply.
      const outcome = await Promise.race([
        inner.ask(shaped),
        new Promise<never>((_resolve, reject) => {
          const end = (): void => reject(new WorktreeChosen());
          if (chosen.stop.signal.aborted) end();
          else chosen.stop.signal.addEventListener("abort", end, { once: true });
        }),
      ]);
      if (outcome.kind === "timeout") return outcome;
      const answer = outcome.answer;
      if (shaped === request) return outcome;
      const action = worktreeAnswer(answer.choice);
      const actor = answer.actor === undefined ? {} : { actor: answer.actor };
      if (action === "allow_once") {
        return { kind: "answered", answer: { choice: "allow_once", ...actor } };
      }
      if (action === "allow_always" && person) {
        if (call !== undefined) await rememberAlways(ctx, call, cwd);
        return { kind: "answered", answer: { choice: "allow_always", ...actor } };
      }
      if (action === "worktree") {
        // Opening a worktree keeps this call out of the main clone. The reply
        // ends here; the worktree flow starts the answer again there.
        chosen.run = true;
        chosen.stop.abort();
        throw new WorktreeChosen();
      }
      // Deny refuses as no did, and says why.
      return { kind: "answered", answer: { choice: "reject_once", note: READ_ONLY_REFUSAL, ...actor } };
    },
    useGrant: (waitId) => inner.useGrant(waitId),
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

/** The text a chat's first session starts with: the whole text, and its place alone. */
interface SessionContext {
  readonly text: string;
  readonly where: string;
}

/** What a chat's `refresh` step gives back. */
interface Live {
  readonly cwd: string;
  readonly access: Readonly<Record<string, JsonValue>>;
  readonly skills: readonly string[];
  /** Servers the harness starts for the agent, by name, each as a command. */
  readonly mcpServers: Readonly<Record<string, JsonValue>>;
  /** Whether the agent reads the owner's own configuration of that agent. */
  readonly useOwnSettings: boolean;
  /** A repository chat's starting text; a bot chat gives none. */
  readonly context?: SessionContext | undefined;
  /** Files put on the message as notes; a bot gives its memory index and instructions. */
  readonly notes?: readonly NoteFile[] | undefined;
  /** The level a chat that chose none starts at now; a bot gives its setting. */
  readonly accessDefault?: AccessLevel | undefined;
  /** False when the chat works in its main clone and no worktree is to be offered. */
  readonly worktreeOffer?: boolean | undefined;
  /** A plugin step to call after the round ends, when the chat's refresh step names one. */
  readonly after?: string | undefined;
}

function sessionContextOf(value: unknown): SessionContext | undefined {
  if (!isRecord(value) || typeof value.text !== "string" || typeof value.where !== "string") return undefined;
  return { text: value.text, where: value.where };
}

/** The text to put before this round's prompt: the whole text for a new session, its place after a move. */
function contextFor(chat: ChatData, live: Live, session: string | undefined): string | undefined {
  if (live.context === undefined) return undefined;
  if (session === undefined) return live.context.text;
  if (chat.contextCwd !== undefined && chat.contextCwd !== live.cwd) return live.context.where;
  return undefined;
}

/** The context the last reply of this session ended with, when it reported one. */
function lastContextUsed(messages: readonly Message[], session: string | undefined): number | undefined {
  if (session === undefined) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.context === undefined) continue;
    return message.session === session ? message.context.used : undefined;
  }
  return undefined;
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
  const own: Live = {
    cwd: chat.cwd,
    access: chat.access,
    skills: chat.skills,
    mcpServers: {},
    useOwnSettings: false,
  };
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
  const context = sessionContextOf(data.context);
  const notes = noteFilesOf(data.notes);
  const after = typeof data.after === "string" && data.after.length > 0 ? data.after : undefined;
  const accessDefault = isAccessLevel(data.accessDefault) ? data.accessDefault : undefined;
  return {
    ...(accessDefault === undefined ? {} : { accessDefault }),
    ...(data.worktreeOffer === false ? { worktreeOffer: false } : {}),
    cwd: data.cwd,
    access: data.access as Record<string, JsonValue>,
    skills: data.skills.filter((item): item is string => typeof item === "string"),
    mcpServers: isRecord(data.mcpServers) ? (data.mcpServers as Record<string, JsonValue>) : {},
    useOwnSettings: data.useOwnSettings === true,
    ...(context === undefined ? {} : { context }),
    ...(notes === undefined ? {} : { notes }),
    ...(after === undefined ? {} : { after }),
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

/**
 * The profile with the chat's own directory denied: its live-level file is
 * written by `chat:access`, never by the agent, at any level.
 */
export function withLevelFileDeny(
  access: Readonly<Record<string, JsonValue>>,
  levelPath: string,
): Readonly<Record<string, JsonValue>> {
  const directory = dirname(levelPath);
  const denied = Array.isArray(access.denyPaths)
    ? access.denyPaths.filter((entry): entry is string => typeof entry === "string")
    : [];
  return denied.includes(directory) ? access : { ...access, denyPaths: [...denied, directory] };
}

/** How much of a tool call's output a fact keeps; the rest goes to a file. */
export const TOOL_OUTPUT_FACT_BYTES = 4 * 1024;

/** The longest failure line a transcript shows; the provider's message is cut to this. */
export const REPLY_FAILURE_MAX = 300;

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
    return await ctx.secrets.values();
  } catch {
    return [];
  }
}

/** What the transcript says when a crash, stop or restart interrupted a reply. */
export const INTERRUPTED_NOTE = "The reply was stopped before it finished.";

/** One entry as `recordEntries` records it: a folded entry or a stopped line. */
type RecordedEntry =
  | FoldEntry
  | { readonly kind: "stopped"; readonly text: string; readonly interrupted?: true };

/** The entries to record: what finished, and the reply a stopped run got only half way through. */
function entriesToRecord(
  folded: FoldState,
  options: {
    readonly finalText?: string | undefined;
    readonly stopped: boolean;
    readonly interrupted?: boolean | undefined;
  },
  secrets: readonly string[],
): readonly RecordedEntry[] {
  const entries: RecordedEntry[] = [...folded.entries];
  // What is still only an increment is not an entry. A stopped run keeps the
  // text it got half way through; finished text and thinking are already above.
  if (options.stopped && folded.text.length > 0) entries.push({ kind: "stopped", text: folded.text });
  // A recovered reply gets one line of its own, even when it wrote no text.
  if (options.interrupted === true) {
    entries.push({ kind: "stopped", text: INTERRUPTED_NOTE, interrupted: true });
  }
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
  entry: RecordedEntry,
  secrets: readonly string[],
): Promise<EntryData> {
  if (entry.kind !== "tool") {
    return {
      runId,
      kind: entry.kind,
      text: maskSecrets(entry.text, secrets),
      ...(entry.kind === "stopped" && entry.interrupted === true ? { interrupted: true } : {}),
      ...(entry.kind === "stopped" || entry.at === undefined ? {} : { startedAt: entry.at }),
    };
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
  options: {
    readonly finalText?: string | undefined;
    readonly stopped: boolean;
    readonly interrupted?: boolean | undefined;
  },
): Promise<void> {
  const secrets = await secretValues(ctx);
  const wanted = entriesToRecord(folded, options, secrets);
  if (wanted.length === 0) return;
  const read = readChat(ctx.store, chat);
  const existing = read.entries;
  const lastReply = new Map<string, number>();
  for (const message of read.messages) {
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

/**
 * The user's word for a provider's internal name. Only `harness` is rewritten:
 * `run`, `step`, `flow` and `fact` are also ordinary English, and a provider's
 * "run out of quota" must stay as it said it.
 */
const PLAIN_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  harness: ["agent", "agents"],
};

/** Replaces an internal word in a provider's message with the word a person reads. */
function plainWords(text: string): string {
  return text.replace(/\b(harness)(es)?\b/gi, (word, base: string, plural: string | undefined) => {
    const pair = PLAIN_WORDS[base.toLowerCase()];
    if (pair === undefined) return word;
    const replacement = plural === undefined ? pair[0] : pair[1];
    return word[0] === word[0]?.toUpperCase() ? `${replacement[0]?.toUpperCase() ?? ""}${replacement.slice(1)}` : replacement;
  });
}

/** One plain line saying a reply failed, with the provider's message masked and cut short. */
export function replyFailureLine(message: string, secrets: readonly string[]): string {
  const detail = plainWords(maskSecrets(message, secrets).replace(/\s+/g, " ").trim());
  const line = detail.length === 0 ? "The reply failed." : `The reply failed: ${detail}`;
  return line.length <= REPLY_FAILURE_MAX ? line : `${line.slice(0, REPLY_FAILURE_MAX - 1)}…`;
}

/**
 * Why an empty reply ended, in plain words. A reply with no text but with usage
 * reached the model; one with neither ended without calling it, and the agent's
 * own message is the reason it gives.
 */
function emptyReplyMessage(data: Readonly<Record<string, unknown>>): string {
  const usage = usageOf(data.usage);
  if (usage.tokens !== undefined || usage.costMicros !== undefined) return "the agent gave no reply";
  const ended = "the agent ended without answering and without calling the model";
  const reason = typeof data.message === "string" ? data.message.replace(/\s+/g, " ").trim() : "";
  return reason.length === 0 ? ended : `${ended} (${reason})`;
}

/** How many empty failures in a row after `after` are for `oldest`; another failure or a stop ends the run. */
function emptyFailureStreak(entries: readonly Entry[], after: number, oldest: string): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.sequence <= after) continue;
    if (entry.kind === "stopped") {
      count = 0;
    } else if (entry.kind === "failure") {
      if (entry.reason === "empty" && entry.messageId === oldest) count += 1;
      else count = 0;
    }
  }
  return count;
}

/**
 * Records a failure as one entry after the last person's message or reply. A
 * rerun of the same run finds its failure and does not add another, even when
 * the provider words it differently; every other failed run records its own,
 * so a retried attempt that fails again does not leave the chat looking like
 * it is still writing.
 *
 * An empty failure twice in a row for the same oldest message marks that
 * message taken, so a message the agent never answers is not sent forever.
 */
async function recordFailure(
  ctx: StepContext,
  chat: string,
  reason: string,
  message: string,
  oldest?: string | undefined,
): Promise<void> {
  const text = replyFailureLine(message, await secretValues(ctx));
  const read = readChat(ctx.store, chat);
  let lastReply = 0;
  for (const item of read.messages) {
    if (item.role === "user") continue;
    lastReply = Math.max(lastReply, item.sequence);
  }
  const recorded = read.entries.some(
    (entry) => entry.kind === "failure" && entry.runId === ctx.runId,
  );
  if (!recorded) {
    const data: EntryData = {
      runId: ctx.runId,
      kind: "failure",
      text,
      reason,
      ...(oldest === undefined ? {} : { messageId: oldest }),
    };
    await ctx.facts.append({ type: ENTRY_FACT, object: chatRef(chat), data });
  }
  if (reason !== "empty" || oldest === undefined) return;
  const streak = emptyFailureStreak(readChat(ctx.store, chat).entries, lastReply, oldest);
  if (streak >= 2) await recordTaken(ctx, chat, ctx.runId, [oldest]);
}

/**
 * Records messages an attempt took before it ended without a reply message, so
 * a later round does not give them to the agent again.
 */
async function recordTaken(ctx: StepContext, chat: string, runId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const facts = readChat(ctx.store, chat).facts;
  const seen = new Set(facts.flatMap((fact) => answeredOfFact(fact)));
  const fresh = ids.filter((id) => !seen.has(id));
  if (fresh.length === 0) return;
  await ctx.facts.append({
    type: ANSWER_FACT,
    object: chatRef(chat),
    data: { runId, ids: fresh },
  });
}

/** Ends a reply as failed, after recording why in the chat. */
async function failedReply(
  ctx: StepContext,
  chat: string,
  reason: string,
  message: string,
  oldest?: string | undefined,
): Promise<PluginStepResult> {
  await recordFailure(ctx, chat, reason, message, oldest);
  return failed(reason, message);
}

/** The reason and message a failed step result carries. */
function failureOf(result: PluginStepResult): { readonly reason: string; readonly message: string } {
  const data = isRecord(result.data) ? result.data : {};
  return {
    reason: typeof data.reason === "string" ? data.reason : "harness",
    message: typeof data.message === "string" ? data.message : `the agent ended "${result.result}"`,
  };
}

/**
 * The inbox a chat passes to a harness that takes messages mid-run. It keeps
 * what arrives until the harness listens, then hands everything on in order,
 * and records only the messages the harness actually took. A take and a change
 * of the same message take the chat's queue lock in turn, so exactly one wins.
 * A message still waiting when the run ends is left for the next round.
 */
interface ReplyInbox {
  readonly inbox: MessageInbox;
  send(id: string): void;
  /** The ids of the messages handed to the harness, in arrival order. */
  readonly handed: readonly string[];
  close(): Promise<void>;
}

type Handed = "taken" | "left" | "wait";

function replyInbox(
  ctx: StepContext,
  chat: string,
  runId: string,
  skills: ReturnType<typeof readSkills>,
  loadsSkills: boolean,
): ReplyInbox {
  let listener: ((text: string) => boolean | void) | undefined;
  const waiting: string[] = [];
  const handed: string[] = [];
  let open = true;
  let pumping: Promise<void> | undefined;

  const deliver = async (id: string): Promise<Handed> => {
    await queueTestHooks.beforeTake?.(id);
    return withQueueLock(ctx.home, chat, async () => {
      if (!open || listener === undefined) return "wait";
      const read = readChat(ctx.store, chat);
      if (takenIds(read.facts).has(id)) return "left";
      const message = read.messages.find((item) => item.id === id);
      if (message === undefined || message.role !== "user") return "left";
      if (listener(skillMessage(message.text, skills, loadsSkills)) === false) return "left";
      await takeLocked(ctx.store, ctx.facts, chat, runId, [id], "step:chat/reply", read);
      return "taken";
    });
  };

  const pump = (): Promise<void> => {
    if (pumping !== undefined) return pumping;
    const task = Promise.resolve().then(async () => {
      try {
        while (open && listener !== undefined && waiting.length > 0) {
          const id = waiting[0];
          if (id === undefined) break;
          let outcome: Handed;
          try {
            outcome = await deliver(id);
          } catch (error) {
            await ctx.logger.write(
              `a message could not be handed to the agent: ${messageOf(error)}`,
            );
            outcome = "left";
          }
          if (outcome === "wait") break;
          if (waiting[0] === id) waiting.shift();
          if (outcome === "taken") handed.push(id);
        }
      } finally {
        pumping = undefined;
        if (open && listener !== undefined && waiting.length > 0) void pump();
      }
    });
    pumping = task;
    return task;
  };

  return {
    inbox: {
      listen(next) {
        listener = next;
        void pump();
        return () => {
          if (listener === next) listener = undefined;
        };
      },
    },
    send(id) {
      if (!open) return;
      waiting.push(id);
      void pump();
    },
    handed,
    async close() {
      open = false;
      listener = undefined;
      waiting.length = 0;
      await pumping;
    },
  };
}

/** Records that the reply step returned on its own, before its result enters the log. */
async function recordAttemptEnd(ctx: StepContext, chat: string): Promise<void> {
  await ctx.facts.append({
    type: ATTEMPT_END_FACT,
    object: chatRef(chat),
    data: { runId: ctx.runId },
  });
}

/**
 * Runs after a reply step a crash, stop or restart interrupted. It reads the
 * log the agent wrote and records the entries it finished, the half-written
 * text and one line saying the reply stopped, so `/retry` can continue the
 * chat from what was kept. A step that returned `interrupted` on its own
 * already recorded those and left its attempt fact, so this adds nothing.
 */
export async function keepInterrupted(ctx: StepContext, _params: unknown): Promise<PluginStepResult> {
  const object = ctx.object;
  if (object === undefined || object.type !== CHAT_TYPE) {
    return failed("object", "chat:reply runs on a chat");
  }
  const stored = await ctx.store.get(CHAT_TYPE, object.id);
  if (stored === undefined) return { result: "done", data: {} };
  const chatRead = readChat(ctx.store, object.id);
  const messages = chatRead.messages;
  const facts = chatRead.facts;
  const pending = unanswered(messages, facts);
  const replied = messages.some((message) => message.role === "assistant" && message.runId === ctx.runId);
  if (replied && pending.length === 0) {
    // The reply entered the record before the crash and owes no message: there is nothing to mark.
    await syncChat(ctx, object.id, undefined);
    return { result: "done", data: { kept: false } };
  }
  if (facts.some((fact) => attemptEndedOfFact(fact) === ctx.runId)) {
    // The reply step ended on its own and recorded its entries first.
    return { result: "done", data: { kept: false } };
  }
  const chat = chatData(stored.data);
  const read = foldLogTail(agentLogPath(ctx.store.root, chat.harness, ctx.runId));
  const folded = read?.state ?? emptyFold;
  // The log holds every round of the run; a round whose reply is already in
  // the record is a prefix of it and is not recorded again.
  const prior = chatRead.entries.filter((entry) => entry.runId === ctx.runId).length;
  const current = prior === 0 ? folded : { ...folded, entries: folded.entries.slice(prior) };
  await recordEntries(ctx, object.id, current, { stopped: true, interrupted: true });
  // A run that ended on its own is recorded by its last round; one that was
  // stopped after writing still gets its changes recorded here.
  await runAfterStep(ctx, await afterStepOfRefresh(ctx, chat, object), object, "done");
  return { result: "done", data: { kept: true } };
}

/**
 * Runs the step a chat's refresh data names after a round, once the round is
 * over. A plugin uses it to record what the round wrote (the memory plugin's
 * commit). A failure is logged, never put in the chat: the answer is already
 * written, and remembering it must not undo the answer.
 */
async function runAfterStep(ctx: StepContext, step: string | undefined, object: RunObject, result: string | undefined): Promise<void> {
  if (step === undefined) return;
  if (result !== undefined && result !== "done" && result !== "failed") return;
  const runStep = ctx.runStep;
  if (runStep === undefined) return;
  if (ctx.stepLoaded !== undefined && !ctx.stepLoaded(step)) {
    ctx.logger.write(`after ${step}: the step is not loaded\n`);
    return;
  }
  try {
    const outcome = await runStep(step, { chat: object.id }, { runId: ctx.runId, object, params: ctx.params, signal: ctx.signal });
    if (outcome.result !== "done") {
      const message = isRecord(outcome.data) && typeof outcome.data.message === "string" ? outcome.data.message : `it ended ${outcome.result}`;
      ctx.logger.write(`after ${step}: ${message}\n`);
    }
  } catch (error) {
    ctx.logger.write(`after ${step}: ${messageOf(error)}\n`);
  }
}

/** The after step a chat's refresh step names now, read for a run that ended without a round. */
async function afterStepOfRefresh(ctx: StepContext, chat: ChatData, object: RunObject): Promise<string | undefined> {
  if (chat.refresh === undefined) return undefined;
  const runStep = ctx.runStep;
  if (runStep === undefined) return undefined;
  if (ctx.stepLoaded !== undefined && !ctx.stepLoaded(chat.refresh)) return undefined;
  try {
    const outcome = await runStep(chat.refresh, { chat: object.id }, { runId: ctx.runId, object, params: ctx.params, signal: ctx.signal });
    const data = isRecord(outcome.data) ? outcome.data : {};
    return outcome.result === "done" && typeof data.after === "string" && data.after.length > 0 ? data.after : undefined;
  } catch {
    return undefined;
  }
}

/** What one round leaves for the work after it: the after step, and the note hashes it records. */
interface ReplyState {
  after?: string | undefined;
  keepNotes?: (() => Promise<void>) | undefined;
}

/** Runs one round of an answer; see the file's comment. */
export async function runReply(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
  const state: ReplyState = {};
  let result: string | undefined;
  try {
    const outcome = await replyOnce(ctx, params, state);
    result = outcome.result;
    return outcome;
  } finally {
    const object = ctx.object;
    if (object !== undefined) {
      await runAfterStep(ctx, state.after, object, result);
      if (state.keepNotes !== undefined) {
        try {
          await state.keepNotes();
        } catch (error) {
          await ctx.logger.write(
            `the note hashes could not be recorded: ${messageOf(error)}\n`,
          );
        }
      }
    }
  }
}

/** What a compaction did, as the engine's data carries it. */
function compactionOf(value: unknown): AgentCompaction | undefined {
  if (!isRecord(value) || typeof value.before !== "number") return undefined;
  return {
    reason: value.reason === "manual" ? "manual" : "threshold",
    before: value.before,
    ...(typeof value.after === "number" ? { after: value.after } : {}),
    flushed: value.flushed === true,
  };
}

/** The tokens as a short figure: 90,000 is `90k`. */
function tokenFigure(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * The line in the chat that says the context was compacted, or that there was
 * nothing to compact. It is a command-shaped entry so no client changes: never
 * part of the agent's prompt and never answered.
 */
async function recordCompactionLine(
  ctx: StepContext,
  chat: string,
  harness: string,
  compaction: AgentCompaction | undefined,
  manual: boolean,
): Promise<void> {
  const outcome =
    compaction === undefined
      ? "Nothing was compacted: the context is too small, or the compaction failed."
      : `The context was compacted${compaction.after === undefined ? "" : ` from ${tokenFigure(compaction.before)} to about ${tokenFigure(compaction.after)} tokens`}${compaction.flushed ? ", after the agent wrote what to remember to memory" : ""}.`;
  const data: CommandData = {
    from: { via: harness, id: harness },
    command: manual ? "compact" : "compact (automatic)",
    outcome,
    ok: compaction !== undefined,
  };
  await ctx.facts.append({ type: COMMAND_FACT, object: chatRef(chat), data });
}

/** One round of an answer, before the after step runs. */
async function replyOnce(
  ctx: StepContext,
  params: unknown,
  state: ReplyState,
): Promise<PluginStepResult> {
  const object = ctx.object;
  if (object === undefined || object.type !== CHAT_TYPE) {
    return failed("object", "chat:reply runs on a chat");
  }
  const stored = await ctx.store.get(CHAT_TYPE, object.id);
  if (stored === undefined) return failed("object", `there is no chat ${object.id}`);
  let chat = chatData(stored.data);
  const read = readChat(ctx.store, object.id);
  let messages = read.messages;
  let pending = unanswered(messages, read.facts);
  const compactAsked = chat.harness === "pi" && compactRequested(read.facts);
  if (pending.length === 0 && !compactAsked) {
    // A run that stopped after recording a reply still owes the chat its model and cost.
    await syncChat(ctx, object.id, undefined);
    return { result: "done", data: { answered: 0 } };
  }

  const runStep = ctx.runStep;
  const oldest = pending[0]?.id;
  // A `/compact` with nothing to answer is a run of its own: no prompt, no reply.
  let compactOnly = pending.length === 0;
  if (runStep === undefined) return failedReply(ctx, object.id, "host", "the agent could not be started", oldest);
  const use = `${chat.harness}/agent`;
  if (ctx.stepLoaded !== undefined && !ctx.stepLoaded(use)) {
    return failedReply(ctx, object.id, "harness", `the agent "${chat.harness}" is not loaded`, oldest);
  }

  // A model the agent cannot take fails the reply by name; it never falls back.
  // A harness that has not read its list yet gets one refresh to answer, so a
  // first reply is not refused only because the list was not there at load.
  if (chat.model !== undefined) {
    const models =
      ctx.harnessModelsReady !== undefined
        ? await ctx.harnessModelsReady(chat.harness)
        : ctx.harnessModels?.(chat.harness);
    if (!modelIds(models).includes(chat.model)) {
      return failedReply(ctx, object.id, "model", `the agent "${chat.harness}" cannot use the model "${chat.model}"`, oldest);
    }
  }
  // The same for an effort: the agent's list is the only one that can take the
  // effort the chat chose; one equal to its stored default is inherited.
  const efforts = ctx.harnessEfforts?.(chat.harness);
  const effort = chosenEffort(chat);
  if (effort !== undefined && efforts?.list.includes(effort) !== true) {
    return failedReply(ctx, object.id, "effort", `the agent "${chat.harness}" cannot use the effort "${effort}"`, oldest);
  }
  const effortFlag = efforts?.flag ?? (chat.harness === "pi" ? "--thinking" : "--effort");

  const settled = await liveSettings(ctx, chat, object, runStep);
  if ("result" in settled) {
    const why = failureOf(settled);
    return failedReply(ctx, object.id, why.reason, why.message, oldest);
  }
  const live = settled;
  state.after = live.after;
  // A chat that never chose a level follows the level its plugin starts chats
  // at now, so changing that setting moves it; a chosen level stays.
  if (live.accessDefault !== undefined && !chat.accessChosen && (chat.accessDefault !== live.accessDefault || chat.accessLevel !== live.accessDefault)) {
    const fresh = await ctx.store.get(CHAT_TYPE, object.id);
    if (fresh !== undefined && !chatData(fresh.data).accessChosen) {
      const next = { ...fresh.data, accessLevel: live.accessDefault, accessDefault: live.accessDefault };
      await ctx.store.put(CHAT_TYPE, object.id, next, "step:chat/reply");
      chat = chatData(next);
    }
  }
  // The notes this message may carry: a bot's memory index and instructions. A
  // file that cannot be read is logged and left out; it never fails the answer.
  const noteContents =
    live.notes === undefined
      ? []
      : await readNoteFiles(live.notes, live.cwd, (problem) => {
          void ctx.logger.write(`${problem}\n`);
        });
  // A level reaches the harness only through an agent that declares it can
  // carry it; an agent that cannot refuses the reply by name, never ignores it.
  const level = chat.accessLevel ?? "ask";
  const capabilities = ctx.harnessCapabilities?.(chat.harness);
  if (capabilities !== undefined && !(capabilities.accessLevels ?? []).includes(level)) {
    return failedReply(
      ctx,
      object.id,
      "access",
      `the agent "${chat.harness}" cannot carry the access level "${level}"`,
      oldest,
    );
  }
  const leveled = withAccessLevel(live.access, level);
  const skills = readSkills(live.skills);
  const loadsSkills = capabilities?.loadsSkills === true;

  // A harness that takes messages mid-run is handed each ordinary message that
  // arrives while this round runs, after the tool calls already running. A
  // message with an attachment waits for the next round: the mid-run inbox
  // carries text, and its image or file reaches the agent as a first message does.
  const midRun =
    ctx.harnessCapabilities?.(chat.harness)?.takesMessagesMidRun === true
      ? replyInbox(ctx, object.id, ctx.runId, skills, loadsSkills)
      : undefined;
  const arrived = new Set<string>();
  let stopMidRun: (() => void) | undefined;
  if (midRun !== undefined) {
    const inbox = midRun;
    stopMidRun = ctx.store.subscribe(chatRef(object.id), {}, (fact) => {
      if (fact.type !== MESSAGE_FACT) return;
      const data = fact.data;
      if (data.role !== "user" || typeof data.id !== "string" || typeof data.text !== "string") return;
      arrived.add(data.id);
      if (attachmentsOf(data.attachments).length === 0) inbox.send(data.id);
    });
    // A message that came between the first read and this subscription is in
    // the facts now. It is delivered, not also put into the prompt.
    const fresh = readChat(ctx.store, object.id);
    messages = fresh.messages;
    pending = unanswered(messages, fresh.facts).filter((message) => !arrived.has(message.id));
  }

  let stopWatching: (() => void) | undefined;
  const closeMidRun = async (): Promise<void> => {
    if (stopWatching !== undefined) {
      stopWatching();
      stopWatching = undefined;
    }
    if (stopMidRun !== undefined) {
      stopMidRun();
      stopMidRun = undefined;
    }
    await midRun?.close();
  };

  const resumed = isRecord(params) ? params : {};
  const session =
    typeof resumed.resumeSession === "string" ? resumed.resumeSession : currentSession(chat, messages, read.facts);
  // The context the last reply in this session ended with; a smaller one after
  // this reply means the agent compacted the session.
  const previousUsed = lastContextUsed(messages, session);
  const readOnly = leveled.readOnly === true;
  // The worktree question belongs to a repository chat; a bot chat at `plan`
  // is read-only without one.
  const worktreeChat =
    readOnly && live.worktreeOffer !== false && (chat.parent === undefined || chat.parent.startsWith("repo:"));
  const worktreeChosen = { run: false, stop: new AbortController() };
  // The live file holds the base profile; a level change rewrites only its level.
  let recheckBase: Readonly<Record<string, JsonValue>> = live.access;
  const withLevel = levelAsker(ctx, object.id, live.cwd, () => recheckBase, level, contextAsker(ctx));
  const asker = worktreeChat ? readOnlyAsker(ctx, object.id, live.cwd, worktreeChosen, withLevel) : withLevel;
  if (worktreeChat) {
    // A level change opens the worktree before it is recorded. This reply runs
    // in the main clone with the profile it started with, so when the chat has
    // moved it ends and is answered again there, rather than going on in the
    // main clone or asking again as read-only.
    stopWatching = ctx.store.subscribe(chatRef(object.id), {}, (fact) => {
      if (fact.type !== ACCESS_FACT || worktreeChosen.run) return;
      void movedFrom(ctx, object.id, live.cwd).then((moved) => {
        if (!moved || worktreeChosen.run) return;
        worktreeChosen.run = true;
        worktreeChosen.stop.abort();
      });
    });
  }
  // A worktree yes aborts `stop`, so the harness ends even if it swallows the
  // stop error; the reply still ends `done` below.
  const signal = worktreeChat ? AbortSignal.any([ctx.signal, worktreeChosen.stop.signal]) : ctx.signal;

  // An answer that came back after the wait (the grace had passed) is the same
  // answer as one given live.
  const late = answeredQuestion(params);
  const lateWorktree = worktreeChat && late !== undefined && isWorktreeQuestion(late.prompt);
  const lateAction = lateWorktree && late !== undefined ? worktreeAnswer(late.choice) : undefined;
  const lateCall = lateWorktree ? callFromGrants(ctx.access) ?? callFromQuestion(late?.prompt ?? "") : undefined;
  if (lateAction === "worktree") {
    // The reply that asked is already over. Open the worktree once, but do
    // not start another reply for the same message. The harness is not run,
    // so the mid-run inbox closes with this step.
    await closeMidRun();
    await ctx.emit({
      type: WORKTREE_EVENT,
      key: "late",
      object: `${CHAT_TYPE}:${object.id}`,
      data: { late: true },
    });
    return { result: "done", data: { worktree: true } };
  }
  if (lateAction === "allow_always" && lateCall !== undefined && personStarted(ctx.trigger)) {
    await rememberAlways(ctx, lateCall, live.cwd);
  }
  const askAnswer =
    lateAction === undefined
      ? resumed.askAnswer
      : {
          prompt: late?.prompt ?? "",
          choice:
            lateAction === "allow_once"
              ? "allow_once"
              : lateAction === "allow_always"
                ? "allow_always"
                : "reject_once",
          ...(lateAction === "deny"
            ? { note: late?.note === undefined ? READ_ONLY_REFUSAL : `${READ_ONLY_REFUSAL}\n${late.note}` }
            : {}),
        };

  // The files sent with a message: images as input where the harness takes
  // them, every file as a path, and the chat's own attachment directory open to reads.
  const directory = attachmentDir(ctx.home, CHAT_TYPE, object.id);
  const levelPath = accessLevelPath(ctx.home, object.id);
  const withReads = messages.some((message) => message.attachments.length > 0)
    ? withAttachmentReads(live.access, directory)
    : live.access;
  const baseAccess = withLevelFileDeny(withReads, levelPath);
  recheckBase = baseAccess;
  const base = withAccessLevel(baseAccess, level);
  try {
    await writeLiveAccess(levelPath, baseAccess, level);
  } catch (error) {
    await ctx.logger.write(
      `the live access level could not be written: ${messageOf(error)}`,
    );
  }
  // A late Allow once is for this run alone; a late Always allow also wrote the user layer.
  const lateEntry =
    (lateAction === "allow_once" || lateAction === "allow_always") && lateCall !== undefined
      ? alwaysAllowEntry(lateCall, live.cwd)
      : undefined;
  const existing = Array.isArray(base.alwaysAllow) ? base.alwaysAllow : [];
  const access = {
    ...(lateEntry === undefined
      ? base
      : {
          ...base,
          alwaysAllow: [
            ...existing,
            {
              kind: lateEntry.kind,
              value: lateEntry.value,
              cwd: lateEntry.cwd,
              ...(lateEntry.tool === undefined ? {} : { tool: lateEntry.tool }),
            },
          ],
        }),
    levelFile: levelPath,
  };

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

  // The messages this round starts with are taken now, under the queue lock,
  // so a withdraw or change either comes before the run takes them or is
  // refused. A message withdrawn after the first read leaves the prompt.
  let locked: ChatRead | undefined;
  pending = await withQueueLock(ctx.home, object.id, async () => {
    const latest = readChat(ctx.store, object.id);
    locked = latest;
    const current = unanswered(latest.messages, latest.facts).filter(
      (message) => !arrived.has(message.id),
    );
    await takeLocked(
      ctx.store,
      ctx.facts,
      object.id,
      ctx.runId,
      current.map((message) => message.id),
      "step:chat/reply",
      latest,
    );
    return current;
  });
  compactOnly = pending.length === 0;
  if (pending.length === 0 && !compactAsked) {
    await closeMidRun();
    await syncChat(ctx, object.id, undefined);
    return { result: "done", data: { answered: 0 } };
  }
  const images = imagesOf(pending, chat.harness, directory);

  // The run is a fact before the agent starts: a view finds the step's log by it.
  if (locked === undefined || latestRunOf(locked.facts) !== ctx.runId) {
    await ctx.facts.append({ type: RUN_FACT, object: chatRef(object.id), data: { runId: ctx.runId } });
  }

  const context = contextFor(chat, live, session);
  const carried =
    live.notes === undefined ? [] : notesToAttach(noteContents, chat.noteHashes, session);
  const noteText = carried.length === 0 ? undefined : noteBlock(carried);
  const messagePrompt = promptFor(
    pending.map((message) => ({ ...message, text: skillMessage(message.text, skills, loadsSkills) })),
    new Set(images.map((image) => image.path)),
  );
  // The first message after `/new` says the earlier record exists and how to read it.
  const pointer = startsAfterNew(read.facts, messages) ? earlierRecordPointer(object.id) : undefined;
  const prompt = compactOnly
    ? "compact"
    : [context, noteText, pointer, messagePrompt]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n\n");
  if (compactAsked) {
    // The request is taken now, so a failed compaction is not tried again by each following reply.
    await ctx.facts.append({ type: COMPACT_FACT, object: chatRef(object.id), data: { kind: "taken", runId: ctx.runId } });
  }
  let outcome: PluginStepResult;
  try {
    outcome = await runStep(
      use,
      {
        prompt,
        ...(images.length === 0 ? {} : { images }),
        cwd: live.cwd,
        ...(chat.model === undefined && effort === undefined
          ? {}
          : {
              args: [
                ...(chat.model === undefined ? [] : ["--model", chat.model]),
                ...(effort === undefined ? [] : [effortFlag, effort]),
              ],
            }),
        ...(effort === undefined ? {} : { effort }),
        ...(live.skills.length === 0 ? {} : { skills: live.skills }),
        // Operad's own tools, so the agent never runs the `operad` command.
        operadTools: { home: ctx.home },
        ...(midRun === undefined ? {} : { inbox: midRun.inbox }),
        ...(chat.harness === "pi" || chat.harness === "claude" ? { keepWorker: true } : {}),
        // A chat retries a failed model request with pi's own bounded backoff;
        // a task keeps pi's retry off and uses dev's own waits and fallbacks.
        ...(chat.harness === "pi" ? { retry: true } : {}),
        // pi compacts when the context nears the window, after a silent turn
        // that lets a bot write to its memory first (ADR 0023 D13). A
        // `/compact` asks for it now.
        ...(chat.harness === "pi"
          ? {
              compact: {
                at: COMPACT_AT,
                ...(live.notes === undefined ? {} : { flush: COMPACT_FLUSH }),
                ...(compactAsked ? (compactOnly ? { only: true } : { now: true }) : {}),
              },
            }
          : {}),
        ...(Object.keys(live.mcpServers).length === 0 ? {} : { mcpServers: live.mcpServers }),
        ...(live.useOwnSettings ? { useOwnSettings: true } : {}),
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
        signal,
        receiver,
        asker,
      },
    );
  } catch (error) {
    await closeMidRun();
    if (worktreeChosen.run || error instanceof WorktreeChosen) {
      await recordEntries(ctx, object.id, folded, { stopped: true });
      await ctx.emit({
        type: WORKTREE_EVENT,
        key: "open",
        object: `${CHAT_TYPE}:${object.id}`,
      });
      return { result: "done", data: { worktree: true } };
    }
    await recordEntries(ctx, object.id, folded, { stopped: true });
    await recordTaken(ctx, object.id, ctx.runId, midRun?.handed ?? []);
    return failedReply(ctx, object.id, "harness", messageOf(error), oldest);
  }
  if (worktreeChosen.run) {
    await closeMidRun();
    await recordEntries(ctx, object.id, folded, { stopped: true });
    await ctx.emit({
      type: WORKTREE_EVENT,
      key: "open",
      object: `${CHAT_TYPE}:${object.id}`,
    });
    return { result: "done", data: { worktree: true } };
  }
  // From here on the harness can no longer take a message: one that arrives
  // now stays unanswered and is answered by the next round.
  await closeMidRun();

  if (outcome.result === "waiting") {
    await recordEntries(ctx, object.id, folded, { stopped: true });
    await recordTaken(ctx, object.id, ctx.runId, midRun?.handed ?? []);
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
    await recordTaken(ctx, object.id, ctx.runId, midRun?.handed ?? []);
    await recordAttemptEnd(ctx, object.id);
    return { result: "interrupted", data };
  }
  if (outcome.result !== "done") {
    await recordEntries(ctx, object.id, folded, { stopped: true });
    await recordTaken(ctx, object.id, ctx.runId, midRun?.handed ?? []);
    const why = failureOf(outcome);
    return failedReply(ctx, object.id, why.reason, why.message, oldest);
  }
  const compaction = compactionOf(data.compaction);
  if (compactOnly) {
    // No reply: the chat says whether the context was compacted, and the next
    // message carries the notes whole again, as after any compaction.
    const sessionDone = typeof data.sessionId === "string" && data.sessionId.length > 0 ? data.sessionId : session;
    await recordCompactionLine(ctx, object.id, chat.harness, compaction, true);
    await ctx.facts.append({ type: COMPACT_FACT, object: chatRef(object.id), data: { kind: "done", runId: ctx.runId } });
    await syncChat(ctx, object.id, sessionDone, undefined, compaction === undefined ? undefined : { ...(sessionDone === undefined ? {} : { session: sessionDone }), files: {} });
    return { result: "done", data: { answered: 0, compacted: compaction !== undefined } };
  }
  const said = typeof data.finalMessage === "string" ? data.finalMessage.trim() : "";
  const text = maskSecrets(said, await secretValues(ctx));
  if (text.length === 0) {
    await recordEntries(ctx, object.id, folded, { stopped: true });
    await recordTaken(ctx, object.id, ctx.runId, midRun?.handed ?? []);
    return failedReply(ctx, object.id, "empty", emptyReplyMessage(data), oldest);
  }
  const sessionId = typeof data.sessionId === "string" && data.sessionId.length > 0 ? data.sessionId : undefined;

  const usage = usageOf(data.usage);
  const timings = timingsOf(data.timings);
  const replyContext = replyContextOf(data.context);
  // A session is compacted when the agent says so, or when this reply ended with
  // less context than the one before it in the same session. The next message
  // then carries every note whole again.
  const compacted =
    data.compacted === true ||
    (previousUsed !== undefined && replyContext !== undefined && replyContext.used < previousUsed);
  const windows = ctx.harnessModels?.(chat.harness)?.windows;
  const window =
    replyContext?.window ??
    (usage.model === undefined ? undefined : windows?.[usage.model]) ??
    (chat.model === undefined ? undefined : windows?.[chat.model]);

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
    replyTo: [...pending.map((message) => message.id), ...(midRun?.handed ?? [])],
    runId: ctx.runId,
    ...(sessionId === undefined ? {} : { session: sessionId }),
    ...usage,
    ...(replyContext === undefined
      ? {}
      : { context: { used: replyContext.used, ...(window === undefined ? {} : { window }) } }),
    ...(timings === undefined ? {} : { timings }),
  };
  await ctx.facts.append({ type: MESSAGE_FACT, object: chatRef(object.id), data: reply });
  // After the reply, one short line says the context was compacted.
  if (compaction !== undefined) await recordCompactionLine(ctx, object.id, chat.harness, compaction, compactAsked);

  // The chat's own reference follows; read again, so a change made meanwhile stays.
  await syncChat(ctx, object.id, sessionId, live.context === undefined ? undefined : live.cwd);
  if (live.notes !== undefined) {
    const keptSession = sessionId ?? session;
    state.keepNotes = async () => {
      // Read after the after step, so a change that step wrote (the memory
      // commit removing an untrusted index line) is what the session now knows.
      const fresh = compacted
        ? []
        : await readNoteFiles(live.notes ?? [], live.cwd, (problem) => {
            void ctx.logger.write(`${problem}\n`);
          });
      // A file this run's own tool calls wrote is what the session knows now;
      // any other change during the run belongs to the next message.
      const written = compacted ? new Set<string>() : notesWrittenHere(noteContents, folded.entries);
      await syncChat(
        ctx,
        object.id,
        undefined,
        undefined,
        noteHashesAfter(noteContents, fresh, written, keptSession, compacted),
      );
    };
  }

  const leftRead = readChat(ctx.store, object.id);
  const left = unanswered(leftRead.messages, leftRead.facts);
  const answered = pending.length + (midRun?.handed.length ?? 0);
  // A `/compact` that came in during this reply is taken by the next round.
  const askedMeanwhile = chat.harness === "pi" && compactRequested(chatFacts(ctx.store, object.id));
  return { result: left.length > 0 || askedMeanwhile ? "more" : "done", data: { answered, left: left.length } };
}
