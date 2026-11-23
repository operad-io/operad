import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CHAT_TYPE,
  ENTRY_FACT,
  RUN_FACT,
  allMessages,
  chatRef,
  deliveriesToCarry,
  deliveryBlock,
  readChat,
} from "@operad-io/chat";
import { createViews, type ClientApi, type TriggerEvent } from "@operad-io/engine";
import { BotScheduleSource, routinesOf } from "../src/index.ts";
import { SCHEDULE_QUIET_MARKER } from "../src/schedule.ts";
import { cleanupRoots, rig } from "./support.ts";

process.env.TZ = "UTC";

afterAll(cleanupRoots);

type R = Awaited<ReturnType<typeof rig>>;

const LONG = `${"Rates are up. ".repeat(60)}End of the long result.`;

/** A routine source that delivers for real: it writes into the main chat. */
function realSource(r: R, client: ClientApi, clock: { value: number }): BotScheduleSource {
  return new BotScheduleSource({
    store: r.store,
    home: r.home,
    settings: {},
    clock: () => clock.value,
    logger: { path: join(r.root, "log"), write: async () => "" },
    client,
    facts: { append: async (input) => r.store.append({ ...input, cause: "test" }) },
  });
}

async function runChats(r: R): Promise<readonly string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await r.store.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.objects.map((object) => object.id));
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** Fires the routine, then writes either a reply or a failure for its run. */
async function fire(
  r: R,
  source: BotScheduleSource,
  clock: { value: number },
  at: string,
  outcome: { readonly reply: string } | { readonly failure: string },
  n: number,
): Promise<string> {
  const before = await runChats(r);
  clock.value = Date.parse(at);
  await source.poll();
  const id = (await runChats(r)).find((item) => !before.includes(item));
  if (id === undefined) throw new Error("no run started");
  const first = allMessages(r.store, id)[0];
  if (first === undefined) throw new Error("no message");
  await r.store.append({ type: RUN_FACT, object: chatRef(id), cause: "test", data: { runId: `run-d${n}` } });
  if ("reply" in outcome) {
    await r.store.append({
      type: "chat.message",
      object: chatRef(id),
      cause: "test",
      data: {
        id: `a-d${n}`,
        role: "assistant",
        from: { via: "claude", id: "claude" },
        text: outcome.reply,
        attachments: [],
        source: { kind: "claude", ref: null },
        replyTo: [first.id],
        runId: `run-d${n}`,
      },
    });
  } else {
    await r.store.append({
      type: ENTRY_FACT,
      object: chatRef(id),
      cause: "test",
      data: { runId: `run-d${n}`, kind: "failure", text: outcome.failure },
    });
  }
  await source.settled();
  return id;
}

async function setup(events: TriggerEvent[] = []) {
  const r = await rig({}, ["claude", "pi"], (event) => events.push(event));
  const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
  const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
  const source = realSource(r, views as unknown as ClientApi, clock);
  await r.act("bot", "default", "bot/schedule-add", { name: "Morning news", schedule: "* * * * *", prompt: "Look." });
  await source.begin();
  return { r, views, clock, source };
}

/** What is in the chat that is not a person's or the assistant's message. */
function deliveries(r: R, chat: string) {
  return allMessages(r.store, chat).filter((message) => message.role === "delivery");
}

describe("a routine's result reaches the bot's main chat", () => {
  test("a result with content is one message in the main chat, headed with the routine, and starts no reply", async () => {
    const events: TriggerEvent[] = [];
    const { r, views, clock, source } = await setup(events);
    try {
      const main = await r.open("default");
      const before = events.length;
      const run = await fire(r, source, clock, "2026-01-01T00:01:10Z", { reply: LONG }, 1);
      const sent = deliveries(r, main);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        role: "delivery",
        text: LONG,
        delivery: { routine: "Morning news", runId: run },
      });
      // The run record is no chat and holds no delivery; nothing started a reply.
      expect(deliveries(r, run)).toHaveLength(0);
      expect(events.slice(before).filter((event) => event.object === `chat:${main}`)).toEqual([]);
      expect(allMessages(r.store, main).some((message) => message.role === "assistant")).toBe(false);
    } finally {
      views.close();
    }
  });

  test("it goes to the chat bound to Telegram, not a newer unbound one", async () => {
    const { r, views, clock, source } = await setup();
    try {
      const bound = await r.open("default", { channels: ["telegram:42"] });
      const newer = await r.open("default");
      await fire(r, source, clock, "2026-01-01T00:01:10Z", { reply: "Three items." }, 1);
      expect(deliveries(r, bound)).toHaveLength(1);
      expect(deliveries(r, newer)).toHaveLength(0);
    } finally {
      views.close();
    }
  });

  test("nothing to report is not delivered and stays a line in the routine's history", async () => {
    const { r, views, clock, source } = await setup();
    try {
      const main = await r.open("default");
      await fire(r, source, clock, "2026-01-01T00:01:10Z", { reply: SCHEDULE_QUIET_MARKER }, 1);
      expect(allMessages(r.store, main)).toHaveLength(0);
      expect((await routinesOf(r.store, "default"))[0]?.runs).toMatchObject([{ status: "quiet" }]);
    } finally {
      views.close();
    }
  });

  test("a failure is always delivered, as failed", async () => {
    const { r, views, clock, source } = await setup();
    try {
      const main = await r.open("default");
      await fire(r, source, clock, "2026-01-01T00:01:10Z", { failure: "agent crashed" }, 1);
      const sent = deliveries(r, main);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ text: "agent crashed", delivery: { routine: "Morning news", failed: true } });
    } finally {
      views.close();
    }
  });

  test("a bot with no open chat has nowhere to deliver; the result stays in the history", async () => {
    const { r, views, clock, source } = await setup();
    try {
      await fire(r, source, clock, "2026-01-01T00:01:10Z", { reply: "Three items." }, 1);
      expect((await routinesOf(r.store, "default"))[0]?.runs).toMatchObject([{ status: "done", result: "Three items." }]);
    } finally {
      views.close();
    }
  });

  test("what rides on the main chat's next message is the summary, not the whole result", async () => {
    const { r, views, clock, source } = await setup();
    try {
      const main = await r.open("default");
      const run = await fire(r, source, clock, "2026-01-01T00:01:10Z", { reply: LONG }, 1);
      const read = readChat(r.store, main);
      const carried = deliveryBlock(deliveriesToCarry(read.messages, read.facts));
      expect(carried).toContain(`Morning news, run ${run}: `);
      expect(carried).not.toContain("End of the long result.");
      expect(carried?.length ?? 0).toBeLessThan(LONG.length);
    } finally {
      views.close();
    }
  });
});
