import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_TYPE, allMessages, chatData } from "@operad-io/chat";
import {
  SQLITE_FILE_NAME,
  Secret,
  openLog,
  prepareSettings,
  type InputRecord,
} from "@operad-io/engine";
import { SqlitePluginStore } from "@operad-io/engine";
import {
  TELEGRAM_SETTINGS,
  TOKEN_SECRET,
  TelegramSource,
  createBotApi,
  createTelegramPlugin,
  readOffset,
  telegramChannel,
} from "../src/index.ts";
import { FakeApi, createTelegramWorld, update, type TelegramWorld } from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function world(options: { users?: readonly number[]; token?: string; clock?: () => number } = {}): Promise<TelegramWorld> {
  const root = await mkdtemp(join(tmpdir(), "telegram-test-"));
  roots.push(root);
  return createTelegramWorld({ root, ...options });
}

function source(w: TelegramWorld, api: FakeApi): TelegramSource {
  return new TelegramSource(w.ctx, { api, clock: () => 1_700_000_000_000 });
}

async function inputs(w: TelegramWorld): Promise<readonly InputRecord[]> {
  const found: InputRecord[] = [];
  for await (const input of w.log.readInputs()) found.push(input);
  return found;
}

function updateInputs(found: readonly InputRecord[], key: string): InputRecord[] {
  return found.filter((input) => input.source === "telegram" && input.sourceKey === key);
}

describe("the telegram source", () => {
  test("a private message from a listed user becomes one user message on a bound chat", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    api.updates = [update(100, 42, 555, "hello from telegram")];
    await source(w, api).poll();

    const chats = await w.store.list(CHAT_TYPE);
    expect(chats.objects).toHaveLength(1);
    const chat = chats.objects[0];
    if (chat === undefined) throw new Error("no chat was opened");
    expect(chatData(chat.data).channels).toEqual([telegramChannel(555)]);

    const messages = allMessages(w.store, chat.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      from: { via: "telegram", id: "42" },
      text: "hello from telegram",
      source: { kind: "telegram", ref: "100" },
    });

    // The update is one recorded event; the message event starts the reply.
    expect(updateInputs(await inputs(w), "100")).toHaveLength(1);
    const runs = await w.log.runs();
    expect(runs.map((run) => run.flow)).toEqual(["chat:reply"]);
    expect(runs[0]?.object).toBe(`chat:${chat.id}`);
    expect(readOffset(w.home)).toBe(101);
    await w.close();
  });

  test("a resent update writes no second message and starts no second reply", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    api.updates = [update(100, 42, 555, "hello")];
    const telegram = source(w, api);
    await telegram.poll();
    await telegram.poll();

    const chats = await w.store.list(CHAT_TYPE);
    const chat = chats.objects[0];
    if (chat === undefined) throw new Error("no chat was opened");
    expect(allMessages(w.store, chat.id)).toHaveLength(1);
    expect(await w.log.runs()).toHaveLength(1);
    expect(updateInputs(await inputs(w), "100")).toHaveLength(1);
    await w.close();
  });

  test("an unlisted sender and a group message are recorded and start nothing", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    api.updates = [
      update(100, 7, 555, "a stranger writes"),
      update(101, 42, 900, "a group writes", "group"),
    ];
    await source(w, api).poll();

    expect((await w.store.list(CHAT_TYPE)).objects).toHaveLength(0);
    expect(await w.log.runs()).toHaveLength(0);
    const found = await inputs(w);
    expect(updateInputs(found, "100")).toHaveLength(1);
    expect(updateInputs(found, "101")).toHaveLength(1);
    await w.close();
  });

  test("each listed user has a chat of their own", async () => {
    const w = await world({ users: [42, 43] });
    const api = new FakeApi();
    api.updates = [
      update(100, 42, 555, "from 42"),
      update(101, 43, 666, "from 43"),
    ];
    await source(w, api).poll();

    const chats = (await w.store.list(CHAT_TYPE)).objects;
    expect(chats).toHaveLength(2);
    const channels = chats.map((chat) => chatData(chat.data).channels[0]).sort();
    expect(channels).toEqual([telegramChannel(555), telegramChannel(666)]);
    for (const chat of chats) {
      const messages = allMessages(w.store, chat.id);
      expect(messages).toHaveLength(1);
    }
    await w.close();
  });

  test("a closed chat is replaced by a new one on the next message", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    api.updates = [update(100, 42, 555, "first")];
    const telegram = source(w, api);
    await telegram.poll();

    const first = (await w.store.list(CHAT_TYPE)).objects[0];
    if (first === undefined) throw new Error("no chat was opened");
    await w.views.act("chat:close", first.id, {
      yes: true,
      actor: { via: "telegram", id: "42" },
    });

    api.updates = [update(101, 42, 555, "second")];
    await telegram.poll();

    const chats = (await w.store.list(CHAT_TYPE)).objects;
    expect(chats).toHaveLength(2);
    expect(chatData(first.data).closed).toBe(false);
    const closed = await w.store.get(CHAT_TYPE, first.id);
    expect(closed === undefined ? undefined : chatData(closed.data).closed).toBe(true);
    const replacement = chats.find((chat) => chat.id !== first.id);
    if (replacement === undefined) throw new Error("no replacement chat");
    expect(chatData(replacement.data).closed).toBe(false);
    expect(chatData(replacement.data).channels).toEqual([telegramChannel(555)]);
    expect(allMessages(w.store, replacement.id).map((message) => message.source.ref)).toEqual(["101"]);
    await w.close();
  });

  test("a message already held by a closed chat is not written again", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    api.updates = [update(100, 42, 555, "first")];
    const telegram = source(w, api);
    await telegram.poll();

    const first = (await w.store.list(CHAT_TYPE)).objects[0];
    if (first === undefined) throw new Error("no chat was opened");
    await w.views.act("chat:close", first.id, {
      yes: true,
      actor: { via: "telegram", id: "42" },
    });
    await telegram.poll();

    expect((await w.store.list(CHAT_TYPE)).objects).toHaveLength(1);
    expect(allMessages(w.store, first.id)).toHaveLength(1);
    await w.close();
  });

  test("a resent update is found on an earlier chat of the same user", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    api.updates = [update(100, 42, 555, "first")];
    const telegram = source(w, api);
    await telegram.poll();

    const first = (await w.store.list(CHAT_TYPE)).objects[0];
    if (first === undefined) throw new Error("no chat was opened");
    await w.views.act("chat:close", first.id, {
      yes: true,
      actor: { via: "telegram", id: "42" },
    });
    api.updates = [update(101, 42, 555, "second")];
    await telegram.poll();
    const replacement = (await w.store.list(CHAT_TYPE)).objects.find((chat) => chat.id !== first.id);
    if (replacement === undefined) throw new Error("no replacement chat");

    api.updates = [update(100, 42, 555, "first"), update(101, 42, 555, "second")];
    await telegram.poll();

    expect((await w.store.list(CHAT_TYPE)).objects).toHaveLength(2);
    expect(allMessages(w.store, first.id).map((message) => message.source.ref)).toEqual(["100"]);
    expect(allMessages(w.store, replacement.id).map((message) => message.source.ref)).toEqual(["101"]);
    await w.close();
  });

  test("an update that cannot be handled does not stop the later ones, and is retried", async () => {
    const w = await world({ users: [42] });
    const api = new FakeApi();
    api.updates = [update(100, 42, 555, "first")];
    await source(w, api).poll();

    const missing = prepareSettings(
      TELEGRAM_SETTINGS,
      { users: [42, 43], bot: "missing" },
      "telegram",
    );
    api.updates = [
      update(101, 43, 666, "first from 43"),
      update(102, 42, 555, "second"),
    ];
    await new TelegramSource(
      { ...w.ctx, settings: missing },
      { api, clock: () => 1_700_000_000_000 },
    ).poll();

    // The bad update is logged; the chat of user 42 still takes its message.
    expect(readFileSync(w.ctx.logger.path, "utf8")).toContain("update 101");
    const chats = (await w.store.list(CHAT_TYPE)).objects;
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    if (chat === undefined) throw new Error("no chat was opened");
    expect(allMessages(w.store, chat.id).map((message) => message.source.ref)).toEqual([
      "100",
      "102",
    ]);
    // Only the update before the failure is confirmed, so the failed one is read again.
    expect(readOffset(w.home)).toBe(101);

    // Once the bot is usable, the same update is handled and nothing is duplicated.
    const fixed = prepareSettings(
      TELEGRAM_SETTINGS,
      { users: [42, 43], bot: "default" },
      "telegram",
    );
    api.updates = [
      update(101, 43, 666, "first from 43"),
      update(102, 42, 555, "second"),
    ];
    await new TelegramSource(
      { ...w.ctx, settings: fixed },
      { api, clock: () => 1_700_000_000_000 },
    ).poll();

    const after = (await w.store.list(CHAT_TYPE)).objects;
    expect(after).toHaveLength(2);
    const other = after.find((item) => chatData(item.data).channels.includes(telegramChannel(666)));
    if (other === undefined) throw new Error("no chat was opened for the second user");
    expect(allMessages(w.store, other.id).map((message) => message.source.ref)).toEqual(["101"]);
    expect(allMessages(w.store, chat.id)).toHaveLength(2);
    expect(readOffset(w.home)).toBe(103);
    await w.close();
  });

  test("the token reaches no fact, log line or error", async () => {
    const token = "super-secret-token-0406";
    const w = await world({ users: [42], token });
    const api = new FakeApi();
    api.updates = [update(100, 42, 555, "hello")];
    await source(w, api).poll();

    expect(JSON.stringify(w.store.facts())).not.toContain(token);
    expect(w.logs.join("\n")).not.toContain(token);
    expect(readFileSync(join(w.home, "telegram", "state.json"), "utf8")).not.toContain(token);

    const failing = createBotApi({
      token: new Secret(token),
      fetch: async () => {
        throw new Error(`cannot reach https://api.telegram.org/bot${token}/getUpdates`);
      },
    });
    const error = await failing.getUpdates({ offset: 0, timeoutSecs: 1 }).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(token);
    expect(String(error)).toContain("[redacted]");
    await w.close();
  });

  test("a plugin without the token says how to set it, without a token in the message", async () => {
    const w = await world({ users: [42] });
    await w.ctx.secrets.delete(TOKEN_SECRET);
    const plugin = createTelegramPlugin();
    const start = plugin.start;
    if (start === undefined) throw new Error("the plugin does not start");
    const error = await Promise.resolve(start(w.ctx)).catch((caught: unknown) => caught);
    expect(String(error)).toContain("operad secret set telegram token");
    await w.close();
  });

  test("start polls and stop ends the loop", async () => {
    const w = await world({ users: [42] });
    let polls = 0;
    let announce: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const api = {
      async getUpdates(): Promise<readonly []> {
        polls += 1;
        announce?.();
        return [];
      },
      async sendMessage(): Promise<number> {
        return 1;
      },
      async editMessage(): Promise<void> {},
      async answerCallback(): Promise<void> {},
      async sendChatAction(): Promise<void> {},
    };
    const telegram = new TelegramSource(w.ctx, {
      api,
      wait: (_ms, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    const handle = telegram.start();
    await first;
    expect(polls).toBe(1);
    handle.stop();
    await w.close();
  });
});

describe("the telegram settings", () => {
  test("the defaults are the approved ones", () => {
    expect(prepareSettings(TELEGRAM_SETTINGS, {}, "telegram")).toEqual({
      users: [],
      bot: "default",
      pending: [],
    });
  });

  test("the schema file in the package says what the plugin's settings schema says", () => {
    const strip = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(strip)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)]))
          : value;
    const file = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "telegram.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const { $schema, $id, title, description, ...schema } = file;
    expect([typeof $schema, typeof $id, typeof title, typeof description]).toEqual([
      "string",
      "string",
      "string",
      "string",
    ]);
    expect(schema).toEqual(strip(TELEGRAM_SETTINGS) as Record<string, unknown>);
  });
});

const FIXTURE = fileURLToPath(new URL("./fixtures/serve.ts", import.meta.url));

function startChild(root: string, updatesPath: string): Bun.Subprocess {
  return Bun.spawn({
    cmd: [process.execPath, FIXTURE],
    cwd: root,
    env: {
      ...process.env,
      TELEGRAM_ROOT: root,
      TELEGRAM_UPDATES: updatesPath,
      TELEGRAM_USERS: "42",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Resolves with the first `processed` line, or rejects when the child ends. */
async function processedLine(child: Bun.Subprocess): Promise<string> {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === undefined || stderr === undefined || typeof stdout === "number" || typeof stderr === "number") {
    throw new Error("the child was not started with pipes");
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) {
      const err = await new Response(stderr).text();
      throw new Error(`the child ended without handling the updates: ${seen}\n${err}`);
    }
    seen += decoder.decode(read.value, { stream: true });
    const line = /processed[^\n]*\n/.exec(seen);
    if (line !== null) return line[0];
  }
}

function withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within 30s`)), 30_000);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

describe("restart", () => {
  test("a killed process leaves no message unanswered and no message written twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-restart-"));
    roots.push(root);
    const updatesPath = join(root, "updates.json");
    const first = update(100, 42, 555, "first");
    const second = update(101, 42, 555, "second");

    await writeFile(updatesPath, JSON.stringify([first]));
    const one = startChild(root, updatesPath);
    try {
      expect(await withDeadline(processedLine(one), "the first process")).toContain("processed 100");
    } finally {
      one.kill("SIGKILL");
      await one.exited;
    }

    await writeFile(updatesPath, JSON.stringify([first, second]));
    const two = startChild(root, updatesPath);
    try {
      expect(await withDeadline(processedLine(two), "the second process")).toContain("processed 100,101");
    } finally {
      two.kill("SIGKILL");
      await two.exited;
    }

    const storeRoot = join(root, "store");
    const home = join(root, "home");
    const store = new SqlitePluginStore({ root: storeRoot });
    const log = openLog({ backend: "sqlite", path: join(storeRoot, SQLITE_FILE_NAME), follow: false });
    try {
      const chats = await store.list(CHAT_TYPE);
      expect(chats.objects).toHaveLength(1);
      const chat = chats.objects[0];
      if (chat === undefined) throw new Error("no chat was opened");
      const messages = allMessages(store, chat.id);
      expect(messages.map((message) => message.source.ref)).toEqual(["100", "101"]);

      const found: InputRecord[] = [];
      for await (const input of log.readInputs()) found.push(input);
      expect(updateInputs(found, "100")).toHaveLength(1);
      expect(updateInputs(found, "101")).toHaveLength(1);
      expect(readOffset(home)).toBe(102);
    } finally {
      await log.close();
      store.close();
    }
  }, 60_000);
});
