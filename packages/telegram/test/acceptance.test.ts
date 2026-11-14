/**
 * The acceptance paragraph of `docs/backlog/operad-telegram.md`, followed from
 * the first message to an answered pending item: the real kernel, chat and bot
 * plugins, a real runner for the reply, the real client API, and a fake Bot API.
 */

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_TYPE, allMessages, chatData } from "@operad-io/chat";
import {
  GROWTH_EVENT_INTERVAL_MS,
  Runner,
  defineFlow,
  definePlugin,
  serveOnce,
  type SourceContext,
} from "@operad-io/engine";
import { fakeClock, type FakeClock } from "@operad-io/engine/testing";
import devPlugin, { addPlan, addRepository, addTask, confirmPlan, getTask, setTaskPhase, taskData } from "@operad-io/dev";
import {
  PendingSender,
  ReplySender,
  TelegramSource,
  TypingSender,
  TYPING_INTERVAL_MS,
  createTelegramPlugin,
  telegramChannel,
  writeOffset,
  type AnswerCallbackRequest,
  type BotApi,
  type EditMessageRequest,
  type GetUpdatesRequest,
  type SendChatActionRequest,
  type SendMessageRequest,
  type TelegramUpdate,
} from "../src/index.ts";
import { createTelegramWorld, replyUpdate, tap, update, type TelegramWorld } from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A Bot API that holds `getUpdates` until an update past the offset arrives, as a long poll does. */
class LongPollApi implements BotApi {
  private readonly queue: TelegramUpdate[] = [];
  private readonly waiting: (() => void)[] = [];
  readonly sent: (SendMessageRequest & { readonly messageId: number })[] = [];
  readonly edits: EditMessageRequest[] = [];
  readonly callbacks: AnswerCallbackRequest[] = [];
  readonly chatActions: SendChatActionRequest[] = [];
  private readonly watchers: (() => void)[] = [];

  /** What the person does: update ids are the caller's, and one may be sent again. */
  deliver(...updates: TelegramUpdate[]): void {
    this.queue.push(...updates);
    for (const wake of this.waiting.splice(0)) wake();
  }

  async getUpdates(request: GetUpdatesRequest): Promise<readonly TelegramUpdate[]> {
    for (;;) {
      const fresh = this.queue.filter((item) => item.update_id >= request.offset);
      if (fresh.length > 0) return fresh;
      if (request.signal?.aborted === true) return [];
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  async sendMessage(request: SendMessageRequest): Promise<number> {
    const messageId = 9_000 + this.sent.length + 1;
    this.sent.push({ ...request, messageId });
    this.changed();
    return messageId;
  }

  async editMessage(request: EditMessageRequest): Promise<void> {
    this.edits.push(request);
    this.changed();
  }

  async answerCallback(request: AnswerCallbackRequest): Promise<void> {
    this.callbacks.push(request);
    this.changed();
  }

  async sendChatAction(request: SendChatActionRequest): Promise<void> {
    this.chatActions.push(request);
    this.changed();
  }

  private changed(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  /** Resolves when `found` holds; looked at again after every call the bot makes. */
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
}

/** Waits on the test's clock, and ends early when its signal aborts. */
function clockWait(clock: FakeClock): (ms: number, signal: AbortSignal) => Promise<void> {
  return (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let handle: unknown;
      const done = (): void => {
        if (handle !== undefined) clock.clearTimeout(handle);
        signal.removeEventListener("abort", done);
        resolve();
      };
      handle = clock.setTimeout(done, Math.max(0, ms));
      signal.addEventListener("abort", done, { once: true });
    });
}

/** Lets work already woken by a clock advance run before the next assertion. */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Starts the plugin's three parts as `start(ctx)` does, on one fake Bot API. */
function startPlugin(ctx: SourceContext, api: BotApi) {
  const pending = new PendingSender(ctx, { api });
  const source = new TelegramSource(ctx, { api, pending, wait: async () => undefined }).start();
  const replies = new ReplySender(ctx, { api, wait: async () => undefined }).start();
  const sent = pending.start();
  return {
    ready: sent.ready,
    async stop(): Promise<void> {
      source.stop();
      await replies.stop();
      await sent.stop();
    },
  };
}

/** The test is the serve loop: a run the kernel records is given to a runner, after each event the plugin emits. */
function serveLoop(w: TelegramWorld, root: string): {
  readonly ctx: SourceContext;
  readonly runners: Promise<unknown>[];
  drive(): Promise<void>;
  /** One pass of `operad serve`: it applies the answers recorded for waiting runs and gives each run a runner. */
  pass(): Promise<void>;
} {
  const runners: Promise<unknown>[] = [];
  const driven = new Set<string>();
  const launch = async (runId: string): Promise<void> => {
    const run = (await w.log.runs()).find((candidate) => candidate.runId === runId);
    if (run === undefined || run.object === undefined) throw new Error(`no run ${runId}`);
    const found = w.registry.flow(run.flow);
    if (found === undefined) throw new Error(`no flow ${run.flow}`);
    const [type, id] = run.object.split(":");
    if (type === undefined || id === undefined) throw new Error(`object ${run.object}`);
    runners.push(
      new Runner({
        log: w.log,
        flow: found.flow,
        runId,
        registry: w.registry,
        lockRoot: join(root, "locks"),
        object: { type, id },
      }).run(),
    );
  };
  const drive = async (): Promise<void> => {
    for (const run of await w.log.runs()) {
      if (driven.has(run.runId) || run.object === undefined) continue;
      driven.add(run.runId);
      await launch(run.runId);
    }
  };
  const pass = async (): Promise<void> => {
    await serveOnce({
      log: w.log,
      registry: w.registry,
      kernel: w.kernel,
      lockRoot: join(root, "locks"),
      spawnRun: launch,
    });
    await Promise.all(runners);
  };
  const ctx: SourceContext = {
    ...w.ctx,
    emit: async (event) => {
      await w.ctx.emit(event);
      await drive();
    },
  };
  return { ctx, runners, drive, pass };
}

test("from the first Telegram message to an answered pending item", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-acceptance-"));
  roots.push(root);
  const rounds: Record<string, unknown>[] = [];
  const w: TelegramWorld = await createTelegramWorld({
    root,
    users: [42],
    follow: true,
    // The agent answers a greeting, and asks before it runs a command.
    agent: async (ctx, params) => {
      rounds.push(params);
      const text = String(params.prompt);
      if (!text.includes("run ls")) return { result: "done", data: { finalMessage: "Hi **friend**", sessionId: "s-1" } };
      const answer = await ctx.ask({ prompt: "Run this command? ls", choices: ["allow_once", "reject_once"], graceSecs: 600 });
      return { result: "done", data: { finalMessage: `ls was ${answer.choice}`, sessionId: "s-1" } };
    },
  });

  const { ctx, runners } = serveLoop(w, root);

  const api = new LongPollApi();
  const plugin = startPlugin(ctx, api);
  await plugin.ready;

  // 1. A listed user writes first: a chat opens on the default bot, bound to that Telegram chat,
  //    and the reply comes back to Telegram.
  api.deliver(update(100, 42, 555, "hello"));
  await api.until(() => api.sent.length === 1);
  expect(api.sent[0]).toMatchObject({ chatId: 555 });
  expect(api.sent[0]?.text).toContain("Hi");
  const chats = (await w.store.list(CHAT_TYPE)).objects;
  expect(chats).toHaveLength(1);
  const chat = chats[0];
  if (chat === undefined) throw new Error("no chat");
  expect(chatData(chat.data).channels).toEqual([telegramChannel(555)]);
  expect(chatData(chat.data).harness).toBe("test-agent");
  // The chat was opened on the bot the settings name, `default` here.
  expect(chatData(chat.data).parent).toBe("bot:default");

  // ...and the same exchange is the chat's transcript, which is what the phone shows.
  await Promise.all(runners);
  const transcript = (await w.views.section(`chat:${chat.id}`, "transcript")).markdown;
  expect(transcript).toContain("hello");
  expect(transcript).toContain("Hi **friend**");
  expect(allMessages(w.store, chat.id)[0]).toMatchObject({ from: { via: "telegram", id: "42" } });

  // 2. A question in that chat arrives as a card with buttons, and the same item is pending for the phone.
  api.deliver(update(101, 42, 555, "please run ls"));
  await api.until(() => api.sent.length === 2);
  const card = api.sent[1];
  if (card === undefined) throw new Error("no card");
  expect(card.text).toContain("Run this command? ls");
  expect(card.keyboard?.flat().map((button) => button.text)).toEqual(["allow_once", "reject_once"]);
  const waiting = await w.views.pending();
  expect(waiting).toHaveLength(1);
  expect(waiting[0]?.object).toBe(`chat:${chat.id}`);

  // 3. A tap answers it: the run goes on, the buttons go, the message says what was chosen,
  //    and the item leaves the pending list everywhere.
  const button = card.keyboard?.flat()[0];
  if (button === undefined) throw new Error("no button");
  api.deliver(tap(102, 42, 555, card.messageId, button.data));
  await api.until(() => api.sent.length === 3);
  expect(api.sent[2]?.text).toContain("ls was allow_once");
  expect(api.edits.some((edit) => edit.messageId === card.messageId && edit.text.includes("answered: allow_once"))).toBe(true);
  expect(await w.views.pending()).toEqual([]);
  await Promise.all(runners);

  // 4. History says which Telegram message started each run, and who answered the question.
  const history = (await w.views.section(`chat:${chat.id}`, "history")).markdown;
  expect(history).toContain("telegram");
  expect(history).toContain("allow_once");
  const keys: string[] = [];
  for await (const input of w.log.readInputs()) if (input.source === "telegram") keys.push(input.sourceKey);
  expect(keys).toContain("100");
  expect(keys).toContain("101");

  // 5. The same updates read again, as after a restart of serve, write no second message,
  //    start no second run and send nothing twice.
  await plugin.stop();
  const runsBefore = (await w.log.runs()).length;
  const sentBefore = api.sent.length;
  // The offset was not saved before serve was killed, so Telegram sends the same updates again.
  writeOffset(w.home, 100, 1_700_000_000_000);
  const again = new LongPollApi();
  again.deliver(update(100, 42, 555, "hello"), update(101, 42, 555, "please run ls"), tap(102, 42, 555, card.messageId, button.data));
  const restarted = startPlugin(ctx, again);
  await restarted.ready;
  await again.until(() => again.callbacks.length >= 1);
  expect(allMessages(w.store, chat.id).filter((message) => message.role === "user")).toHaveLength(2);
  expect((await w.log.runs()).length).toBe(runsBefore);
  expect(again.sent).toEqual([]);
  expect(sentBefore).toBe(3);
  await restarted.stop();
  await w.close();
});

test("the telegram plugin starts and stops typing through a real chat reply run", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-typing-plugin-"));
  roots.push(root);
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const w = await createTelegramWorld({
    root,
    users: [42],
    follow: true,
    agent: async () => {
      entered?.();
      await gate;
      return { result: "done", data: { finalMessage: "done", sessionId: "s-1" } };
    },
  });
  const { ctx, runners } = serveLoop(w, root);
  const api = new LongPollApi();
  const clock = fakeClock();
  const plugin = createTelegramPlugin({ api, clock: () => clock.now(), wait: clockWait(clock) });
  const start = plugin.start;
  if (start === undefined) throw new Error("the plugin does not start");
  const handle = await start(ctx);

  api.deliver(update(100, 42, 555, "hello"));
  await api.until(() => api.chatActions.length >= 1);
  expect(api.chatActions[0]).toMatchObject({ chatId: 555, action: "typing" });
  await running;
  clock.advance(TYPING_INTERVAL_MS);
  await api.until(() => api.chatActions.length >= 2);
  expect(api.chatActions).toHaveLength(2);

  await handle.stop();
  expect(clock.pending).toBe(0);
  clock.advance(TYPING_INTERVAL_MS * 3);
  expect(api.chatActions).toHaveLength(2);

  release?.();
  await Promise.all(runners);
  await w.close();
});

test("typing follows a real chat reply run from its start to its end", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-typing-run-"));
  roots.push(root);
  const clock = fakeClock();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const w = await createTelegramWorld({
    root,
    users: [42],
    follow: true,
    clock: () => clock.now(),
    agent: async () => {
      entered?.();
      await gate;
      return { result: "done", data: { finalMessage: "done", sessionId: "s-1" } };
    },
  });
  const { ctx, runners } = serveLoop(w, root);
  const api = new LongPollApi();
  const typing = new TypingSender(ctx, { api, clock: () => clock.now(), wait: clockWait(clock) });
  const handle = typing.start();
  await handle.ready;

  api.deliver(update(200, 42, 555, "hello"));
  await new TelegramSource(ctx, { api }).poll();
  await api.until(() => api.chatActions.length >= 1);
  expect(api.chatActions[0]).toMatchObject({ chatId: 555, action: "typing" });
  await running;
  // Watch the real client's changes from here, without a manual sync.
  const events = ctx.client.events()[Symbol.asyncIterator]();
  clock.advance(TYPING_INTERVAL_MS);
  await api.until(() => api.chatActions.length >= 2);

  release?.();
  await Promise.all(runners);
  const chat = (await w.store.list(CHAT_TYPE)).objects[0]?.id;
  if (chat === undefined) throw new Error("no chat was opened");
  expect((await w.views.get(chat)).row.running).toBe(false);
  // The real client announces the chat when the run ends; no manual sync.
  clock.advance(GROWTH_EVENT_INTERVAL_MS);
  const announced = await events.next();
  expect(announced.done).toBe(false);
  await typing.settled();
  clock.advance(TYPING_INTERVAL_MS * 3);
  await nextTurn();
  expect(api.chatActions).toHaveLength(2);

  await events.return?.();
  await handle.stop();
  await w.close();
});

test("typing stops when a real chat reply run fails without recording a reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-typing-failed-"));
  roots.push(root);
  const clock = fakeClock();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const w = await createTelegramWorld({
    root,
    users: [42],
    follow: true,
    clock: () => clock.now(),
    agent: async () => {
      entered?.();
      await gate;
      return { result: "failed", data: { reason: "test", message: "the agent failed" } };
    },
  });
  const { ctx, runners } = serveLoop(w, root);
  const api = new LongPollApi();
  const typing = new TypingSender(ctx, { api, clock: () => clock.now(), wait: clockWait(clock) });
  const handle = typing.start();
  await handle.ready;

  api.deliver(update(300, 42, 555, "hello"));
  await new TelegramSource(ctx, { api }).poll();
  await api.until(() => api.chatActions.length >= 1);
  await running;
  // The failed run's end is the next change the real client announces.
  const events = ctx.client.events()[Symbol.asyncIterator]();

  release?.();
  await Promise.all(runners);
  const chat = (await w.store.list(CHAT_TYPE)).objects[0]?.id;
  if (chat === undefined) throw new Error("no chat was opened");
  expect((await w.views.get(chat)).row.running).toBe(false);
  clock.advance(GROWTH_EVENT_INTERVAL_MS);
  const announced = await events.next();
  expect(announced.done).toBe(false);
  await typing.settled();
  clock.advance(TYPING_INTERVAL_MS * 3);
  await nextTurn();
  expect(api.chatActions).toHaveLength(1);

  await events.return?.();
  await handle.stop();
  await w.close();
});

/** A git work tree with one commit and an origin, which dev needs of a repository. */
async function makeGitRepository(parent: string): Promise<string> {
  const path = join(parent, "repository");
  await mkdir(path, { recursive: true });
  const git = (...args: string[]): void => {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: path });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  git("init", "-q");
  git("remote", "add", "origin", "https://example.com/repo.git");
  await writeFile(join(path, "README.md"), "# test\n");
  git("add", "README.md");
  git("commit", "-qm", "start");
  return path;
}

/** A run waiting where dev's task waits for a person, so the real dev actions are on the item. */
const waitsPlugin = definePlugin({
  name: "waits",
  kind: "domain",
  version: "0.0.0",
  flows: [
    defineFlow({
      name: "waits:review",
      entry: "wait",
      steps: [
        {
          id: "wait",
          kind: "wait_person",
          params: { prompt: "The task is ready for you.", choices: ["merge", "reject", "rework", "reverify"] },
          replay: "safe",
          next: { merge: "done", reject: "done", rework: "done", reverify: "done", interrupted: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    }),
  ],
});

test("a proposed task and a task waiting for a merge are answered from Telegram through the real dev plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-acceptance-dev-"));
  roots.push(root);
  const w = await createTelegramWorld({ root, users: [42], follow: true, pending: ["dev"], plugins: [devPlugin, waitsPlugin] });
  const repository = await addRepository(w.store, { path: await makeGitRepository(root) });
  const plan = await addPlan(w.store, { repository, slug: "work", title: "Work" });
  await addTask(w.store, { plan: plan.id, slug: "first", title: "First" });
  await confirmPlan(w.store, plan.id);
  // Added to a confirmed plan, it is proposed and waits for the owner.
  const proposed = await addTask(w.store, { plan: plan.id, slug: "second", title: "Second", openedBy: "dev" });
  // A task whose review is done waits for a merge, as a run of its flow would leave it.
  const waiting = await addTask(w.store, { plan: plan.id, slug: "third", title: "Third" });
  await setTaskPhase(w.store, waiting.id, "waiting");
  const current = taskData((await getTask(w.store, waiting.id)).data);
  await w.store.put("task", waiting.id, { ...current, attempt: { number: 1, run: "run-1", verified: "abc123" } }, "test:verified");
  const started = await w.kernel.start({ flow: "waits:review", object: `task:${waiting.id}` });
  if (started.kind !== "started") throw new Error("the wait did not start");

  const { ctx, drive, pass } = serveLoop(w, root);
  await drive();
  const api = new LongPollApi();
  const plugin = startPlugin(ctx, api);
  await plugin.ready;

  // Both items reach the listed user, each with the buttons its real actions give.
  await api.until(() => api.sent.length === 2);
  const proposedCard = api.sent.find((message) => message.text.includes("proposed"));
  const mergeCard = api.sent.find((message) => message.text.includes("ready for you"));
  if (proposedCard === undefined || mergeCard === undefined) throw new Error(`cards: ${JSON.stringify(api.sent.map((m) => m.text))}`);
  expect(proposedCard.chatId).toBe(42);
  expect(proposedCard.keyboard?.flat().map((button) => button.text)).toContain("confirm");
  const mergeButtons = mergeCard.keyboard?.flat().map((button) => button.text) ?? [];
  expect(mergeButtons).toContain("merge");
  // reject and rework need a note: no button, a reply is the note.
  expect(mergeButtons).not.toContain("reject");
  expect(mergeCard.text).toContain("Reply to this message to reject");

  // A tap on confirm confirms the task, as the Telegram user.
  const confirm = proposedCard.keyboard?.flat().find((button) => button.text === "confirm");
  if (confirm === undefined) throw new Error("no confirm button");
  api.deliver(tap(200, 42, 42, proposedCard.messageId, confirm.data));
  await api.until(() => api.edits.some((edit) => edit.messageId === proposedCard.messageId && edit.text.includes("answered: confirm")));
  expect(taskData((await getTask(w.store, proposed.id)).data).phase).toBe("ready");
  const proposedHistory = (await w.views.section(`task:${proposed.id}`, "history")).markdown;
  expect(proposedHistory).toContain("via telegram");
  expect(proposedHistory).toContain("as 42");

  // A tap from a user who is not listed changes nothing.
  api.deliver(tap(201, 7, 42, mergeCard.messageId, "o:0"));
  await api.until(() => api.callbacks.some((callback) => callback.callbackId === "cb-201"));
  expect(taskData((await getTask(w.store, waiting.id)).data).brief).not.toContain("merge requested");

  // A tap on merge answers the run's wait and the run goes on.
  const merge = mergeCard.keyboard?.flat().find((button) => button.text === "merge");
  if (merge === undefined) throw new Error("no merge button");
  api.deliver(tap(202, 42, 42, mergeCard.messageId, merge.data));
  await api.until(() => api.edits.some((edit) => edit.messageId === mergeCard.messageId && edit.text.includes("answered: merge")));
  await pass();
  expect(taskData((await getTask(w.store, waiting.id)).data).brief).toContain("merge requested");
  const mergeHistory = (await w.views.section(`task:${waiting.id}`, "history")).markdown;
  expect(mergeHistory).toContain("via telegram");
  expect(mergeHistory).toContain("as 42");
  // Only dev's note about its missing worker pool is left; it has nothing to answer.
  expect((await w.views.pending()).map((item) => item.runId)).toEqual(["dev:plugin:pool"]);
  await plugin.stop();
  await w.close();
});
