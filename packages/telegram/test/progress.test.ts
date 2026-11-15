import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_TYPE, ENTRY_FACT, MESSAGE_FACT, chatRef } from "@operad-io/chat";
import { Secret, type ClientApi, type SectionOptions, type SourceContext, type ViewEvent } from "@operad-io/engine";
import { fakeClock, type FakeClock } from "@operad-io/engine/testing";
import {
  BotApiError,
  PROGRESS_INTERVAL_MS,
  ProgressSender,
  ReplySender,
  TelegramSource,
  createBotApi,
  telegramProgress,
} from "../src/index.ts";
import { FakeApi, createTelegramWorld, update, type TelegramWorld } from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A client the test drives: the tail the transcript gives, and a way to wake the watcher. */
class ProgressClient implements ClientApi {
  tail: string | undefined;
  /** Whether the client says a run works; false unless a test says otherwise. */
  readonly running = new Map<string, boolean>();
  /** The `after` marks the progress side read with, in order. */
  readonly afters: (string | undefined)[] = [];
  private mark = 0;
  private wake: ((result: IteratorResult<ViewEvent>) => void) | undefined;
  private fail: ((error: unknown) => void) | undefined;
  private readonly queued: ViewEvent[] = [];
  private readonly views: TelegramWorld["views"];

  constructor(views: TelegramWorld["views"]) {
    this.views = views;
  }

  announce(id: string): void {
    const event = { id };
    if (this.wake !== undefined) {
      const wake = this.wake;
      this.wake = undefined;
      this.fail = undefined;
      wake({ done: false, value: event });
    } else {
      this.queued.push(event);
    }
  }

  list: ClientApi["list"] = (type, options) => this.views.list(type, options);
  get: ClientApi["get"] = async (id) => {
    const object = await this.views.get(id);
    return { ...object, row: { ...object.row, running: this.running.get(id) ?? false } };
  };

  section: ClientApi["section"] = async (_id, sectionId, _cursor, options?: SectionOptions) => {
    this.afters.push(options?.after);
    if (sectionId !== "transcript") return { markdown: "" };
    const mark = String(this.mark);
    this.mark += 1;
    return {
      markdown: "",
      mark,
      ...(this.tail === undefined ? {} : { tail: this.tail }),
    };
  };

  act: ClientApi["act"] = (name, id, options) => this.views.act(name, id, options);
  pending: ClientApi["pending"] = () => this.views.pending();
  answer: ClientApi["answer"] = (options) => this.views.answer(options);

  events(): AsyncIterable<ViewEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const queued = this.queued.shift();
          if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
          return new Promise<IteratorResult<ViewEvent>>((resolve, reject) => {
            this.wake = resolve;
            this.fail = reject;
          });
        },
        return: async () => {
          this.wake?.({ done: true, value: undefined });
          this.wake = undefined;
          this.fail = undefined;
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

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

interface Fixture {
  readonly w: TelegramWorld;
  readonly api: FakeApi;
  readonly chat: string;
  readonly client: ProgressClient;
  readonly clock: FakeClock;
  readonly replies: ReplySender;
  readonly progress: ProgressSender;
  stopProgress(): Promise<void>;
  stop(): Promise<void>;
}

/** A world with one chat bound to Telegram chat 555, and a client the test drives. */
async function setup(
  makeWait?: (clock: FakeClock) => (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "telegram-progress-"));
  roots.push(root);
  const w = await createTelegramWorld({ root, users: [42] });
  const api = new FakeApi();
  api.updates = [update(100, 42, 555, "hello")];
  await new TelegramSource(w.ctx, { api }).poll();
  const chat = (await w.store.list(CHAT_TYPE)).objects[0]?.id;
  if (chat === undefined) throw new Error("no chat was opened");
  const client = new ProgressClient(w.views);
  const ctx: SourceContext = { ...w.ctx, client };
  const clock = fakeClock();
  const wait = makeWait?.(clock) ?? clockWait(clock);
  const replies = new ReplySender(ctx, { api, wait: clockWait(clock) });
  const progress = new ProgressSender(ctx, {
    api,
    replies,
    clock: () => clock.now(),
    wait,
  });
  const handle = progress.start();
  await handle.ready;
  return {
    w,
    api,
    chat,
    client,
    clock,
    replies,
    progress,
    stopProgress: () => handle.stop(),
    async stop() {
      await handle.stop();
      await w.close();
    },
  };
}

let counter = 0;

/** Records the reply the chat's user message waits for. */
async function appendReply(f: Fixture, text: string): Promise<void> {
  counter += 1;
  await f.w.ctx.facts.append({
    type: MESSAGE_FACT,
    object: chatRef(f.chat),
    data: {
      id: `m-progress-${counter}`,
      role: "assistant",
      from: { via: "agent", id: "default" },
      text,
      attachments: [],
      source: { kind: "agent", ref: null },
    },
  });
}

/** Records why the chat's reply failed. */
async function appendFailure(f: Fixture, text: string): Promise<void> {
  await f.w.ctx.facts.append({
    type: ENTRY_FACT,
    object: chatRef(f.chat),
    data: { runId: "run-progress-failure", kind: "failure", text },
  });
}

/** Lets work already woken by a clock advance run before the next assertion. */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("the progress message of a reply", () => {
  test("the Bot API client edits with markup and deletes a message", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const api = createBotApi({
      token: new Secret("1:T"),
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      },
    });
    await api.editMessage({ chatId: 555, messageId: 7, text: "<b>x</b>", parseMode: "HTML" });
    await api.deleteMessage({ chatId: 555, messageId: 7 });
    expect(calls[0]?.url.endsWith("/editMessageText")).toBe(true);
    expect(calls[0]?.body).toMatchObject({ chat_id: 555, message_id: 7, text: "<b>x</b>", parse_mode: "HTML" });
    expect(calls[1]?.url.endsWith("/deleteMessage")).toBe(true);
    expect(calls[1]?.body).toEqual({ chat_id: 555, message_id: 7 });
  });

  test("nothing is sent before the first text, and an unfinished code fence is closed", async () => {
    const f = await setup();
    await f.progress.syncChat(f.chat);
    expect(f.api.sent).toHaveLength(0);
    expect(f.api.edits).toHaveLength(0);

    f.client.tail = "```ts\nconst open = true;";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);
    expect(f.api.sent[0]).toMatchObject({ chatId: 555, parseMode: "HTML" });
    expect(f.api.sent[0]?.text).toContain("<pre><code>");
    expect(f.api.sent[0]?.text).toContain("const open = true;");
    expect(f.api.sent[0]?.text).toContain("</code></pre>");
    await f.stop();
  });

  test("edits are at most one per two seconds, carry the newest tail, and skip an unchanged text", async () => {
    const f = await setup();
    f.client.tail = "first";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);
    expect(f.api.sent.map((request) => request.text)).toEqual(["first"]);
    expect(f.client.afters[0]).toBeUndefined();

    f.client.tail = "second";
    await f.progress.syncChat(f.chat);
    f.client.tail = "third";
    await f.progress.syncChat(f.chat);
    expect(f.api.edits).toHaveLength(0);
    expect(f.client.afters[1]).toBe("0");

    f.clock.advance(PROGRESS_INTERVAL_MS - 1);
    await nextTurn();
    expect(f.api.edits).toHaveLength(0);

    f.clock.advance(1);
    await f.api.until(() => f.api.edits.length >= 1);
    expect(f.api.edits).toHaveLength(1);
    expect(f.api.edits[0]?.text).toBe("third");

    // The same text again, after the interval, is still not an edit.
    f.clock.advance(PROGRESS_INTERVAL_MS);
    await f.progress.syncChat(f.chat);
    await nextTurn();
    expect(f.api.edits).toHaveLength(1);

    f.client.tail = "fourth";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.edits.length >= 2);
    expect(f.api.edits[1]?.text).toBe("fourth");
    await f.stop();
  });

  test("a long tail shows its end within Telegram's limit", async () => {
    const f = await setup();
    f.client.tail = `BEGIN ${"x".repeat(12_000)} END`;
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);
    const text = f.api.sent[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("END");
    expect(text).not.toContain("BEGIN");
    await f.stop();
  });

  test("a 429 waits the retry_after Telegram asked and the edit still lands", async () => {
    const waits: number[] = [];
    let retried: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      retried = resolve;
    });
    const f = await setup((clock) => (ms, signal) => {
      waits.push(ms);
      if (ms > PROGRESS_INTERVAL_MS) retried?.();
      return clockWait(clock)(ms, signal);
    });
    f.client.tail = "first";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);

    f.api.beforeEdit = (_request, count) => {
      if (count === 1) throw new BotApiError("slow down", { retryable: true, retryAfterSecs: 7 });
    };
    f.client.tail = "second";
    await f.progress.syncChat(f.chat);
    f.clock.advance(PROGRESS_INTERVAL_MS);
    await Promise.race([reached, f.progress.settled()]);
    expect(waits.filter((ms) => ms > PROGRESS_INTERVAL_MS)).toEqual([7_000]);
    expect(f.api.edits).toHaveLength(0);

    f.clock.advance(7_000);
    await f.api.until(() => f.api.edits.length >= 1);
    expect(f.api.edits[0]?.text).toBe("second");
    await f.stop();
  });

  test("the final reply is a new message and the progress message is deleted after it", async () => {
    const f = await setup();
    f.client.tail = "partial";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);
    const progressId = 9_000 + f.api.sent.length;

    await appendReply(f, "the answer");
    f.client.announce(f.chat);
    await f.api.until(() => f.api.deleted.length >= 1);
    expect(f.api.sent.map((request) => request.text)).toEqual(["partial", "the answer"]);
    expect(f.api.deleted[0]).toMatchObject({ chatId: 555, messageId: progressId });
    await f.stop();
  });

  test("a failed reply sends its failure line as a new message, then deletes the progress message", async () => {
    const f = await setup();
    f.client.tail = "partial";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);
    const progressId = 9_000 + f.api.sent.length;

    await appendFailure(f, "The reply failed: boom");
    await f.progress.syncChat(f.chat);
    expect(f.api.sent.map((request) => request.text)).toEqual(["partial", "The reply failed: boom"]);
    expect(f.api.deleted[0]).toMatchObject({ chatId: 555, messageId: progressId });
    await f.stop();
  });

  test("a stopped reply deletes the progress message once the client says the run ended", async () => {
    const f = await setup();
    f.client.tail = "partial";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);
    const progressId = 9_000 + f.api.sent.length;

    // The tail is gone, but the run still works: the progress message stays.
    f.client.tail = undefined;
    f.client.running.set(f.chat, true);
    await f.progress.syncChat(f.chat);
    expect(f.api.deleted).toHaveLength(0);

    f.client.running.set(f.chat, false);
    await f.progress.syncChat(f.chat);
    expect(f.api.sent).toHaveLength(1);
    expect(f.api.deleted[0]).toMatchObject({ chatId: 555, messageId: progressId });
    await f.stop();
  });

  test("a failed edit is logged and the final reply still goes out, then the progress message goes", async () => {
    const f = await setup();
    f.client.tail = "partial";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);
    const progressId = 9_000 + f.api.sent.length;

    f.api.beforeEdit = () => {
      throw new BotApiError("Forbidden: bot was blocked by the user", { retryable: false });
    };
    f.client.tail = "changed";
    await f.progress.syncChat(f.chat);
    f.clock.advance(PROGRESS_INTERVAL_MS);
    await f.progress.settled();
    expect(f.api.editAttempts).toBe(1);
    expect(f.api.edits).toHaveLength(0);
    expect(f.api.deleted).toHaveLength(0);

    await appendReply(f, "the answer");
    f.client.announce(f.chat);
    await f.api.until(() => f.api.deleted.length >= 1);
    expect(f.api.sent.map((request) => request.text)).toEqual(["partial", "the answer"]);
    expect(f.api.deleted[0]).toMatchObject({ chatId: 555, messageId: progressId });
    await f.stop();
  });

  test("a restart deletes a progress message a killed serve left behind", async () => {
    const f = await setup();
    f.client.tail = "still writing";
    await f.progress.syncChat(f.chat);
    await f.api.until(() => f.api.sent.length >= 1);
    const progressId = 9_000 + f.api.sent.length;
    await f.stopProgress();

    const api = new FakeApi();
    const clock = fakeClock();
    const again = new ProgressSender(f.w.ctx, {
      api,
      replies: f.replies,
      clock: () => clock.now(),
      wait: clockWait(clock),
    });
    const handle = again.start();
    await handle.ready;
    expect(api.deleted[0]).toMatchObject({ chatId: 555, messageId: progressId });
    await handle.stop();
    await f.w.close();
  });
});

describe("the tail a progress message shows", () => {
  test("a tail longer than Telegram takes is reduced to its end, with its fences closed", () => {
    const body = Array.from({ length: 600 }, (_, index) => `line ${index} of ${"x".repeat(40)}`).join("\n");
    const chunk = telegramProgress(`\`\`\`ts\n${body}\n\`\`\`\nstill open`);
    if (chunk === undefined) throw new Error("no progress chunk");
    expect(chunk.html.length).toBeLessThanOrEqual(4096);
    expect(chunk.html).toContain("still open");
    expect(chunk.html.split("<pre>").length).toBe(chunk.html.split("</pre>").length);
  });
});
