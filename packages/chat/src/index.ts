/** The chat plugin: a long conversation with an agent, and how a message is answered. */

import pkg from "../package.json" with { type: "json" };
import { defineFlow, definePlugin, type ActionArgsSchema, type ActionContext, type ActionTypeDefinition, type PluginFact, type UsageTokens } from "@operad-io/engine";
import {
  CHAT_FILTERS,
  CHAT_SOURCES,
  OTHER_SOURCE,
  CHAT_TYPE,
  allEntries,
  allMessages,
  chatData,
  chatFacts,
  chatRef,
  CLOSED_FACT,
  COMMAND_FACT,
  costText,
  EFFORT_FACT,
  firstOutputMs,
  lastReplyOutcome,
  latestRunOf,
  MESSAGE_EVENT,
  MESSAGE_FACT,
  attachmentOf,
  MODEL_FACT,
  newMessageId,
  STOP_FACT,
  stoppedRunAfter,
  unanswered,
  writingReply,
  type ChatData,
  type ClosedData,
  type CommandData,
  type EffortChangedData,
  type Message,
  type ModelChangedData,
  type MessageData,
  type StopData,
  type WritingReply,
} from "./model.ts";
import { runReply, WORKTREE_ALLOW_ALWAYS, WORKTREE_ALLOW_ONCE, WORKTREE_CHOICES, WORKTREE_DENY, WORKTREE_REPLY_EVENT, WORKTREE_YES } from "./reply.ts";
import { chatCommands, findCommand, helpText, parseCommand, runCommand } from "./command.ts";
import { chatViews } from "./views.ts";

/** How many rounds one reply run may take before it stops (each round is one visit). */
export const REPLY_MAX_VISITS = 20;

/** The flow a message starts: answer, and go round again while messages came meanwhile. */
export const replyFlow = defineFlow({
  name: "chat:reply",
  entry: "reply",
  maxVisits: REPLY_MAX_VISITS,
  steps: [
    {
      id: "reply",
      kind: "plugin",
      params: { use: "chat/reply", params: {} },
      replay: "unsafe",
      next: {
        done: "done",
        more: "reply",
        waiting: "person",
        failed: "failed",
        interrupted: "cancelled",
      },
    },
    {
      // A question ran out of grace. The answer sends the run back to the
      // reply, which continues the session with it.
      id: "person",
      kind: "wait_person",
      params: {
        prompt: "The agent asked a question.",
        choices: [...WORKTREE_CHOICES],
        // The older yes/no and the internal names still answer an item opened before this.
        lateChoices: ["allow_once", "allow_always", "reject_once", "yes", "no"],
      },
      replay: "safe",
      next: {
        [WORKTREE_ALLOW_ONCE]: "reply",
        [WORKTREE_ALLOW_ALWAYS]: "reply",
        [WORKTREE_DENY]: "reply",
        [WORKTREE_YES]: "reply",
        allow_once: "reply",
        allow_always: "reply",
        reject_once: "reply",
        yes: "reply",
        no: "reply",
        interrupted: "cancelled",
      },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
    { id: "cancelled", kind: "end", params: { status: "cancelled" }, replay: "safe" },
  ],
});

/** What {@link sendMessage} needs of an action's context. */
export type SendContext = Pick<ActionContext, "facts" | "emit" | "actor">;

/**
 * Records a user message on chat `chatId` and, when events can be routed, starts
 * the reply: what `chat:send` does. An action that creates a chat with a first
 * message calls it for the new chat. Returns the line to show.
 */
export async function sendMessage(
  ctx: SendContext,
  chatId: string,
  note: string,
  ref?: string,
  files: readonly string[] = [],
): Promise<string> {
  const via = ctx.actor.via;
  // The message records who sent it as it is; the event uses a known source, or
  // `other` for a client this plugin does not know, so it is still answered.
  const known = CHAT_SOURCES.find((name) => name === via);
  const source = known ?? OTHER_SOURCE;
  const id = newMessageId();
  const message: MessageData = {
    id,
    role: "user",
    from: { via: ctx.actor.via, id: ctx.actor.id },
    text: note,
    attachments: files.map((path) => attachmentOf(path)),
    source: { kind: via, ref: ref ?? null },
  };
  // The message is a fact first; the event is what starts the answer.
  await ctx.facts.append({ type: MESSAGE_FACT, object: chatRef(chatId), data: message });
  if (ctx.emit === undefined) return `recorded ${id}; it is answered when operad serve runs`;
  await ctx.emit({ source, type: MESSAGE_EVENT, key: id, object: `${CHAT_TYPE}:${chatId}` });
  return `sent ${id}`;
}

const sendAction: ActionTypeDefinition = {
  name: "send",
  on: CHAT_TYPE,
  args: {
    type: "object",
    properties: {
      note: {
        type: "string",
        role: "note",
        description: "The message. Optional when files are sent.",
      },
      attachments: {
        type: "array",
        items: { type: "string", format: "file" },
        description: "Files sent with the message, as uploaded by the client.",
      },
      ref: {
        type: "string",
        minLength: 1,
        description: "The message's id where it came from, such as a Telegram message id.",
      },
    },
    additionalProperties: false,
  },
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; it takes no messages` : undefined,
  async run(ctx, args) {
    const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
    if (chatData(stored.data).closed) {
      throw new Error(`chat ${ctx.object.id} is closed; it takes no messages`);
    }
    const input = args as {
      readonly note?: string;
      readonly ref?: string;
      readonly attachments?: readonly string[];
    };
    const files = input.attachments ?? [];
    const text = input.note ?? "";
    if (text.trim().length === 0 && files.length === 0) {
      throw new Error("a message needs text or an attachment; pass --note <text>");
    }
    // A command is text alone: attachments mean a message, never a command.
    const parsed = files.length === 0 ? parseCommand(text) : undefined;
    const command = parsed === undefined ? undefined : findCommand(chatCommands(ctx.actions ?? []), parsed.name);
    if (parsed !== undefined && command !== undefined) {
      const result = await runCommand(ctx, command, parsed.rest);
      const data: CommandData = {
        from: { via: ctx.actor.via, id: ctx.actor.id },
        command: parsed.text,
        outcome: result.outcome,
        ok: result.ok,
      };
      await ctx.facts.append({ type: COMMAND_FACT, object: chatRef(ctx.object.id), data });
      return result.outcome;
    }
    return sendMessage(ctx, ctx.object.id, text, input.ref, files);
  },
};

/** The models the chat's agent lists, as the enum of `chat:model`. */
function modelArgs(models: readonly string[]): ActionArgsSchema {
  return {
    type: "object",
    properties: {
      model: {
        type: "string",
        ...(models.length === 0 ? {} : { enum: [...models] }),
        description: "The model the next reply uses.",
      },
    },
    required: ["model"],
    additionalProperties: false,
  };
}

const modelAction: ActionTypeDefinition = {
  name: "model",
  on: CHAT_TYPE,
  command: "Change the model the next reply uses.",
  args: modelArgs([]),
  argsFor: (object, env) => modelArgs(env.models?.[chatData(object.data).harness]?.list ?? []),
  when: (state, env) =>
    !chatData(state).closed && (env.models?.[chatData(state).harness]?.list.length ?? 0) > 0,
  why: (object, env) => {
    const chat = chatData(object.data);
    if (chat.closed) return `${object.id} is closed; its model cannot change`;
    if ((env.models?.[chat.harness]?.list.length ?? 0) === 0) {
      return `the agent "${chat.harness}" offers no model to pick`;
    }
    return undefined;
  },
  async run(ctx, args) {
    const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
    const chat = chatData(stored.data);
    if (chat.closed) throw new Error(`chat ${ctx.object.id} is closed; its model cannot change`);
    const model = (args as { readonly model: string }).model;
    const offered = ctx.models[chat.harness]?.list ?? [];
    if (!offered.includes(model)) {
      throw new Error(
        `the agent "${chat.harness}" cannot use the model "${model}"; it offers: ${offered.join(", ") || "none"}`,
      );
    }
    if (chat.model === model) return `chat ${ctx.object.id} already uses ${model}`;
    const changed: ModelChangedData = {
      by: { via: ctx.actor.via, id: ctx.actor.id },
      from: chat.model ?? null,
      to: model,
    };
    await ctx.facts.append({
      type: MODEL_FACT,
      object: chatRef(ctx.object.id),
      data: changed,
    });
    // Read again: a reply may have moved the session while the fact was written.
    const fresh = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (fresh !== undefined) {
      await ctx.store.put(CHAT_TYPE, ctx.object.id, { ...fresh.data, model }, "action:chat/model");
    }
    return `chat ${ctx.object.id} now uses ${model}; the next reply uses it`;
  },
};

/** The efforts the chat's agent lists, as the enum of `chat:effort`. */
function effortArgs(efforts: readonly string[]): ActionArgsSchema {
  return {
    type: "object",
    properties: {
      effort: {
        type: "string",
        ...(efforts.length === 0 ? {} : { enum: [...efforts] }),
        description: "The effort the next reply uses.",
      },
    },
    required: ["effort"],
    additionalProperties: false,
  };
}

const effortAction: ActionTypeDefinition = {
  name: "effort",
  on: CHAT_TYPE,
  command: "Change the effort the next reply uses.",
  args: effortArgs([]),
  argsFor: (object, env) => effortArgs(env.efforts?.[chatData(object.data).harness]?.list ?? []),
  when: (state, env) =>
    !chatData(state).closed && (env.efforts?.[chatData(state).harness]?.list.length ?? 0) > 0,
  why: (object, env) => {
    const chat = chatData(object.data);
    if (chat.closed) return `${object.id} is closed; its effort cannot change`;
    if ((env.efforts?.[chat.harness]?.list.length ?? 0) === 0) {
      return `the agent "${chat.harness}" offers no effort to pick`;
    }
    return undefined;
  },
  async run(ctx, args) {
    const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
    const chat = chatData(stored.data);
    if (chat.closed) throw new Error(`chat ${ctx.object.id} is closed; its effort cannot change`);
    const effort = (args as { readonly effort: string }).effort;
    const offered = ctx.efforts[chat.harness];
    const list = offered?.list ?? [];
    if (!list.includes(effort)) {
      throw new Error(
        `the agent "${chat.harness}" cannot use the effort "${effort}"; it offers: ${list.join(", ") || "none"}`,
      );
    }
    if (chat.effort === effort) return `chat ${ctx.object.id} already uses ${effort}`;
    const changed: EffortChangedData = {
      by: { via: ctx.actor.via, id: ctx.actor.id },
      from: chat.effort ?? offered?.default ?? null,
      to: effort,
    };
    await ctx.facts.append({
      type: EFFORT_FACT,
      object: chatRef(ctx.object.id),
      data: changed,
    });
    // Read again: a reply may have moved the session while the fact was written.
    const fresh = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (fresh !== undefined) {
      const fallback = offered?.default;
      await ctx.store.put(
        CHAT_TYPE,
        ctx.object.id,
        {
          ...fresh.data,
          effort,
          ...(fallback === undefined || fallback === null ? {} : { effortDefault: fallback }),
        },
        "action:chat/effort",
      );
    }
    return `chat ${ctx.object.id} now uses effort ${effort}; the next reply uses it`;
  },
};

const closeAction: ActionTypeDefinition = {
  name: "close",
  on: CHAT_TYPE,
  command: "Close this chat.",
  confirm: true,
  ends: true,
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; nothing to close` : undefined,
  async run(ctx) {
    const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
    if (chatData(stored.data).closed) return `chat ${ctx.object.id} is closed; nothing to close`;
    const closed: ClosedData = {
      by: { via: ctx.actor.via, id: ctx.actor.id },
    };
    await ctx.facts.append({ type: CLOSED_FACT, object: chatRef(ctx.object.id), data: closed });
    // Read again: a reply may have moved the session while the fact was written.
    const fresh = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (fresh !== undefined && !chatData(fresh.data).closed) {
      await ctx.store.put(CHAT_TYPE, ctx.object.id, { ...fresh.data, closed: true }, "action:chat/close");
    }
    return `closed ${ctx.object.id}`;
  },
};

const stopAction: ActionTypeDefinition = {
  name: "stop",
  on: CHAT_TYPE,
  command: "Stop the reply being written.",
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; there is no reply to stop` : undefined,
  async run(ctx) {
    const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
    if (chatData(stored.data).closed) throw new Error(`chat ${ctx.object.id} is closed; there is no reply to stop`);
    const runId = latestRunOf(chatFacts(ctx.store, ctx.object.id));
    if (runId === undefined) return "no reply is running";
    if (ctx.runs === undefined) throw new Error("this client cannot stop a reply");
    const stopped = await ctx.runs.cancel(runId);
    if (stopped !== true) return "no reply is running";
    const data: StopData = {
      runId,
      by: { via: ctx.actor.via, id: ctx.actor.id },
    };
    await ctx.facts.append({ type: STOP_FACT, object: chatRef(ctx.object.id), data });
    return "stopped the reply; what was written stays in the transcript. Messages that arrived meanwhile are not answered by themselves; send /retry to answer the last message";
  },
};

/** A token count: whole below 10k, then in k with one decimal. */
function tokenCount(count: number): string {
  return count < 10_000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

/** The token usage part of a status line, or that no agent reported it. */
function statusTokens(tokens: UsageTokens | undefined, incomplete = false): string {
  if (tokens === undefined) return "tokens unknown";
  return `${incomplete ? "at least " : ""}${tokenCount(tokens.input)} in / ${tokenCount(tokens.output)} out tokens`;
}

/** A short duration for a reply's first output. */
function statusDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const total = Math.round(secs);
  const minutes = Math.floor(total / 60);
  return minutes < 60
    ? `${minutes}m${String(total % 60).padStart(2, "0")}s`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** When a running reply began, in UTC, to the second. */
function statusClock(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace("T", " ");
}

/** What `/status` says: a few lines read from the chat's record alone. */
function statusText(
  chat: ChatData,
  messages: readonly Message[],
  facts: readonly PluginFact[],
  writing: WritingReply | undefined,
): string {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  const model = chat.model ?? chat.lastModel;
  const effort = chat.effort ?? chat.effortDefault;
  const waiting = unanswered(messages, facts).length;
  const first = firstOutputMs(last?.timings);
  const lastUsage =
    last === undefined
      ? []
      : [
          last.costMicros === undefined
            ? "cost unknown"
            : costText(last.costMicros, last.costQuality),
          statusTokens(last.tokens),
          ...(first === undefined ? [] : [`first output ${statusDuration(first)}`]),
        ];
  return [
    `Agent: ${chat.harness}`,
    `Model: ${model ?? "unknown"}`,
    `Effort: ${effort ?? "unknown"}`,
    `Reply: ${writing === undefined ? "not writing" : `writing since ${statusClock(writing.since)}`}`,
    `Waiting: ${waiting} ${waiting === 1 ? "message" : "messages"}`,
    `Cost: ${chat.costMicros === undefined ? "unknown" : costText(chat.costMicros, chat.costQuality)} · ${statusTokens(chat.tokens, chat.tokensIncomplete === true)}`,
    `Last reply: ${last === undefined ? "none" : lastUsage.join(" · ")}`,
  ].join("\n");
}

const statusAction: ActionTypeDefinition = {
  name: "status",
  on: CHAT_TYPE,
  command: "Show where this chat stands and what it has used.",
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; there is no status to show` : undefined,
  async run(ctx) {
    const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
    if (chatData(stored.data).closed) {
      throw new Error(`chat ${ctx.object.id} is closed; there is no status to show`);
    }
    const facts = chatFacts(ctx.store, ctx.object.id);
    const messages = allMessages(ctx.store, ctx.object.id);
    const entries = allEntries(ctx.store, ctx.object.id);
    const writing = writingReply(facts, messages, entries);
    // A run a crash left without a failure or stopped entry is not writing.
    // A host that cannot tell leaves the fact-only answer as it was.
    const latest = latestRunOf(facts);
    const alive = latest === undefined ? undefined : await ctx.runs?.active?.(latest);
    return statusText(
      chatData(stored.data),
      messages,
      facts,
      alive === false ? undefined : writing,
    );
  },
};

const retryAction: ActionTypeDefinition = {
  name: "retry",
  on: CHAT_TYPE,
  command: "Answer the last message again after a reply failed or was stopped.",
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; there is nothing to retry` : undefined,
  async run(ctx) {
    const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
    if (chatData(stored.data).closed) throw new Error(`chat ${ctx.object.id} is closed; there is nothing to retry`);
    const messages = allMessages(ctx.store, ctx.object.id);
    const facts = chatFacts(ctx.store, ctx.object.id);
    const pending = unanswered(messages, facts);
    let last = lastReplyOutcome(messages, allEntries(ctx.store, ctx.object.id));
    // A stop records its fact before the reply's own stopping finishes. That
    // fact is enough to retry at once, without waiting for the stopped half
    // reply to enter the record.
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (last.kind !== "failed" && last.kind !== "stopped" && lastUser !== undefined) {
      const stoppedRun = stoppedRunAfter(facts, lastUser.sequence);
      if (stoppedRun !== undefined) {
        last = { kind: "stopped", runId: stoppedRun };
      }
    }
    if (pending.length === 0) throw new Error("the last reply finished normally; there is nothing to retry");
    if (last.kind === "normal") throw new Error("the last reply finished normally; there is nothing to retry");
    if (last.kind !== "failed" && last.kind !== "stopped") {
      throw new Error("the last reply has not failed or stopped; there is nothing to retry");
    }
    if (ctx.emit === undefined) {
      throw new Error("the reply cannot be started here; operad serve is not running");
    }
    const known = CHAT_SOURCES.find((name) => name === ctx.actor.via);
    const source = known ?? OTHER_SOURCE;
    // One retry per failed or stopped attempt: a repeated command starts no second reply.
    const key = last.runId === undefined ? newMessageId() : `retry:${last.runId}`;
    await ctx.emit({
      source,
      type: MESSAGE_EVENT,
      key,
      object: `${CHAT_TYPE}:${ctx.object.id}`,
    });
    return "retrying the last message";
  },
};

const helpAction: ActionTypeDefinition = {
  name: "help",
  on: CHAT_TYPE,
  command: "What you can type with `/`.",
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; it takes no commands` : undefined,
  run(ctx) {
    return helpText(chatCommands(ctx.actions ?? []));
  },
};

/** Builds the chat plugin. */
export function createChatPlugin() {
  return definePlugin({
    name: "chat",
    kind: "domain",
    version: pkg.version,
    objects: [{ name: CHAT_TYPE, index: ["parent"], filters: CHAT_FILTERS }],
    settings: {
      type: "object",
      properties: {
        speaker: {
          type: "string",
          title: "Speaker name",
          minLength: 1,
          default: "Operad Bot",
          editable: true,
          description:
            "How a transcript labels the model's messages. A bot chat uses its bot's speaker instead.",
        },
      },
      additionalProperties: false,
    },
    steps: [
      {
        name: "reply",
        // The harness's question comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        // The harness and the chat's `refresh` step are named by the chat.
        callsNamedByData: true,
        results: ["done", "more", "waiting", "failed", "interrupted"],
        // The harness runs inside this step and may take as long as a task's work.
        timeoutSecs: 8 * 3600,
        run: runReply,
      },
    ],
    flows: [replyFlow],
    // A message from a client or a channel is answered without anyone starting
    // the answer; a user rule for the same source and type replaces these.
    rules: [
      ...[...CHAT_SOURCES, OTHER_SOURCE].map((source) => ({
        source,
        type: MESSAGE_EVENT,
        start: { flow: "chat:reply" },
        object: "$event.object",
        mode: "auto" as const,
      })),
      // The plugin that owns the working directory opened the chat's worktree;
      // answer the message that asked the worktree question again there.
      {
        source: "operad",
        type: WORKTREE_REPLY_EVENT,
        start: { flow: "chat:reply" },
        object: "$event.object",
        mode: "auto" as const,
      },
    ],
    actions: [sendAction, modelAction, effortAction, stopAction, retryAction, statusAction, closeAction, helpAction],
    views: { [CHAT_TYPE]: chatViews },
  });
}

export default createChatPlugin();

export * from "./model.ts";
export * from "./command.ts";
export * from "./reply.ts";
export * from "./views.ts";
export * from "./tail.ts";
