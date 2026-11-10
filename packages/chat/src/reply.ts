/**
 * The `chat/reply` step: one round of an answer. It builds the prompt from the
 * chat's unanswered messages, continues the chat's harness session, records the
 * reply as a fact and looks again for messages that came meanwhile; the flow
 * goes round again while there are some. The kernel keeps no prompt text.
 */

import {
  AskTimeoutError,
  messageOf,
  type AskOutcome,
  type AskRequest,
  type PluginStepResult,
  type StepAsker,
  type StepContext,
} from "@operad-io/engine";
import {
  allMessages,
  chatData,
  chatRef,
  currentSession,
  MESSAGE_FACT,
  newMessageId,
  promptFor,
  unanswered,
  CHAT_TYPE,
  type MessageData,
} from "./model.ts";

/** The question a read-only chat asks when its agent wants to change code. */
export const WORKTREE_QUESTION =
  "The agent wants to change code, and this chat is read-only. Open a worktree for it?";

/** The answers to {@link WORKTREE_QUESTION}. */
export const WORKTREE_CHOICES = ["yes", "no"] as const;

/** The event a "yes" sends; the plugin that owns the working directory acts on it. */
export const WORKTREE_EVENT = "chat.worktree";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a harness question is about writing a file: the one a read-only chat turns into a worktree question. */
export function isWriteQuestion(request: AskRequest): boolean {
  const resume = request.resume;
  if (!isRecord(resume)) return false;
  const grant = resume.grant;
  return (
    isRecord(grant) &&
    grant.kind === "path" &&
    (grant.tool === "write" || grant.tool === "edit")
  );
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
      const shaped: AskRequest = isWriteQuestion(request)
        ? {
            prompt: WORKTREE_QUESTION,
            choices: [...WORKTREE_CHOICES],
            ...(request.resume === undefined ? {} : { resume: sessionOnly(request.resume) }),
            ...(request.graceSecs === undefined ? {} : { graceSecs: request.graceSecs }),
          }
        : request;
      try {
        const answer = await ctx.ask(shaped);
        if (shaped === request) return { kind: "answered", answer };
        if (answer.choice === "yes") await onYes();
        // The call itself is never let through in the main clone.
        return { kind: "answered", answer: { choice: "reject_once", ...(answer.actor === undefined ? {} : { actor: answer.actor }) } };
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
function answeredQuestion(params: unknown): { readonly prompt: string; readonly choice: string } | undefined {
  if (!isRecord(params) || !isRecord(params.askAnswer)) return undefined;
  const { prompt, choice } = params.askAnswer;
  return typeof prompt === "string" && typeof choice === "string" ? { prompt, choice } : undefined;
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
  if (runStep === undefined) return failed("host", "the kernel did not offer a way to run the harness");
  const use = `${chat.harness}/agent`;
  if (ctx.stepLoaded !== undefined && !ctx.stepLoaded(use)) {
    return failed("harness", `the harness "${chat.harness}" is not loaded`);
  }

  const resumed = isRecord(params) ? params : {};
  const session =
    typeof resumed.resumeSession === "string" ? resumed.resumeSession : currentSession(chat, messages);
  const readOnly = chat.access.readOnly === true;
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
  // answer as one given live.
  const late = answeredQuestion(params);
  if (readOnly && late !== undefined && late.prompt === WORKTREE_QUESTION && late.choice === "yes") {
    await ctx.emit({
      type: WORKTREE_EVENT,
      key: `${ctx.runId}:late`,
      object: `${CHAT_TYPE}:${object.id}`,
    });
  }

  let outcome: PluginStepResult;
  try {
    outcome = await runStep(
      use,
      {
        prompt: promptFor(pending),
        cwd: chat.cwd,
        // Operad's own tools, so the agent never runs the `operad` command.
        operadTools: { home: ctx.home },
        ...(session === undefined ? {} : { resumeSession: session }),
        ...(resumed.askAnswer === undefined ? {} : { askAnswer: resumed.askAnswer }),
      },
      {
        runId: ctx.runId,
        cwd: chat.cwd,
        object,
        params: ctx.params,
        access: chat.access,
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
        message: typeof data.message === "string" ? data.message : `the harness ended "${outcome.result}"`,
      },
    };
  }
  const text = typeof data.finalMessage === "string" ? data.finalMessage.trim() : "";
  if (text.length === 0) return failed("empty", "the harness gave no reply");
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
