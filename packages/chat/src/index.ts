/** The chat plugin: a long conversation with an agent, and how a message is answered. */

import { defineFlow, definePlugin, type ActionArgsSchema, type ActionContext, type ActionTypeDefinition } from "@operad-io/engine";
import {
  CHAT_FILTERS,
  CHAT_SOURCES,
  OTHER_SOURCE,
  CHAT_TYPE,
  chatData,
  chatRef,
  CLOSED_FACT,
  EFFORT_FACT,
  MESSAGE_EVENT,
  MESSAGE_FACT,
  attachmentOf,
  MODEL_FACT,
  newMessageId,
  type ClosedData,
  type EffortChangedData,
  type ModelChangedData,
  type MessageData,
} from "./model.ts";
import { runReply } from "./reply.ts";
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
        choices: ["allow_once", "reject_once", "yes", "no"],
          lateChoices: ["allow_always"],
      },
      replay: "safe",
      next: {
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
    if ((input.note ?? "").trim().length === 0 && files.length === 0) {
      throw new Error("a message needs text or an attachment; pass --note <text>");
    }
    return sendMessage(ctx, ctx.object.id, input.note ?? "", input.ref, files);
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

/** Builds the chat plugin. */
export function createChatPlugin() {
  return definePlugin({
    name: "chat",
    kind: "domain",
    version: "0.0.0",
    objects: [{ name: CHAT_TYPE, index: ["parent"], filters: CHAT_FILTERS }],
    settings: {
      type: "object",
      properties: {
        speaker: {
          type: "string",
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
    rules: [...CHAT_SOURCES, OTHER_SOURCE].map((source) => ({
      source,
      type: MESSAGE_EVENT,
      start: { flow: "chat:reply" },
      object: "$event.object",
      mode: "auto" as const,
    })),
    actions: [sendAction, modelAction, effortAction, closeAction],
    views: { [CHAT_TYPE]: chatViews },
  });
}

export default createChatPlugin();

export * from "./model.ts";
export * from "./reply.ts";
export * from "./views.ts";
export * from "./tail.ts";
