/**
 * One world for the Telegram tests: the chat and bot plugins, a harness that
 * cannot answer, the kernel's rules and the client API the source acts through.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBotPlugin } from "@operad-io/bot";
import { createChatPlugin } from "@operad-io/chat";
import {
  FileSecretStore,
  Kernel,
  PluginRegistry,
  SqlitePluginStore,
  Views,
  createPluginLogger,
  definePlugin,
  loadTriggerRules,
  openLog,
  prepareSettings,
  recordAnswer,
  type JsonValue,
  type LogBackend,
  type PluginStepResult,
  type StepContext,
  type SourceContext,
  type TriggerEvent,
} from "@operad-io/engine";
import { SQLITE_FILE_NAME } from "../../engine/src/log/sqlite.ts";
import type {
  AnswerCallbackRequest,
  BotApi,
  EditMessageRequest,
  GetUpdatesRequest,
  SendChatActionRequest,
  SendMessageRequest,
  TelegramUpdate,
} from "../src/api.ts";
import { TELEGRAM_SETTINGS } from "../src/settings.ts";

/** A fake Bot API: a list of updates, and every request it was given. */
export class FakeApi implements BotApi {
  updates: readonly TelegramUpdate[] = [];
  readonly calls: GetUpdatesRequest[] = [];
  /** Return every update whatever the offset, as a resent update does. */
  ignoreOffset = true;

  /** Every message sent, in order. */
  readonly sent: SendMessageRequest[] = [];
  /** Called before each send; throw to fail it. */
  beforeSend: ((request: SendMessageRequest, count: number) => void) | undefined;
  private attempts = 0;
  private sentNow: (() => void) | undefined;

  /** Resolves when a message is sent that was not sent yet (at once when one already was). */
  nextSend(): Promise<void> {
    if (this.sent.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.sentNow = resolve;
    });
  }

  async sendMessage(request: SendMessageRequest): Promise<number> {
    this.attempts += 1;
    this.beforeSend?.(request, this.attempts);
    this.sent.push(request);
    this.sentNow?.();
    return 9_000 + this.sent.length;
  }

  /** Every edit of a message, in order. */
  readonly edits: EditMessageRequest[] = [];
  /** Every answer to a button tap, in order. */
  readonly callbacks: AnswerCallbackRequest[] = [];
  /** Every typing indicator, in order. */
  readonly chatActions: SendChatActionRequest[] = [];
  /** Called before each chat action; throw to fail it. */
  beforeChatAction: ((request: SendChatActionRequest, count: number) => void) | undefined;
  private chatActionAttempts = 0;
  private readonly watchers: (() => void)[] = [];

  /** Resolves when `found` holds; looked at again after every chat action. */
  async until(found: () => boolean): Promise<void> {
    if (found()) return;
    await new Promise<void>((resolve) => {
      const watcher = (): void => {
        if (!found()) return;
        this.watchers.splice(this.watchers.indexOf(watcher), 1);
        resolve();
      };
      this.watchers.push(watcher);
    });
  }

  private changed(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  async editMessage(request: EditMessageRequest): Promise<void> {
    this.edits.push(request);
  }

  async answerCallback(request: AnswerCallbackRequest): Promise<void> {
    this.callbacks.push(request);
  }

  async sendChatAction(request: SendChatActionRequest): Promise<void> {
    this.chatActionAttempts += 1;
    this.chatActions.push(request);
    this.changed();
    this.beforeChatAction?.(request, this.chatActionAttempts);
  }

  async getUpdates(request: GetUpdatesRequest): Promise<readonly TelegramUpdate[]> {
    this.calls.push(request);
    if (this.ignoreOffset) return this.updates;
    return this.updates.filter((update) => update.update_id >= request.offset);
  }
}

/** One message from a person, in a private chat unless `type` says otherwise. */
export function update(
  updateId: number,
  userId: number,
  chatId: number,
  text: string,
  type = "private",
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type },
      from: { id: userId },
      text,
    },
  };
}

/** One tap on a button of the message `messageId` in the private chat `chatId`. */
export function tap(updateId: number, userId: number, chatId: number, messageId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: userId },
      message: { message_id: messageId, chat: { id: chatId, type: "private" } },
      data,
    },
  };
}

/** A reply from a person to the message `replyTo`. */
export function replyUpdate(updateId: number, userId: number, chatId: number, text: string, replyTo: number): TelegramUpdate {
  const base = update(updateId, userId, chatId, text);
  if (base.message === undefined) return base;
  return { ...base, message: { ...base.message, reply_to_message: { message_id: replyTo } } };
}

/** The harness a chat opens with; it answers nothing (no runner runs in these tests). */
function fakeHarness(agent: AgentScript | undefined) {
  return definePlugin({
    name: "test-agent",
    kind: "harness",
    version: "0.0.0",
    models: { list: ["test-model"], default: "test-model" },
    efforts: { list: [], default: null },
    ...(agent === undefined
      ? {}
      : {
          steps: [
            {
              name: "agent",
              resumable: true,
              results: ["done", "failed", "interrupted", "waiting"],
              run: (ctx: StepContext, params: unknown) => agent(ctx, isRecord(params) ? params : {}),
            },
          ],
        }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the fake agent does with one round of a chat's reply. */
export type AgentScript = (ctx: StepContext, params: Record<string, unknown>) => Promise<PluginStepResult> | PluginStepResult;

export interface TelegramWorld {
  readonly root: string;
  readonly home: string;
  readonly storeRoot: string;
  readonly store: SqlitePluginStore;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly views: Views;
  readonly kernel: Kernel;
  readonly ctx: SourceContext;
  readonly logs: string[];
  close(): Promise<void>;
}

export interface WorldOptions {
  readonly root: string;
  readonly users?: readonly number[];
  readonly bot?: string;
  readonly pending?: readonly string[];
  readonly token?: string;
  readonly clock?: (() => number) | undefined;
  /** Views announce changes through `events()`; off unless a test needs it. */
  readonly follow?: boolean | undefined;
  /** What the chat's agent does; with none it has no step and no run can be driven. */
  readonly agent?: AgentScript | undefined;
  /** More plugins loaded beside the chat and bot plugins, such as `dev`. */
  readonly plugins?: readonly unknown[] | undefined;
}

/** Builds the world a source runs in; the caller owns and removes `root`. */
export async function createTelegramWorld(options: WorldOptions): Promise<TelegramWorld> {
  const home = join(options.root, "home");
  const storeRoot = join(options.root, "store");
  mkdirSync(home, { recursive: true });
  mkdirSync(storeRoot, { recursive: true });
  const clock = options.clock ?? (() => 1_700_000_000_000);
  const logs: string[] = [];
  const onLog = (message: string): void => {
    logs.push(message);
  };

  const store = new SqlitePluginStore({ root: storeRoot, clock });
  const log = openLog({ backend: "sqlite", path: join(storeRoot, SQLITE_FILE_NAME), follow: false });
  let kernel: Kernel | undefined;
  const registry = new PluginRegistry([createChatPlugin(), createBotPlugin(), fakeHarness(options.agent), ...(options.plugins ?? [])], {
    home,
    cwd: options.root,
    store,
    storeRoot,
    clock,
    settings: {},
    onLog,
    // What `operad serve` does with an answer an action gives: record it for the run.
    onAnswer: async (runId, choice, note, actor) => {
      await recordAnswer({ log, runId, choice, ...(note === undefined ? {} : { note }), actor });
    },
    onEvent: async (event: TriggerEvent) => {
      await kernel?.receive(event);
    },
  });
  const rules = await loadTriggerRules({ home, registry, onLog });
  const views = new Views({
    registry,
    store,
    log,
    home,
    cwd: options.root,
    clock,
    onLog,
    follow: options.follow ?? false,
  });
  kernel = new Kernel({ log, registry, home, storeRoot, rules, clock, client: views, onLog });

  const secrets = new FileSecretStore({ home, plugin: "telegram" });
  await secrets.set("token", options.token ?? "test-token");
  const settings = prepareSettings(
    TELEGRAM_SETTINGS,
    {
      users: [...(options.users ?? [42])],
      ...(options.bot === undefined ? {} : { bot: options.bot }),
      ...(options.pending === undefined ? {} : { pending: [...options.pending] }),
    },
    "telegram",
  );

  const ctx: SourceContext = {
    plugin: "telegram",
    home,
    cwd: options.root,
    store,
    facts: {
      append: (input) => store.append({ ...input, cause: input.cause ?? "telegram" }),
    },
    logger: createPluginLogger(store.root, "telegram", "source"),
    signal: new AbortController().signal,
    settings,
    secrets,
    rules,
    clock,
    emit: async (event) => {
      const trigger: TriggerEvent = {
        source: event.source ?? "telegram",
        key: event.key,
        type: event.type,
        hops: 0,
        ...(event.object === undefined ? {} : { object: event.object }),
        ...(event.summary === undefined ? {} : { summary: event.summary }),
        ...(event.data === undefined ? {} : { data: event.data as JsonValue }),
        ...(event.link === undefined ? {} : { link: event.link }),
      };
      await kernel?.receive(trigger);
    },
    client: views,
  };

  return {
    root: options.root,
    home,
    storeRoot,
    store,
    log,
    registry,
    views,
    kernel,
    ctx,
    logs,
    async close() {
      views.close();
      await log.close();
      store.close();
    },
  };
}
