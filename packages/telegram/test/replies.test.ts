import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_TYPE,
  MESSAGE_FACT,
  chatRef,
} from "@operad-io/chat";
import { Secret } from "@operad-io/engine";
import {
  BotApiError,
  ReplySender,
  TelegramSource,
  createBotApi,
  markdownToTelegramHtml,
  readSent,
  splitMarkdown,
  telegramChunks,
} from "../src/index.ts";
import { FakeApi, createTelegramWorld, update, type TelegramWorld } from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A world with one chat bound to Telegram chat 555 by a message from user 42. */
async function bound(follow = false): Promise<{ w: TelegramWorld; chat: string }> {
  const root = await mkdtemp(join(tmpdir(), "telegram-replies-"));
  roots.push(root);
  const w = await createTelegramWorld({ root, users: [42], follow });
  const api = new FakeApi();
  api.updates = [update(100, 42, 555, "hello")];
  await new TelegramSource(w.ctx, { api }).poll();
  const chat = (await w.store.list(CHAT_TYPE)).objects[0];
  if (chat === undefined) throw new Error("no chat was opened");
  return { w, chat: chat.id };
}

let counter = 0;
async function reply(w: TelegramWorld, chat: string, text: string, role: "assistant" | "user" = "assistant"): Promise<void> {
  counter += 1;
  await w.ctx.facts.append({
    type: MESSAGE_FACT,
    object: chatRef(chat),
    data: {
      id: `m-test-${counter}`,
      role,
      from: { via: "agent", id: "default" },
      text,
      attachments: [],
      source: { kind: "agent", ref: null },
    },
  });
}

/** The `send_failed` events the plugin recorded, with the summary each carries. */
async function failedEvents(w: TelegramWorld): Promise<{ key: string; object: string | undefined; summary: string }[]> {
  const found: { key: string; object: string | undefined; summary: string }[] = [];
  for await (const input of w.log.readInputs()) {
    if (input.source !== "telegram" || !input.sourceKey.startsWith("send_failed:")) continue;
    const payload = input.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const file = payload.summaryFile;
    found.push({
      key: input.sourceKey,
      object: typeof payload.object === "string" ? payload.object : undefined,
      summary: typeof file === "string" ? readFileSync(file, "utf8") : "",
    });
  }
  return found;
}

/** The type of every fact of a chat, in order. */
function chatFactTypes(w: TelegramWorld, chat: string): string[] {
  return w.store.facts(chatRef(chat), { limit: 500 }).facts.map((fact) => fact.type);
}

const never = (): Promise<void> => new Promise(() => undefined);
const instant = async (): Promise<void> => undefined;

function sender(w: TelegramWorld, api: FakeApi, wait: (ms: number, signal: AbortSignal) => Promise<void> = instant) {
  return new ReplySender(w.ctx, { api, wait, retry: { attempts: 4, baseMs: 100, maxMs: 1_000 } });
}

describe("the markdown a reply is reduced to", () => {
  test("emphasis, code, links and headings become Telegram HTML and everything is escaped", () => {
    const html = markdownToTelegramHtml(
      "# Title\n**bold** and *it* and `a<b` and [site](https://x.test/?a=1&b=2)\n- one\n```ts\nif (a < b) {}\n```\n<script>",
    );
    expect(html).toBe(
      [
        "<b>Title</b>",
        '<b>bold</b> and <i>it</i> and <code>a&lt;b</code> and <a href="https://x.test/?a=1&amp;b=2">site</a>',
        "• one",
        "<pre><code>if (a &lt; b) {}</code></pre>",
        "&lt;script&gt;",
      ].join("\n"),
    );
  });

  test("a link that is not http leaves only its label, and a table stays plain text", () => {
    expect(markdownToTelegramHtml("[x](javascript:evil)")).toBe("x");
    expect(markdownToTelegramHtml("| a | b |\n|---|---|")).toBe("| a | b |\n|---|---|");
  });

  test("a long reply is split inside the limit, and a code fence is closed and reopened", () => {
    const body = Array.from({ length: 400 }, (_, index) => `line ${index} of code`).join("\n");
    const chunks = telegramChunks(`intro\n\`\`\`ts\n${body}\n\`\`\`\nafter`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.html.length).toBeLessThanOrEqual(4096);
      expect(chunk.html.split("<pre>").length).toBe(chunk.html.split("</pre>").length);
    }
    const joined = chunks.map((chunk) => chunk.html).join("\n");
    expect(joined).toContain("line 0 of code");
    expect(joined).toContain("line 399 of code");
    expect(joined.trimEnd().endsWith("after")).toBe(true);
  });

  test("every piece of a split reply has its code fences closed", () => {
    const body = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const pieces = splitMarkdown(`\`\`\`ts\n${body}\n\`\`\``, 1000);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.split("\n").filter((line) => line.startsWith("```")).length % 2).toBe(0);
    }
  });

  test("a single line longer than the limit and text that grows when escaped still fit", () => {
    expect(splitMarkdown("x".repeat(10_000), 3500).every((piece) => piece.length <= 3500)).toBe(true);
    const chunks = telegramChunks("&".repeat(9_000));
    expect(chunks.every((chunk) => chunk.html.length <= 4096)).toBe(true);
    expect(chunks.map((chunk) => chunk.html.replaceAll("&amp;", "&")).join("")).toBe("&".repeat(9_000));
  });
});

describe("sending a reply", () => {
  test("a new assistant reply is sent once to the bound Telegram chat, and a restart does not resend it", async () => {
    const { w, chat } = await bound();
    const api = new FakeApi();
    await reply(w, chat, "the **answer**");
    await reply(w, chat, "a user line", "user");
    await sender(w, api).sweepAll();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ chatId: 555, text: "the <b>answer</b>", parseMode: "HTML" });
    expect(readSent(w.home)?.sent[`${chat}/m-test-${counter - 1}`]).toMatchObject({ done: true, chunks: 1 });

    await sender(w, api).sweepAll();
    await sender(w, api).sweepChat(chat);
    expect(api.sent).toHaveLength(1);

    await reply(w, chat, "second");
    await sender(w, api).sweepChat(chat);
    expect(api.sent.map((request) => request.text)).toEqual(["the <b>answer</b>", "second"]);
    await w.close();
  });

  test("a reply is sent when the client's events name the chat, and stop ends the watch", async () => {
    const { w, chat } = await bound(true);
    const api = new FakeApi();
    let arrived: (() => void) | undefined;
    const got = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    api.beforeSend = () => arrived?.();
    const handle = sender(w, api).start();
    // The startup sweep is over, so only the event can bring this reply.
    await handle.ready;
    await reply(w, chat, "from the event");
    await got;
    expect(api.sent.map((request) => request.text)).toEqual(["from the event"]);
    await handle.stop();
    await w.close();
  });

  test("a chat not bound to Telegram and a reply older than the first start send nothing", async () => {
    const { w, chat } = await bound();
    const api = new FakeApi();
    const opened = await w.views.act("bot:chat", "default", { args: { title: "app only" }, actor: { via: "cli", id: "me" } });
    const other = opened.opens?.slice("chat:".length);
    if (other === undefined) throw new Error("no chat");
    await reply(w, other, "for the app");
    const late = sender(w, api);
    await late.sweepAll();
    expect(api.sent).toHaveLength(0);

    // A message recorded before the reply side first ran is not new.
    const root = await mkdtemp(join(tmpdir(), "telegram-replies-"));
    roots.push(root);
    const old = await createTelegramWorld({ root, users: [42], clock: () => 1_000 });
    const feed = new FakeApi();
    feed.updates = [update(1, 42, 555, "hi")];
    await new TelegramSource(old.ctx, { api: feed }).poll();
    const oldChat = (await old.store.list(CHAT_TYPE)).objects[0]?.id;
    if (oldChat === undefined) throw new Error("no chat");
    await reply(old, oldChat, "from before");
    const fresh = new ReplySender(old.ctx, { api, clock: () => 5_000, wait: instant });
    await fresh.sweepAll();
    expect(api.sent).toHaveLength(0);
    expect(chat.length).toBeGreaterThan(0);
    await old.close();
    await w.close();
  });

  test("a long reply goes out as several messages in order, each within Telegram's limit", async () => {
    const { w, chat } = await bound();
    const api = new FakeApi();
    const text = Array.from({ length: 300 }, (_, index) => `paragraph ${index} ${"word ".repeat(20)}`).join("\n\n");
    await reply(w, chat, text);
    await sender(w, api).sweepAll();
    expect(api.sent.length).toBeGreaterThan(2);
    for (const request of api.sent) expect(request.text.length).toBeLessThanOrEqual(4096);
    const all = api.sent.map((request) => request.text).join("\n");
    expect(all.indexOf("paragraph 0 ")).toBeLessThan(all.indexOf("paragraph 299 "));
    await w.close();
  });

  test("markup Telegram cannot read is sent again as plain text", async () => {
    const { w, chat } = await bound();
    const api = new FakeApi();
    api.beforeSend = (request) => {
      if (request.parseMode === "HTML") {
        throw new BotApiError("can't parse entities", { retryable: false, badMarkup: true });
      }
    };
    await reply(w, chat, "**odd**");
    await sender(w, api).sweepAll();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ text: "**odd**" });
    expect(api.sent[0]?.parseMode).toBeUndefined();
    await w.close();
  });
});

describe("a send that fails", () => {
  test("is tried again after the waits the clock gives, and goes out once", async () => {
    const { w, chat } = await bound();
    const api = new FakeApi();
    api.beforeSend = (_request, count) => {
      if (count <= 2) throw new BotApiError("busy", { retryable: true });
    };
    const waits: number[] = [];
    await reply(w, chat, "eventually");
    await sender(w, api, async (ms) => {
      waits.push(ms);
    }).sweepAll();
    expect(waits).toEqual([100, 200]);
    expect(api.sent.map((request) => request.text)).toEqual(["eventually"]);
    await w.close();
  });

  test("waits as long as Telegram asked", async () => {
    const { w, chat } = await bound();
    const api = new FakeApi();
    api.beforeSend = (_request, count) => {
      if (count === 1) throw new BotApiError("slow down", { retryable: true, retryAfterSecs: 7 });
    };
    const waits: number[] = [];
    await reply(w, chat, "later");
    await sender(w, api, async (ms) => {
      waits.push(ms);
    }).sweepAll();
    expect(waits).toEqual([7_000]);
    await w.close();
  });

  test("that gives up is recorded as the plugin's own event, adds nothing to the chat and is not tried again", async () => {
    const { w, chat } = await bound();
    const token = "123456:SECRET-TOKEN";
    const api = createBotApi({
      token: new Secret(token),
      fetch: async (url) => {
        throw new Error(`cannot reach ${url}`);
      },
    });
    let tries = 0;
    const counting = {
      ...api,
      sendMessage: async (request: Parameters<typeof api.sendMessage>[0]) => {
        tries += 1;
        return api.sendMessage(request);
      },
    };
    await reply(w, chat, "never arrives");
    const before = chatFactTypes(w, chat);
    const waits: number[] = [];
    const wait = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const policy = { attempts: 3, baseMs: 10, maxMs: 1_000 };
    await new ReplySender(w.ctx, { api: counting, wait, retry: policy }).sweepAll();
    expect(tries).toBe(3);
    expect(waits).toEqual([10, 20]);

    const failed = await failedEvents(w);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.object).toBe(`chat:${chat}`);
    expect(failed[0]?.summary).toContain("could not send the reply");
    expect(failed[0]?.summary).toContain("gave up after 3 tries");
    expect(JSON.stringify([failed, w.logs, readSent(w.home)])).not.toContain("SECRET-TOKEN");

    // The event is the plugin's own record: the chat gains no message and no entry.
    expect(chatFactTypes(w, chat)).toEqual(before);
    // Known gap: the chat's history lists only its runs and the actions people
    // ran on it, and reads no source event, so the notice is not there. It is in
    // the plugin's log and in the run log's inputs (`telegram/send_failed`). Showing
    // it under the chat's history would need the kernel to list a source's events
    // for an object, which this task does not add. If that lands, change this line.
    expect((await w.views.section(`chat:${chat}`, "history")).markdown).not.toContain("gave up");

    await new ReplySender(w.ctx, { api: counting, wait, retry: policy }).sweepAll();
    expect(tries).toBe(3);
    expect(await failedEvents(w)).toHaveLength(1);
    await w.close();
  });

  test("a refusal that cannot change is not retried", async () => {
    const { w, chat } = await bound();
    const api = new FakeApi();
    api.beforeSend = () => {
      throw new BotApiError("Forbidden: bot was blocked by the user", { retryable: false });
    };
    const waits: number[] = [];
    await reply(w, chat, "blocked");
    await sender(w, api, async (ms) => {
      waits.push(ms);
    }).sweepAll();
    expect(waits).toEqual([]);
    expect((await failedEvents(w))[0]?.summary).toContain("bot was blocked");
    await w.close();
  });

  test("the Bot API's own errors never carry the token", async () => {
    const token = "999:ABC-SECRET";
    const api = createBotApi({
      token: new Secret(token),
      fetch: async (url) =>
        new Response(JSON.stringify({ ok: false, description: `bad ${url}`, parameters: { retry_after: 3 } }), {
          status: 429,
        }),
    });
    const error = await api.sendMessage({ chatId: 1, text: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BotApiError);
    if (!(error instanceof BotApiError)) throw error;
    expect(error.message).not.toContain("ABC-SECRET");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSecs).toBe(3);
  });
});

const FIXTURE = fileURLToPath(new URL("./fixtures/reply.ts", import.meta.url));

function child(root: string, sentPath: string, mode: "write" | "send"): Bun.Subprocess {
  return Bun.spawn({
    cmd: [process.execPath, FIXTURE],
    cwd: root,
    env: { ...process.env, TELEGRAM_ROOT: root, TELEGRAM_SENT: sentPath, MODE: mode },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function firstLine(process: Bun.Subprocess, prefix: string): Promise<string> {
  const stdout = process.stdout;
  const stderr = process.stderr;
  if (stdout === undefined || stderr === undefined || typeof stdout === "number" || typeof stderr === "number") {
    throw new Error("the child was not started with pipes");
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) throw new Error(`the child ended before "${prefix}": ${seen}\n${await new Response(stderr).text()}`);
    seen += decoder.decode(read.value, { stream: true });
    const line = seen.split("\n").find((candidate) => candidate.startsWith(prefix));
    if (line !== undefined) return line;
  }
}

async function killed(process: Bun.Subprocess): Promise<void> {
  process.kill("SIGKILL");
  await process.exited;
}

describe("restart", () => {
  test("a reply written before a killed process sends is sent by the next one, once", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-replies-restart-"));
    roots.push(root);
    const sentPath = join(root, "sent.jsonl");
    await Bun.write(sentPath, "");

    const one = child(root, sentPath, "write");
    try {
      expect(await firstLine(one, "written")).toBe("written");
    } finally {
      await killed(one);
    }
    expect(readFileSync(sentPath, "utf8")).toBe("");

    const two = child(root, sentPath, "send");
    try {
      expect(await firstLine(two, "swept")).toBe("swept 1");
    } finally {
      await killed(two);
    }

    const three = child(root, sentPath, "send");
    try {
      expect(await firstLine(three, "swept")).toBe("swept 1");
    } finally {
      await killed(three);
    }

    const lines = readFileSync(sentPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ chatId: 555, text: "the answer" });
  }, 60_000);
});

describe("how the Bot API's answer is sorted", () => {
  async function failure(status: number, description: string): Promise<BotApiError> {
    const api = createBotApi({
      token: new Secret("1:T"),
      fetch: async () => new Response(JSON.stringify({ ok: false, description }), { status }),
    });
    const error = await api.sendMessage({ chatId: 1, text: "x" }).catch((caught: unknown) => caught);
    if (!(error instanceof BotApiError)) throw new Error("not a BotApiError");
    return error;
  }

  test("a server error can be retried, a bad request cannot, and unreadable markup is named", async () => {
    expect((await failure(502, "bad gateway")).retryable).toBe(true);
    const bad = await failure(400, "Bad Request: can't parse entities: x");
    expect([bad.retryable, bad.badMarkup]).toEqual([false, true]);
    const other = await failure(400, "Bad Request: chat not found");
    expect([other.retryable, other.badMarkup]).toEqual([false, false]);
  });
});
