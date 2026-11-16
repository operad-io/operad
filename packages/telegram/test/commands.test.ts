import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_TYPE, COMMAND_FACT, allMessages, chatData } from "@operad-io/chat";
import { definePlugin } from "@operad-io/engine";
import {
  BotApiError,
  COMMAND_STATE_MAX,
  CommandSender,
  readCommands,
  START_GREETING,
  telegramCommandsPath,
  TELEGRAM_COMMAND_NAME,
  TelegramSource,
  stripBotName,
  telegramChannel,
  writeCommands,
  type SentCommand,
} from "../src/index.ts";
import {
  FakeApi,
  createTelegramWorld,
  tap,
  update,
  type TelegramWorld,
  type WorldOptions,
} from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function world(options: Omit<WorldOptions, "root"> = {}): Promise<TelegramWorld> {
  const root = await mkdtemp(join(tmpdir(), "telegram-commands-"));
  roots.push(root);
  return createTelegramWorld({ root, ...options });
}

/** The command side and a source that hands it the text and the taps. */
function rig(w: TelegramWorld, api: FakeApi) {
  const commands = new CommandSender(w.ctx, { api });
  const source = new TelegramSource(w.ctx, { api, commands });
  return { commands, source };
}

/** A chat bound to the Telegram chat 555, opened by an ordinary message. */
async function bound(w: TelegramWorld, api: FakeApi, source: TelegramSource): Promise<string> {
  api.updates = [update(50, 42, 555, "hello")];
  await source.poll();
  api.updates = [];
  api.sent.length = 0;
  api.edits.length = 0;
  const chat = (await w.store.list(CHAT_TYPE)).objects[0];
  if (chat === undefined) throw new Error("no chat was opened");
  expect(chatData(chat.data).channels).toEqual([telegramChannel(555)]);
  return chat.id;
}

/** A bound chat, opened without the command side, so the menu starts unregistered. */
async function boundOnly(w: TelegramWorld, api: FakeApi): Promise<string> {
  return bound(w, api, new TelegramSource(w.ctx, { api }));
}

/** The names in one registered menu. */
function names(menu: readonly { readonly command: string }[] | undefined): string[] {
  return (menu ?? []).map((command) => command.command);
}

/** A plugin whose one command can be taken away while the test runs. */
function extraPlugin(available: () => boolean) {
  return definePlugin({
    name: "extra",
    kind: "domain",
    version: "0.0.0",
    actions: [
      {
        name: "extra",
        on: CHAT_TYPE,
        command: "An extra command.",
        when: () => available(),
        run: () => "done",
      },
    ],
  });
}

/** A plugin whose command description is longer than Telegram takes. */
function longDescriptionPlugin() {
  return definePlugin({
    name: "long",
    kind: "domain",
    version: "0.0.0",
    actions: [
      {
        name: "long",
        on: CHAT_TYPE,
        command: "x".repeat(300),
        when: () => true,
        run: () => "done",
      },
    ],
  });
}

/** A plugin with command names Telegram's menu does not take. */
function unfitPlugin() {
  return definePlugin({
    name: "unfit",
    kind: "domain",
    version: "0.0.0",
    actions: [
      {
        name: "a_name_that_is_longer_than_telegram_takes",
        on: CHAT_TYPE,
        command: "A name over 32 characters.",
        when: () => true,
        run: () => "done",
      },
      {
        name: "Shout",
        on: CHAT_TYPE,
        command: "A name with a capital letter.",
        when: () => true,
        run: () => "done",
      },
    ],
  });
}

describe("the bot's command menu", () => {
  test("is registered at start and again when the set of commands changes", async () => {
    let available = true;
    const w = await world({
      users: [42],
      efforts: { list: ["low", "high"], default: "low" },
      plugins: [extraPlugin(() => available)],
    });
    const api = new FakeApi();
    const commands = new CommandSender(w.ctx, { api });
    await boundOnly(w, api);
    expect(api.menus).toHaveLength(0);

    const menu = commands.start();
    await menu.ready;
    expect(api.menus).toHaveLength(1);
    expect(names(api.menus[0])).toEqual(["model", "effort", "stop", "retry", "status", "close", "help", "extra"]);
    expect(api.menus[0]?.find((command) => command.command === "model")?.description).toBe(
      "Change the model the next reply uses.",
    );

    // Nothing changed: no second call.
    await commands.refresh();
    expect(api.menus).toHaveLength(1);

    available = false;
    await commands.refresh();
    expect(api.menus).toHaveLength(2);
    expect(names(api.menus[1])).toEqual(["model", "effort", "stop", "retry", "status", "close", "help"]);

    await menu.stop();
    await w.close();
  });

  test("follows the client's events and registers again when a command appears or goes", async () => {
    let available = true;
    const w = await world({
      users: [42],
      efforts: { list: ["low", "high"], default: "low" },
      plugins: [extraPlugin(() => available)],
      follow: true,
    });
    const api = new FakeApi();
    const commands = new CommandSender(w.ctx, { api });
    const chat = await boundOnly(w, api);
    const menu = commands.start();
    await menu.ready;
    expect(api.menus).toHaveLength(1);
    expect(names(api.menus[0])).toContain("extra");

    const stored = await w.store.get(CHAT_TYPE, chat);
    if (stored === undefined) throw new Error("the chat is gone");
    // The test calls no refresh: the client's event is what moves the menu.
    available = false;
    await w.store.put(CHAT_TYPE, chat, { ...stored.data, title: "one" }, "test");
    await api.until(() => api.menus.length === 2);
    expect(names(api.menus[1])).not.toContain("extra");

    // A command that comes back moves it again.
    available = true;
    await w.store.put(CHAT_TYPE, chat, { ...stored.data, title: "two" }, "test");
    await api.until(() => api.menus.length === 3);
    expect(names(api.menus[2])).toContain("extra");

    await menu.stop();
    await w.close();
  });

  test("leaves out a name Telegram does not take and says so", async () => {
    const w = await world({
      users: [42],
      efforts: { list: ["low", "high"], default: "low" },
      plugins: [unfitPlugin()],
    });
    const api = new FakeApi();
    const commands = new CommandSender(w.ctx, { api });
    await boundOnly(w, api);
    expect(api.menus).toHaveLength(0);

    await commands.refresh();
    expect(api.menus).toHaveLength(1);
    expect(names(api.menus[0])).toEqual(["model", "effort", "stop", "retry", "status", "close", "help"]);
    for (const name of names(api.menus[0])) expect(TELEGRAM_COMMAND_NAME.test(name)).toBe(true);

    const log = readFileSync(join(w.storeRoot, "logs", "telegram", "source.log"), "utf8");
    expect(log).toContain("a_name_that_is_longer_than_telegram_takes");
    expect(log).toContain("Shout");
    expect(log).toContain("left out of the menu");
    await w.close();
  });

  test("cuts a long command description to what Telegram takes", async () => {
    const w = await world({ users: [42], plugins: [longDescriptionPlugin()] });
    const api = new FakeApi();
    const commands = new CommandSender(w.ctx, { api });
    await boundOnly(w, api);

    await commands.refresh();
    const description = api.menus[0]?.find((command) => command.command === "long")?.description;
    expect(description?.length).toBeLessThanOrEqual(256);
    expect(description?.endsWith("…")).toBe(true);
    await w.close();
  });
});

describe("a command in a Telegram chat", () => {
  const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"] as const;

  test("without its one choice it answers with the choices, one page at a time, and a tap runs it", async () => {
    const w = await world({ users: [42], models: MODELS });
    const api = new FakeApi();
    const { commands, source } = rig(w, api);
    const chat = await bound(w, api, source);

    api.updates = [update(100, 42, 555, "/model")];
    await source.poll();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.chatId).toBe(555);
    expect(api.sent[0]?.text).toBe("Change the model the next reply uses.");
    expect(api.sent[0]?.keyboard).toEqual([
      [{ text: "m0", data: "c:0" }],
      [{ text: "m1", data: "c:1" }],
      [{ text: "m2", data: "c:2" }],
      [{ text: "m3", data: "c:3" }],
      [{ text: "m4", data: "c:4" }],
      [{ text: "m5", data: "c:5" }],
      [{ text: "m6", data: "c:6" }],
      [{ text: "m7", data: "c:7" }],
      [{ text: "»", data: "p:1" }],
    ]);
    // The keyboard is not a message: the agent never sees it.
    expect(allMessages(w.store, chat)).toHaveLength(1);

    // The arrow opens the next page in the same message, and the keyboard stays.
    api.updates = [tap(101, 42, 555, 9_001, "p:1")];
    await source.poll();
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.text).toBe("Change the model the next reply uses.");
    expect(api.edits[0]?.keyboard).toEqual([
      [{ text: "m8", data: "c:8" }],
      [{ text: "m9", data: "c:9" }],
      [{ text: "«", data: "p:0" }],
    ]);

    // A choice runs the command as its text; the keyboard goes and the
    // message says what was chosen.
    api.updates = [tap(102, 42, 555, 9_001, "c:8")];
    await source.poll();
    expect(api.edits).toHaveLength(2);
    expect(api.edits[1]?.text).toBe("Change the model the next reply uses.\n\nchosen: m8");
    expect(api.edits[1]?.keyboard).toBeUndefined();
    const stored = await w.store.get(CHAT_TYPE, chat);
    expect(chatData(stored?.data ?? {}).model).toBe("m8");
    const commandsRun = w.store
      .facts({ type: CHAT_TYPE, id: chat })
      .facts.filter((fact) => fact.type === COMMAND_FACT);
    expect(commandsRun).toHaveLength(1);
    expect(commandsRun[0]?.data).toMatchObject({
      from: { via: "telegram", id: "42" },
      command: "/model m8",
      ok: true,
    });
    expect(String(commandsRun[0]?.data.outcome)).toContain("m8");
    // The tap was answered, so Telegram does not keep the button spinning.
    expect(api.callbacks.map((callback) => callback.callbackId)).toEqual(["cb-101", "cb-102"]);
    await w.close();
  });

  test("a command gets no reaction", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    const { source } = rig(w, api);
    await bound(w, api, source);
    expect(api.reactions).toHaveLength(1);
    api.reactions.length = 0;

    api.updates = [update(100, 42, 555, "/help")];
    await source.poll();
    expect(api.reactions).toHaveLength(0);
    await w.close();
  });

  test("a tap from an unlisted user counts for nothing", async () => {
    const w = await world({ users: [42], models: MODELS });
    const api = new FakeApi();
    const { source } = rig(w, api);
    const chat = await bound(w, api, source);

    api.updates = [update(100, 42, 555, "/model")];
    await source.poll();
    const before = chatData((await w.store.get(CHAT_TYPE, chat))?.data ?? {}).model;
    api.updates = [tap(101, 77, 555, 9_001, "c:3")];
    await source.poll();
    expect(api.edits).toHaveLength(0);
    const stored = await w.store.get(CHAT_TYPE, chat);
    expect(chatData(stored?.data ?? {}).model).toBe(before);
    expect(api.callbacks.every((callback) => callback.callbackId === "cb-101")).toBe(true);
    expect(api.callbacks.every((callback) => callback.text === undefined)).toBe(true);
    await w.close();
  });

  test("a command before any chat opens one, as a first message does", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    const { source } = rig(w, api);

    api.updates = [update(100, 42, 555, "/help")];
    await source.poll();
    const chats = (await w.store.list(CHAT_TYPE)).objects;
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    if (chat === undefined) throw new Error("no chat was opened");
    expect(chatData(chat.data).channels).toEqual([telegramChannel(555)]);
    // The command's text does not title the chat it opens.
    expect(chatData(chat.data).title).toBe("Telegram");
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.text).toContain("What you can type with");
    // The chat exists now, so the menu follows it.
    expect(api.menus).toHaveLength(1);
    await w.close();
  });

  test("a name with the bot after it is the plain command, and what it returns comes back", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    const { source } = rig(w, api);
    const chat = await bound(w, api, source);

    api.updates = [update(100, 42, 555, "/help@operad_bot")];
    await source.poll();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.parseMode).toBe("HTML");
    expect(api.sent[0]?.text).toContain("What you can type with");
    expect(api.sent[0]?.text).toContain("Change the model the next reply uses.");
    // It is a command, not a message: no user message was recorded.
    expect(allMessages(w.store, chat).filter((message) => message.role === "user")).toHaveLength(1);
    const fact = w.store.facts({ type: CHAT_TYPE, id: chat }).facts.find((entry) => entry.type === COMMAND_FACT);
    expect(fact?.data).toMatchObject({ command: "/help", ok: true });
    expect(stripBotName("/model@operad_bot sonnet")).toBe("/model sonnet");
    expect(stripBotName("/model sonnet")).toBe("/model sonnet");
    await w.close();
  });

  test("/start gets a greeting that points at /help and starts no chat", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    const { source } = rig(w, api);

    api.updates = [update(100, 42, 555, "/start"), update(101, 42, 555, "/start@operad_bot")];
    await source.poll();
    expect(api.sent).toHaveLength(2);
    expect(api.sent[0]?.text).toBe(START_GREETING);
    expect(api.sent[0]?.text).toContain("/help");
    expect(api.sent[1]?.text).toBe(START_GREETING);
    // A chat opened by /start would be a chat with no message; none is opened.
    expect((await w.store.list(CHAT_TYPE)).objects).toHaveLength(0);
    expect(await w.log.runs()).toHaveLength(0);
    await w.close();
  });

  test("what a command returns goes again as plain text when Telegram refuses its markup", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    const { source } = rig(w, api);
    await bound(w, api, source);

    api.beforeSend = (request, count) => {
      if (count === 1 && request.parseMode === "HTML") {
        throw new BotApiError("can't parse entities", { retryable: false, badMarkup: true });
      }
    };
    api.updates = [update(100, 42, 555, "/help")];
    await source.poll();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.parseMode).toBeUndefined();
    expect(api.sent[0]?.text).toContain("What you can type with");
    await w.close();
  });

  test("a choice keyboard survives a restart so its buttons still work", async () => {
    const w = await world({ users: [42], models: MODELS });
    const api = new FakeApi();
    const { source } = rig(w, api);
    const chat = await bound(w, api, source);

    api.updates = [update(100, 42, 555, "/model")];
    await source.poll();
    expect(api.sent).toHaveLength(1);

    const restarted = new CommandSender(w.ctx, { api });
    const sourceAgain = new TelegramSource(w.ctx, { api, commands: restarted });
    api.updates = [tap(101, 42, 555, 9_001, "c:0")];
    await sourceAgain.poll();
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.text).toEndWith("chosen: m0");
    const stored = await w.store.get(CHAT_TYPE, chat);
    expect(chatData(stored?.data ?? {}).model).toBe("m0");
    await w.close();
  });

  test("the keyboard state file keeps only the newest answered keyboards", async () => {
    const w = await world({ users: [42], models: MODELS });
    const api = new FakeApi();
    const { source } = rig(w, api);
    const chat = await bound(w, api, source);
    const old: Record<string, SentCommand> = {};
    for (let index = 0; index < COMMAND_STATE_MAX + 10; index += 1) {
      old[`${index}/1`] = {
        chatId: chat,
        target: index,
        messageId: 1,
        text: "old",
        name: "model",
        choices: ["m0", "m1"],
        page: 0,
        chosen: index % 2 === 0 ? "m0" : "m1",
      };
    }
    writeCommands(w.home, old);

    const restarted = new CommandSender(w.ctx, { api });
    const sourceAgain = new TelegramSource(w.ctx, { api, commands: restarted });
    api.updates = [update(100, 42, 555, "/model")];
    await sourceAgain.poll();
    const written = JSON.parse(readFileSync(telegramCommandsPath(w.home), "utf8")) as Record<string, unknown>;
    expect(Object.keys(written)).toHaveLength(COMMAND_STATE_MAX);
    const kept = readCommands(w.home);
    expect(kept["555/9001"]).toBeDefined();
    await w.close();
  });

  test("a command from an unlisted sender is dropped without a reply", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    const { source } = rig(w, api);
    const chat = await bound(w, api, source);

    api.updates = [update(100, 7, 555, "/model"), update(101, 7, 555, "/start")];
    await source.poll();
    expect(api.sent).toHaveLength(0);
    // Opening the chat registered the menu; the stranger's commands change nothing.
    expect(api.menus).toHaveLength(1);
    expect(allMessages(w.store, chat)).toHaveLength(1);
    await w.close();
  });
});
