/** The chat plugin: a long conversation with an agent, and how a message is answered. */

import { messageOf } from "@operad-io/engine";
import pkg from "../package.json" with { type: "json" };
import { defineFlow, definePlugin, formatElapsed, isRecord, modelIds, type ActionArgsSchema, type ActionContext, type ActionTypeDefinition, type HarnessCapabilities, type HarnessEfforts,type HarnessModels, type JsonValue, type ObjectStore, type PluginFact, type RunControl, type StoredObject, type UsageTokens } from "@operad-io/engine";
import { ACCESS_LEVELS, isAccessLevel, updateLiveAccessLevel, type AccessLevel } from "@operad-io/access-match";
import { stopKeptWorkers } from "@operad-io/engine/platform";
import {
  CHAT_FILTERS,
  CHAT_SOURCES,
  OTHER_SOURCE,
  CHAT_TYPE,
  chatData,
  chatFacts,
  chatRef,
  ACCESS_ACTION_REQUEST,
  ACCESS_FACT,
  ACCESS_LEVEL_INFO,
  accessLevelPath,
  CLOSED_FACT,
  COMMAND_FACT,
  COMPACT_FACT,
  costText,
  currentSession,
  effectiveEffort,
  EFFORT_FACT,
  firstOutputMs,
  lastReplyOutcome,
  latestRunOf,
  MESSAGE_EVENT,
  MESSAGE_FACT,
  MESSAGE_CHANGE_FACT,
  attachmentOf,
  MODEL_FACT,
  NEW_FACT,
  newMessageId,
  PRIVATE_FACT,
  PRIVATE_OFF_LINE,
  PRIVATE_ON_LINE,
  readChat,
  STOP_FACT,
  stoppedRunAfter,
  takenIds,
  unanswered,
  writingReplyNow,
  type AccessChangedData,
  type ChatData,
  type ClosedData,
  type CommandData,
  type EffortChangedData,
  type Message,
  type ModelChangedData,
  type MessageChangeData,
  type MessageData,
  type StopData,
  type WritingReply,
} from "./model.ts";
import { keepInterrupted, runReply, withLevelFileDeny, WORKTREE_ALLOW_ALWAYS, WORKTREE_ALLOW_ONCE, WORKTREE_CHOICES, WORKTREE_DENY, WORKTREE_REPLY_EVENT, WORKTREE_YES, worktreeChoiceInfo } from "./reply.ts";
import { syncQueuedLocked, withQueueLock } from "./queue.ts";
import { chatCommands, findCommand, helpText, parseCommand, runCommand } from "./command.ts";
import { AWAY_MINUTES_DEFAULT, recapIdOf, recapOf } from "./recap.ts";
import { readChatSkills } from "./skills.ts";
import { chatViews } from "./views.ts";

export { ACCESS_LEVEL_INFO } from "./model.ts";

/** How many rounds one reply run may take before it stops (each round is one visit). */
export const REPLY_MAX_VISITS = 20;

/** The chat an action runs on; it fails when the chat is gone. */
async function storedChat(ctx: ActionContext): Promise<StoredObject> {
  const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
  if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
  return stored;
}

/** The chat an action runs on, when it is still open; it fails with `reason` otherwise. */
async function openChat(ctx: ActionContext, reason: string): Promise<StoredObject> {
  const stored = await storedChat(ctx);
  if (chatData(stored.data).closed) throw new Error(`chat ${ctx.object.id} is closed; ${reason}`);
  return stored;
}

/** Reads the chat again and puts its data changed, when the change still applies. */
async function changeChat(
  ctx: ActionContext,
  cause: string,
  change: (data: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | undefined,
): Promise<void> {
  const fresh = await ctx.store.get(CHAT_TYPE, ctx.object.id);
  if (fresh === undefined) return;
  const data = change(fresh.data);
  if (data === undefined) return;
  await ctx.store.put(CHAT_TYPE, ctx.object.id, data, cause);
}

/** Ends the kept worker of a chat, if the agent keeps one. */
async function endKeptWorker(home: string, chat: ChatData, id: string): Promise<void> {
  await stopKeptWorkers({
    home,
    name: chat.harness,
    filter: { scope: `${CHAT_TYPE}:${id}` },
  });
}

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
        interrupted: "keep",
      },
    },
    {
      // A reply a crash, stop or restart interrupted keeps what its log
      // finished and one line saying so, so /retry can continue it.
      id: "keep",
      kind: "plugin",
      params: { use: "chat/keep", params: {} },
      replay: "safe",
      next: { done: "cancelled", failed: "cancelled" },
    },
    {
      // A question ran out of grace. The answer sends the run back to the
      // reply, which continues the session with it.
      id: "person",
      kind: "wait_person",
      params: {
        prompt: "The agent asked a question.",
        choices: [...WORKTREE_CHOICES],
        choiceInfo: worktreeChoiceInfo(),
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
export type SendContext = Pick<ActionContext, "facts" | "emit" | "actor"> & {
  /** The event source for a message a plugin writes itself; absent uses the client's. */
  readonly source?: string | undefined;
  /** The store the chat lives in, so its row can show the queue at once. */
  readonly store?: ActionContext["store"] | undefined;
  /** The operad home, for the queue lock. */
  readonly home?: string | undefined;
  /** Minutes without the person that count as away; a message after that gets a recap. Absent or 0: none. */
  readonly awayMinutes?: number | undefined;
};

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
  instruction?: string,
): Promise<string> {
  const via = ctx.actor.via;
  // The message records who sent it as it is; the event uses the source its
  // caller names, else a known client source, else `other`, so it is still answered.
  const known = CHAT_SOURCES.find((name) => name === via);
  const source = ctx.source ?? known ?? OTHER_SOURCE;
  const id = newMessageId();
  // A message of a stretch that is not remembered is marked when it is recorded.
  const privateNow =
    ctx.store !== undefined && chatData((await ctx.store.get(CHAT_TYPE, chatId))?.data ?? {}).private === true;
  const message: MessageData = {
    id,
    role: "user",
    ...(privateNow ? { private: true as const } : {}),
    from: { via: ctx.actor.via, id: ctx.actor.id },
    text: note,
    attachments: files.map((path) => attachmentOf(path)),
    source: { kind: via, ref: ref ?? null },
    ...(instruction === undefined || instruction.length === 0 ? {} : { instruction }),
  };
  // The message is a fact first; the event is what starts the answer.
  const record = async (): Promise<void> => {
    await ctx.facts.append({ type: MESSAGE_FACT, object: chatRef(chatId), data: message });
    if (ctx.store !== undefined && ctx.awayMinutes !== undefined && ctx.awayMinutes > 0) {
      // The recap follows the message that shows the person is back, and no
      // event starts from it; the model never gets it.
      const read = readChat(ctx.store, chatId);
      const current = read.messages.find((item) => item.id === id);
      const text = current === undefined ? undefined : recapOf(read.messages, read.facts, current, ctx.awayMinutes * 60_000);
      if (text !== undefined) {
        await ctx.facts.append({
          type: MESSAGE_FACT,
          object: chatRef(chatId),
          data: { id: recapIdOf(id), role: "recap", from: { via: "chat", id: "recap" }, text, attachments: [], source: { kind: "chat", ref: null } },
        });
      }
    }
    if (ctx.store !== undefined) await syncQueuedLocked(ctx.store, chatId, "action:chat/send");
  };
  if (ctx.home === undefined || ctx.store === undefined) await record();
  else await withQueueLock(ctx.home, chatId, record);
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
    await openChat(ctx, "it takes no messages");
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
    const away = ctx.settings.awayMinutes;
    return sendMessage(
      { ...ctx, awayMinutes: typeof away === "number" ? away : AWAY_MINUTES_DEFAULT },
      ctx.object.id,
      text,
      input.ref,
      files,
    );
  },
};

/** The message an action on the queue names, when it is still there to change. */
async function queuedMessage(
  ctx: ActionContext,
  messageId: string,
  action: "withdrawn" | "changed",
): Promise<Message> {
  const read = readChat(ctx.store, ctx.object.id);
  const message = read.messages.find((item) => item.id === messageId);
  if (message === undefined || message.role !== "user") {
    throw new Error(`chat ${ctx.object.id} has no queued message ${messageId}`);
  }
  if (takenIds(read.facts).has(messageId)) {
    throw new Error(`message ${messageId} was taken by a run; it can no longer be ${action}`);
  }
  return message;
}

const withdrawAction: ActionTypeDefinition = {
  name: "withdraw",
  on: CHAT_TYPE,
  args: {
    type: "object",
    properties: {
      message: {
        type: "string",
        minLength: 1,
        description: "The id of the queued message to withdraw.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; it has no queued message` : undefined,
  async run(ctx, args) {
    await openChat(ctx, "it has no queued message");
    const messageId = (args as { readonly message: string }).message;
    return withQueueLock(ctx.home, ctx.object.id, async () => {
      await queuedMessage(ctx, messageId, "withdrawn");
      const change: MessageChangeData = {
        id: messageId,
        kind: "withdraw",
        by: { via: ctx.actor.via, id: ctx.actor.id },
      };
      await ctx.facts.append({ type: MESSAGE_CHANGE_FACT, object: chatRef(ctx.object.id), data: change });
      await syncQueuedLocked(ctx.store, ctx.object.id, "action:chat/withdraw");
      return `withdrew message ${messageId}`;
    });
  },
};

const editAction: ActionTypeDefinition = {
  name: "edit",
  on: CHAT_TYPE,
  args: {
    type: "object",
    properties: {
      message: {
        type: "string",
        minLength: 1,
        description: "The id of the queued message to change.",
      },
      text: {
        type: "string",
        description: "The text it now has. Its attachments stay.",
      },
    },
    required: ["message", "text"],
    additionalProperties: false,
  },
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; it has no queued message` : undefined,
  async run(ctx, args) {
    await openChat(ctx, "it has no queued message");
    const input = args as { readonly message: string; readonly text: string };
    return withQueueLock(ctx.home, ctx.object.id, async () => {
      const message = await queuedMessage(ctx, input.message, "changed");
      if (input.text.trim().length === 0 && message.attachments.length === 0) {
        throw new Error("a message needs text or an attachment; pass --text <text>");
      }
      if (message.text === input.text) return `message ${input.message} already reads that`;
      const change: MessageChangeData = {
        id: input.message,
        kind: "text",
        by: { via: ctx.actor.via, id: ctx.actor.id },
        text: input.text,
      };
      await ctx.facts.append({ type: MESSAGE_CHANGE_FACT, object: chatRef(ctx.object.id), data: change });
      await syncQueuedLocked(ctx.store, ctx.object.id, "action:chat/edit");
      return `changed message ${input.message}`;
    });
  },
};

/** The models the chat's agent lists, as the enum and descriptions of `chat:model`. */
function modelArgs(models: HarnessModels | undefined, chat: ChatData | undefined): ActionArgsSchema {
  const list = modelIds(models);
  const current = chat?.model ?? chat?.lastModel ?? models?.default ?? undefined;
  return {
    type: "object",
    properties: {
      model: {
        type: "string",
        ...(list.length === 0 ? {} : { enum: [...list] }),
        ...(models?.info === undefined ? {} : { info: models.info }),
        ...(current === undefined || current.length === 0 ? {} : { current }),
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
  args: modelArgs(undefined, undefined),
  argsFor: (object, env) => {
    const chat = chatData(object.data);
    return modelArgs(env.models?.[chat.harness], chat);
  },
  when: (state, env) =>
    !chatData(state).closed && modelIds(env.models?.[chatData(state).harness]).length > 0,
  why: (object, env) => {
    const chat = chatData(object.data);
    if (chat.closed) return `${object.id} is closed; its model cannot change`;
    if (modelIds(env.models?.[chat.harness]).length === 0) {
      return `the agent "${chat.harness}" offers no model to pick`;
    }
    return undefined;
  },
  async run(ctx, args) {
    const stored = await openChat(ctx, "its model cannot change");
    const chat = chatData(stored.data);
    const model = (args as { readonly model: string }).model;
    const offered = modelIds(ctx.models[chat.harness]);
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
    await changeChat(ctx, "action:chat/model", (data) => ({ ...data, model }));
    return `chat ${ctx.object.id} now uses ${model}; the next reply uses it`;
  },
};

/** The efforts the chat's agent lists, as the enum of `chat:effort`. */
function effortArgs(efforts: HarnessEfforts | undefined, chat: ChatData | undefined): ActionArgsSchema {
  const list = efforts?.list ?? [];
  const current = chat === undefined ? undefined : effectiveEffort(chat, efforts);
  const fallback = efforts?.default ?? undefined;
  return {
    type: "object",
    properties: {
      effort: {
        type: "string",
        ...(list.length === 0 ? {} : { enum: [...list] }),
        ...(current === undefined || current.length === 0 ? {} : { current }),
        ...(fallback === undefined || fallback.length === 0 ? {} : { default: fallback }),
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
  args: effortArgs(undefined, undefined),
  argsFor: (object, env) => {
    const chat = chatData(object.data);
    return effortArgs(env.efforts?.[chat.harness], chat);
  },
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
    const stored = await openChat(ctx, "its effort cannot change");
    const chat = chatData(stored.data);
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
    const fallback = offered?.default;
    await changeChat(ctx, "action:chat/effort", (data) => ({
      ...data,
      effort,
      ...(fallback === undefined || fallback === null ? {} : { effortDefault: fallback }),
    }));
    return `chat ${ctx.object.id} now uses effort ${effort}; the next reply uses it`;
  },
};

function accessArgs(): ActionArgsSchema {
  return {
    type: "object",
    properties: {
      level: {
        type: "string",
        title: "Access",
        enum: [...ACCESS_LEVELS],
        oneOf: ACCESS_LEVELS.map((level) => ({
          const: level,
          title: ACCESS_LEVEL_INFO[level].title,
          description: ACCESS_LEVEL_INFO[level].description,
        })),
        description: "How much the agent may do without asking in this chat.",
      },
    },
    required: ["level"],
    additionalProperties: false,
  };
}

/**
 * Prepares a change of the level in the plugin that owns what the level applies
 * to: a repository chat opens its worktree before it becomes writable. The
 * action is marked on the in-memory chat only while it is called, so no client
 * offers it. An action that cannot prepare the change refuses it, so the level
 * stays as it was.
 */
async function prepareAccess(
  ctx: ActionContext,
  chat: ChatData,
  chatId: string,
  level: AccessLevel,
): Promise<void> {
  if (chat.accessAction === undefined) return;
  if (ctx.act === undefined) {
    throw new Error(`chat ${chatId} cannot change its access here`);
  }
  const original = ctx.object.data;
  const marked: Record<string, unknown> = { ...original, [ACCESS_ACTION_REQUEST]: true };
  Object.defineProperty(ctx.object, "data", { value: marked, configurable: true, writable: true });
  try {
    await ctx.act(chat.accessAction, { level });
  } finally {
    Object.defineProperty(ctx.object, "data", { value: original, configurable: true, writable: true });
  }
}

/** Why an agent cannot carry a level, in a plain sentence; undefined when it can or its abilities are not known. */
export function levelRefusal(
  agent: string,
  level: string,
  capabilities: Readonly<Record<string, HarnessCapabilities>> | undefined,
): string | undefined {
  const declared = capabilities?.[agent];
  if (declared === undefined) return undefined;
  const carried = declared.accessLevels ?? [];
  if (carried.includes(level)) return undefined;
  return `the agent "${agent}" cannot carry the access level "${level}"; it carries ${carried.length === 0 ? "none" : carried.join(", ")}`;
}

const accessAction: ActionTypeDefinition = {
  name: "access",
  on: CHAT_TYPE,
  command: "Change what the agent may do without asking.",
  args: accessArgs(),
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; its access cannot change` : undefined,
  async run(ctx, args) {
    const stored = await openChat(ctx, "its access cannot change");
    const chat = chatData(stored.data);
    const level = (args as { readonly level?: unknown }).level;
    if (!isAccessLevel(level)) {
      throw new Error(`the access level must be one of ${ACCESS_LEVELS.join(", ")}`);
    }
    // An agent that cannot carry the level is refused now, not at the next reply.
    const refusal = levelRefusal(chat.harness, level, ctx.capabilities);
    if (refusal !== undefined) throw new Error(refusal);
    const from = chat.accessLevel ?? chat.accessDefault ?? "ask";
    if (from === level && chat.accessChosen === true) return `chat ${ctx.object.id} already uses access level ${level}`;
    if (from === level) {
      // Naming the level it already follows is a choice: the chat keeps it when the setting moves.
      await changeChat(ctx, "action:chat/access", (data) => ({ ...data, accessLevel: level, accessChosen: true }));
      return `chat ${ctx.object.id} already uses access level ${level}`;
    }
    await prepareAccess(ctx, chat, ctx.object.id, level);
    const changed: AccessChangedData = {
      by: { via: ctx.actor.via, id: ctx.actor.id },
      from,
      to: level,
    };
    await ctx.facts.append({ type: ACCESS_FACT, object: chatRef(ctx.object.id), data: changed });
    // Read again: a reply may have moved the session while the fact was written.
    await changeChat(ctx, "action:chat/access", (data) => ({ ...data, accessLevel: level, accessChosen: true }));
    // A reply already running reads this file again for each call. The file
    // keeps the base profile, so the new level adds or removes only its own asks.
    const levelPath = accessLevelPath(ctx.home, ctx.object.id);
    try {
      await updateLiveAccessLevel(levelPath, level, withLevelFileDeny(chat.access, levelPath));
    } catch (error) {
      await ctx.logger.write(
        `the live access level could not be written: ${messageOf(error)}`,
      );
    }
    return `chat ${ctx.object.id} now uses access level ${level}; replies follow it`;
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
    const stored = await storedChat(ctx);
    if (chatData(stored.data).closed) return `chat ${ctx.object.id} is closed; nothing to close`;
    const closed: ClosedData = {
      by: { via: ctx.actor.via, id: ctx.actor.id },
    };
    const chat = chatData(stored.data);
    await ctx.facts.append({ type: CLOSED_FACT, object: chatRef(ctx.object.id), data: closed });
    // Read again: a reply may have moved the session while the fact was written.
    await changeChat(ctx, "action:chat/close", (data) =>
      chatData(data).closed ? undefined : { ...data, closed: true },
    );
    await endKeptWorker(ctx.home, chat, ctx.object.id);
    return `closed ${ctx.object.id}`;
  },
};

const newAction: ActionTypeDefinition = {
  name: "new",
  on: CHAT_TYPE,
  command: "Start a new agent session in this chat; the transcript stays. With a goal, the new session starts with a short brief of this one.",
  args: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "What comes next. The new session starts with a brief of this one for that goal.",
      },
    },
    additionalProperties: false,
  },
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; it has no session to start` : undefined,
  async run(ctx, args) {
    const stored = await openChat(ctx, "it has no session to start");
    const chat = chatData(stored.data);
    const read = readChat(ctx.store, ctx.object.id);
    const asked = (args as { readonly goal?: unknown } | undefined)?.goal;
    const goal = typeof asked === "string" ? asked.trim() : "";
    if (goal.length > 0 && ctx.emit === undefined) {
      throw new Error("the brief cannot be made here; operad serve is not running");
    }
    const from = currentSession(chat, read.messages, read.facts);
    if ((await writingReplyNow(read.facts, read.messages, read.entries, ctx.runs)) !== undefined) {
      throw new Error(`chat ${ctx.object.id} is writing a reply; send /new once it ends or /stop it`);
    }
    await ctx.facts.append({
      type: NEW_FACT,
      object: chatRef(ctx.object.id),
      data: {
        by: { via: ctx.actor.via, id: ctx.actor.id },
        ...(goal.length === 0 ? {} : { goal }),
        ...(goal.length === 0 || from === undefined ? {} : { from }),
      },
    });
    await changeChat(ctx, "action:chat/new", (data) => ({ ...data, session: null }));
    // A kept worker holds the old session in memory; the next reply starts its own.
    await endKeptWorker(ctx.home, chat, ctx.object.id);
    if (goal.length > 0 && ctx.emit !== undefined) {
      // A reply round builds the brief from the old session before anything else, so the
      // brief is made even when no message follows.
      await ctx.emit({
        source: CHAT_SOURCES.find((name) => name === ctx.actor.via) ?? OTHER_SOURCE,
        type: MESSAGE_EVENT,
        key: `new:${newMessageId()}`,
        object: `${CHAT_TYPE}:${ctx.object.id}`,
      });
      return "started a new session; a brief of this one for that goal is being made, and the next message goes to an agent that has the brief";
    }
    return "started a new session; the transcript stays and the next message goes to an agent with no earlier context";
  },
};

/** Why `chat:private` is not offered; absent when it is. Only a bot chat has a memory to keep a stretch out of. */
function privateRefusal(chat: ChatData, id: string): string | undefined {
  if (chat.closed) return `${id} is closed; it has no stretch to keep out of memory`;
  if (chat.parent === undefined || !chat.parent.startsWith("bot:")) {
    return "only a chat of a bot has a memory to keep a stretch out of";
  }
  return undefined;
}

const privateAction: ActionTypeDefinition = {
  name: "private",
  on: CHAT_TYPE,
  command:
    "Start or end a stretch that is not remembered: messages stay in the chat but do not enter the bot's memory.",
  when: (state) => privateRefusal(chatData(state), "") === undefined,
  why: (object) => privateRefusal(chatData(object.data), object.id),
  async run(ctx) {
    const stored = await openChat(ctx, "it has no stretch to keep out of memory");
    const refused = privateRefusal(chatData(stored.data), ctx.object.id);
    if (refused !== undefined) throw new Error(refused);
    const read = readChat(ctx.store, ctx.object.id);
    // The reply being written keeps the access profile it started with, so the
    // stretch changes only between replies, as `/new` does.
    if ((await writingReplyNow(read.facts, read.messages, read.entries, ctx.runs)) !== undefined) {
      throw new Error(`chat ${ctx.object.id} is writing a reply; send /private once it ends or /stop it`);
    }
    const on = chatData(stored.data).private !== true;
    await ctx.facts.append({
      type: PRIVATE_FACT,
      object: chatRef(ctx.object.id),
      data: { on, by: { via: ctx.actor.via, id: ctx.actor.id } },
    });
    // The field is there only while the stretch is on.
    await changeChat(ctx, "action:chat/private", (data) => {
      const kept = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "private"));
      return on ? { ...kept, private: true } : kept;
    });
    return on ? PRIVATE_ON_LINE : PRIVATE_OFF_LINE;
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
    const stored = await openChat(ctx, "there is no reply to stop");
    const chat = chatData(stored.data);
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
    await endKeptWorker(ctx.home, chat, ctx.object.id);
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

/** When a running reply began, in UTC, to the second. */
function statusClock(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace("T", " ");
}

/** What `/status` says: a few lines read from the chat's record and its agent's declared effort. */
function statusText(
  chat: ChatData,
  messages: readonly Message[],
  facts: readonly PluginFact[],
  writing: WritingReply | undefined,
  effort: string | undefined,
): string {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  const model = chat.model ?? chat.lastModel;
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
          ...(first === undefined ? [] : [`first output ${formatElapsed(first)}`]),
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
    const stored = await openChat(ctx, "there is no status to show");
    const read = readChat(ctx.store, ctx.object.id);
    const facts = read.facts;
    const messages = read.messages;
    const entries = read.entries;
    const writing = await writingReplyNow(facts, messages, entries, ctx.runs);
    const chat = chatData(stored.data);
    return statusText(
      chat,
      messages,
      facts,
      writing,
      effectiveEffort(chat, ctx.efforts[chat.harness]),
    );
  },
};

/** Why `chat:retry` would start no reply now; absent when it would start one. */
type RetryRefusal = "closed" | "finished" | "no-attempt" | "writing";

/** What `chat:retry` would do now: start a reply for `runId`, or why it starts none. */
interface RetryCheck {
  readonly refused?: RetryRefusal | undefined;
  /** The attempt a retry answers again, so a repeated command starts no second reply. */
  readonly runId?: string | undefined;
}

/**
 * Whether `chat:retry` would start a reply now, read the same way by the
 * action's offer, its `why` and its run: the chat is open, a message waits for
 * a reply, the last attempt failed, was stopped or was interrupted, and no
 * reply is being written. A stop records its fact before the reply's own
 * stopping finishes, so that fact counts before the stopped half reply is in
 * the record.
 */
async function retryCheck(
  store: ObjectStore,
  id: string,
  chat: ChatData,
  runs?: Pick<RunControl, "active"> | undefined,
): Promise<RetryCheck> {
  if (chat.closed) return { refused: "closed" };
  const read = readChat(store, id);
  const messages = read.messages;
  const facts = read.facts;
  if (unanswered(messages, facts).length === 0) return { refused: "finished" };
  const entries = read.entries;
  let last = lastReplyOutcome(messages, entries);
  if (last.kind !== "failed" && last.kind !== "stopped") {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const stoppedRun = lastUser === undefined ? undefined : stoppedRunAfter(facts, lastUser.sequence);
    if (stoppedRun !== undefined) last = { kind: "stopped", runId: stoppedRun };
  }
  if (last.kind === "normal") return { refused: "finished" };
  if (last.kind !== "failed" && last.kind !== "stopped") return { refused: "no-attempt" };
  if ((await writingReplyNow(facts, messages, entries, runs)) !== undefined) return { refused: "writing" };
  return last.runId === undefined ? {} : { runId: last.runId };
}

/** The line a refused `chat:retry` answers with, for its `why` and its run alike. */
function retryRefusalLine(refused: RetryRefusal, id: string): string {
  switch (refused) {
    case "closed":
      return `chat ${id} is closed; there is nothing to retry`;
    case "finished":
      return "the last reply finished normally; there is nothing to retry";
    case "no-attempt":
      return "the last reply has not failed or stopped; there is nothing to retry";
    case "writing":
      return `chat ${id} is writing a reply; retry is offered once it ends`;
  }
}

const retryAction: ActionTypeDefinition = {
  name: "retry",
  on: CHAT_TYPE,
  command: "Answer the last message again after a reply failed, was stopped or was interrupted.",
  // The offer answers the same question the run does: would this start a reply?
  when: async (state, env) =>
    env.object !== undefined &&
    (await retryCheck(env.store, env.object.id, chatData(state), env.runs)).refused === undefined,
  why: async (object, env) => {
    const refused = (await retryCheck(env.store, object.id, chatData(object.data), env.runs)).refused;
    return refused === undefined ? undefined : retryRefusalLine(refused, object.id);
  },
  async run(ctx) {
    const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
    if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
    // The offer said a reply would start; a reply may have begun since, so the
    // run asks the same question again.
    const check = await retryCheck(ctx.store, ctx.object.id, chatData(stored.data), ctx.runs);
    if (check.refused !== undefined) throw new Error(retryRefusalLine(check.refused, ctx.object.id));
    if (ctx.emit === undefined) {
      throw new Error("the reply cannot be started here; operad serve is not running");
    }
    const known = CHAT_SOURCES.find((name) => name === ctx.actor.via);
    const source = known ?? OTHER_SOURCE;
    const key = check.runId === undefined ? newMessageId() : `retry:${check.runId}`;
    await ctx.emit({
      source,
      type: MESSAGE_EVENT,
      key,
      object: `${CHAT_TYPE}:${ctx.object.id}`,
    });
    return "retrying the last message";
  },
};

/** Why `chat:compact` is not offered; absent when it is. */
function compactRefusal(chat: ChatData, id: string): string | undefined {
  if (chat.closed) return `${id} is closed; there is no context to compact`;
  if (chat.harness !== "pi") return `the ${chat.harness} agent manages its own context; only a pi chat is compacted here`;
  return undefined;
}

const compactAction: ActionTypeDefinition = {
  name: "compact",
  on: CHAT_TYPE,
  command: "Compact this chat's context now, after the agent has written what to remember.",
  when: (state) => compactRefusal(chatData(state), "") === undefined,
  why: (object) => compactRefusal(chatData(object.data), object.id),
  async run(ctx) {
    const stored = await openChat(ctx, "there is no context to compact");
    const refused = compactRefusal(chatData(stored.data), ctx.object.id);
    if (refused !== undefined) throw new Error(refused);
    if (ctx.emit === undefined) {
      throw new Error("the context cannot be compacted here; operad serve is not running");
    }
    await ctx.facts.append({ type: COMPACT_FACT, object: chatRef(ctx.object.id), data: { kind: "request" } });
    const read = readChat(ctx.store, ctx.object.id);
    if ((await writingReplyNow(read.facts, read.messages, read.entries, ctx.runs)) !== undefined) {
      // The reply being written goes round once more when it ends, and compacts then.
      return "the context is compacted when the reply being written ends";
    }
    const known = CHAT_SOURCES.find((name) => name === ctx.actor.via);
    await ctx.emit({
      source: known ?? OTHER_SOURCE,
      type: MESSAGE_EVENT,
      key: `compact:${newMessageId()}`,
      object: `${CHAT_TYPE}:${ctx.object.id}`,
    });
    return "compacting the context";
  },
};

const helpAction: ActionTypeDefinition = {
  name: "help",
  on: CHAT_TYPE,
  command: "What you can type with `/`.",
  when: (state) => !chatData(state).closed,
  why: (object) =>
    chatData(object.data).closed ? `${object.id} is closed; it takes no commands` : undefined,
  async run(ctx) {
    const skills = await readChatSkills(
      chatData(ctx.object.data),
      async (type, id) => ctx.store.get(type, id),
    );
    return helpText(chatCommands(ctx.actions ?? []), skills);
  },
};

/** Builds the chat plugin. */
export function createChatPlugin() {
  return definePlugin({
    name: "chat",
    kind: "domain",
    version: pkg.version,
    objects: [{ name: CHAT_TYPE, index: ["parent"], filters: CHAT_FILTERS, unlistedStates: ["run"] }],
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
        awayMinutes: {
          type: "integer",
          title: "Away after (minutes)",
          minimum: 0,
          default: AWAY_MINUTES_DEFAULT,
          editable: true,
          description:
            "When a person writes to a chat after this long without writing, the chat shows one recap of the routine results and replies that came meanwhile. 0 turns it off.",
        },
      },
      additionalProperties: false,
    },
    steps: [
      {
        name: "keep",
        resumable: false,
        // The chat's `refresh` step and the after step it names are named by data.
        callsNamedByData: true,
        results: ["done", "failed"],
        run: keepInterrupted,
      },
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
    actions: [sendAction, withdrawAction, editAction, modelAction, effortAction, accessAction, stopAction, newAction, privateAction, retryAction, compactAction, statusAction, closeAction, helpAction],
    views: { [CHAT_TYPE]: chatViews },
  });
}

export default createChatPlugin();

export * from "./model.ts";
export * from "./notes.ts";
export * from "./deliver.ts";
export * from "./recap.ts";
export * from "./command.ts";
export * from "./queue.ts";
export * from "./reply.ts";
export * from "./skills.ts";
export * from "./views.ts";
export * from "./tail.ts";
export * from "./segments.ts";
