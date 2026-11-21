import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientApi, SourceContext, ViewEvent } from "@operad-io/engine";
import { TelegramEvents, type TelegramEvent } from "../src/events.ts";
import { createTelegramWorld, type TelegramWorld } from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A client the test wakes with one event, delegating everything else to the real views. */
class EventClient implements ClientApi {
  private wake: ((result: IteratorResult<ViewEvent>) => void) | undefined;
  private readonly queued: ViewEvent[] = [];
  private readonly views: TelegramWorld["views"];

  constructor(views: TelegramWorld["views"]) {
    this.views = views;
  }

  announce(event: ViewEvent): void {
    if (this.wake !== undefined) {
      const wake = this.wake;
      this.wake = undefined;
      wake({ done: false, value: event });
    } else {
      this.queued.push(event);
    }
  }

  list: ClientApi["list"] = (type, options) => this.views.list(type, options);

  get: ClientApi["get"] = (id) => this.views.get(id);

  section: ClientApi["section"] = (id, sectionId, cursor, options) =>
    this.views.section(id, sectionId, cursor, options);

  events(): AsyncIterable<ViewEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const queued = this.queued.shift();
          if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
          return new Promise<IteratorResult<ViewEvent>>((resolve) => {
            this.wake = resolve;
          });
        },
        return: async () => {
          this.wake?.({ done: true, value: undefined });
          this.wake = undefined;
          return { done: true, value: undefined };
        },
      }),
    };
  }

  act: ClientApi["act"] = (name, id, options) => this.views.act(name, id, options);

  pending: ClientApi["pending"] = () => this.views.pending();

  answer: ClientApi["answer"] = (options) => this.views.answer(options);
}

/** Lets the one loop reach its next read before the assertion. */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("the plugin's one event loop", () => {
  test("sends a tail only to progress and a non-chat change to no chat sender", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-events-"));
    roots.push(root);
    const w = await createTelegramWorld({ root, users: [42] });
    const client = new EventClient(w.views);
    const ctx: SourceContext = { ...w.ctx, client };
    const events = new TelegramEvents(ctx, { wait: async () => undefined });
    const progress: TelegramEvent[] = [];
    const replies: TelegramEvent[] = [];
    const typing: TelegramEvent[] = [];
    const pending: TelegramEvent[] = [];
    const source: string[] = [];
    let commands = 0;
    const handle = events.start({
      progress: (event) => progress.push(event),
      replies: (event) => replies.push(event),
      typing: (event) => typing.push(event),
      pending: (event) => pending.push(event),
      commands: () => {
        commands += 1;
      },
      source: (chatId) => source.push(chatId),
    });
    await nextTurn();

    client.announce({ id: "chat-1", type: "chat", section: "transcript", tail: "writing" });
    await nextTurn();
    expect(progress).toHaveLength(1);
    expect(replies).toHaveLength(0);
    expect(typing).toHaveLength(0);
    expect(pending).toHaveLength(0);
    expect(source).toEqual([]);
    expect(commands).toBe(0);

    client.announce({ id: "task:t1", type: "task" });
    await nextTurn();
    expect(progress).toHaveLength(1);
    expect(replies).toHaveLength(0);
    expect(typing).toHaveLength(0);
    expect(pending).toHaveLength(1);
    expect(source).toEqual([]);
    expect(commands).toBe(1);

    client.announce({ id: "chat-1", type: "chat" });
    await nextTurn();
    expect(progress).toHaveLength(2);
    expect(replies).toHaveLength(1);
    expect(typing).toHaveLength(1);
    expect(pending).toHaveLength(2);
    expect(source).toEqual(["chat-1"]);
    expect(commands).toBe(2);

    client.announce({ id: "run:r1", type: "run", section: "logs", tail: "working" });
    await nextTurn();
    expect(progress).toHaveLength(2);
    expect(replies).toHaveLength(1);
    expect(typing).toHaveLength(1);
    expect(pending).toHaveLength(2);
    expect(source).toEqual(["chat-1"]);
    expect(commands).toBe(2);

    await handle.stop();
    await w.close();
  });
});
