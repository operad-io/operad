/** The chat plugin: a long conversation with an agent, and how a message is answered. */

import { defineFlow, definePlugin, type ActionTypeDefinition } from "@operad-io/engine";
import {
  CHAT_SOURCES,
  CHAT_TYPE,
  chatRef,
  MESSAGE_EVENT,
  MESSAGE_FACT,
  newMessageId,
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
      },
      replay: "safe",
      next: {
        allow_once: "reply",
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

const sendAction: ActionTypeDefinition = {
  name: "send",
  on: CHAT_TYPE,
  args: {
    type: "object",
    properties: {
      note: {
        type: "string",
        role: "note",
        minLength: 1,
        description: "The message.",
      },
      ref: {
        type: "string",
        minLength: 1,
        description: "The message's id where it came from, such as a Telegram message id.",
      },
    },
    required: ["note"],
    additionalProperties: false,
  },
  when: () => true,
  async run(ctx, args) {
    const input = args as { readonly note: string; readonly ref?: string };
    const via = ctx.actor.via;
    const source = CHAT_SOURCES.find((name) => name === via) ?? "cli";
    const id = newMessageId();
    const message: MessageData = {
      id,
      role: "user",
      from: { via: ctx.actor.via, id: ctx.actor.id },
      text: input.note,
      attachments: [],
      source: { kind: source, ref: input.ref ?? null },
    };
    // The message is a fact first; the event is what starts the answer.
    await ctx.facts.append({ type: MESSAGE_FACT, object: chatRef(ctx.object.id), data: message });
    if (ctx.emit === undefined) return `recorded ${id}; it is answered when operad serve runs`;
    await ctx.emit({
      source,
      type: MESSAGE_EVENT,
      key: id,
      object: `${CHAT_TYPE}:${ctx.object.id}`,
    });
    return `sent ${id}`;
  },
};

/** Builds the chat plugin. */
export function createChatPlugin() {
  return definePlugin({
    name: "chat",
    kind: "domain",
    version: "0.0.0",
    objects: [{ name: CHAT_TYPE, index: ["parent"] }],
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
    rules: CHAT_SOURCES.map((source) => ({
      source,
      type: MESSAGE_EVENT,
      start: { flow: "chat:reply" },
      object: "$event.object",
      mode: "auto" as const,
    })),
    actions: [sendAction],
    views: { [CHAT_TYPE]: chatViews },
  });
}

export default createChatPlugin();

export * from "./model.ts";
export * from "./reply.ts";
export * from "./views.ts";
