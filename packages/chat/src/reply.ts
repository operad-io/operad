/**
 * The `chat/reply` step: one round of an answer. It builds the prompt from the
 * chat's unanswered messages, continues the chat's harness session, records the
 * reply as a fact and looks again for messages that came meanwhile; the flow
 * goes round again while there are some. The kernel keeps no prompt text.
 */

import { AskTimeoutError, isRecord, messageOf, type AskOutcome, type AskRequest, type JsonValue, type PluginStepResult, type RunObject, type StepAsker, type StepContext } from "@operad-io/engine";
import {
  allMessages,
  chatData,
  type ChatData,
  chatRef,
  currentSession,
  MESSAGE_FACT,
  newMessageId,
  promptFor,
  unanswered,
  CHAT_TYPE,
  type MessageData,
} from "./model.ts";

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

/** What a chat's `refresh` step gives back. */
interface Live {
  readonly cwd: string;
  readonly access: Readonly<Record<string, JsonValue>>;
  readonly skills: readonly string[];
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
  const own: Live = { cwd: chat.cwd, access: chat.access, skills: chat.skills };
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
  };
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
  if (pending.length === 0) return { result: "done", data: { answered: 0 } };

  const runStep = ctx.runStep;
  if (runStep === undefined) return failed("host", "the kernel did not offer a way to run the agent");
  const use = `${chat.harness}/agent`;
  if (ctx.stepLoaded !== undefined && !ctx.stepLoaded(use)) {
    return failed("harness", `the agent "${chat.harness}" is not loaded`);
  }

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

  let outcome: PluginStepResult;
  try {
    outcome = await runStep(
      use,
      {
        prompt: promptFor(pending),
        cwd: live.cwd,
        ...(live.skills.length === 0 ? {} : { skills: live.skills }),
        // Operad's own tools, so the agent never runs the `operad` command.
        operadTools: { home: ctx.home },
        ...(session === undefined ? {} : { resumeSession: session }),
        ...(askAnswer === undefined ? {} : { askAnswer }),
      },
      {
        runId: ctx.runId,
        cwd: live.cwd,
        object,
        params: ctx.params,
        access: live.access,
        ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
        signal: ctx.signal,
        ...(asker === undefined ? {} : { asker }),
      },
    );
  } catch (error) {
    return failed("harness", messageOf(error));
  }

  if (outcome.result === "waiting") {
    return { result: "waiting", ...(outcome.data === undefined ? {} : { data: outcome.data }) };
  }
  const data = isRecord(outcome.data) ? outcome.data : {};
  if (outcome.result === "interrupted") {
    return { result: "interrupted", data };
  }
  if (outcome.result !== "done") {
    return {
      result: "failed",
      data: {
        reason: typeof data.reason === "string" ? data.reason : "harness",
        message: typeof data.message === "string" ? data.message : `the agent ended "${outcome.result}"`,
      },
    };
  }
  const text = typeof data.finalMessage === "string" ? data.finalMessage.trim() : "";
  if (text.length === 0) return failed("empty", "the agent gave no reply");
  const sessionId = typeof data.sessionId === "string" && data.sessionId.length > 0 ? data.sessionId : undefined;

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
    ...(sessionId === undefined ? {} : { session: sessionId }),
  };
  await ctx.facts.append({ type: MESSAGE_FACT, object: chatRef(object.id), data: reply });

  // The chat's own reference follows; read again, so a change made meanwhile stays.
  if (sessionId !== undefined) {
    const fresh = await ctx.store.get(CHAT_TYPE, object.id);
    if (fresh !== undefined && fresh.data.session !== sessionId) {
      await ctx.store.put(CHAT_TYPE, object.id, { ...fresh.data, session: sessionId }, "step:chat/reply");
    }
  }

  const left = unanswered(allMessages(ctx.store, object.id));
  return { result: left.length > 0 ? "more" : "done", data: { answered: pending.length, left: left.length } };
}
