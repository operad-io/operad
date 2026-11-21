import { afterAll, describe, expect, test } from "bun:test";
import { CHAT_TYPE, chatRef, RUN_FACT } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

const MODELS = { list: ["small", "large"], default: "small" } as const;
const EFFORTS = { list: ["low", "high"], default: "low" } as const;

type Rig = Awaited<ReturnType<typeof rig>>;

async function send(r: Rig, chat: string, note: string) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/send", { note }, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

function usageReply(input: number, output: number, micros: number, quality: "exact" | "estimated") {
  return () => ({
    result: "done" as const,
    data: {
      finalMessage: "hi",
      sessionId: "s",
      usage: {
        model: "sonnet",
        tokens: { input, output, cacheread: 0, cachewrite: 0 },
        costMicros: micros,
        costQuality: quality,
      },
      timings: { startToReadyMs: 480, readyToFirstMs: 1_200, totalMs: 4_800 },
    },
  });
}

describe("chat:status", () => {
  test("shows each line: agent, model, effort, reply, waiting, session usage and the last reply", async () => {
    let count = 0;
    const r = await rig(
      () => {
        count += 1;
        return count === 1
          ? usageReply(10, 5, 100_000, "exact")()
          : usageReply(20, 6, 200_000, "estimated")();
      },
      MODELS,
      EFFORTS,
    );
    const chat = await r.chat({ model: "large", effort: "high", effortDefault: "low" });
    await r.say(chat, "one");
    await r.round(chat);
    await r.say(chat, "two");
    await r.round(chat);

    const sent = await send(r, chat, "/status");
    const text = String(sent.value);
    expect(text).toContain("Agent: fake");
    expect(text).toContain("Model: large");
    expect(text).toContain("Effort: high");
    expect(text).toContain("Reply: not writing");
    expect(text).toContain("Waiting: 0 messages");
    expect(text).toContain("Cost: ~$0.30 · 30 in / 11 out tokens");
    expect(text).toContain("Last reply: ~$0.20 · 20 in / 6 out tokens · first output 1s");

    // A command is not a message: it costs no tokens and starts no reply.
    expect(r.calls).toHaveLength(2);
    expect(r.events).toEqual([]);
  });

  test("shows the live default for an inherited effort, a choice, and the stored default only when none is declared", async () => {
    const live = await rig(() => reply("hi"), MODELS, { list: ["low", "medium", "high"], default: "high" });
    const changed = await live.chat({ effortDefault: "medium" });
    expect(String((await send(live, changed, "/status")).value)).toContain("Effort: high");
    const inherited = await live.chat({ effort: "medium", effortDefault: "medium" });
    expect(String((await send(live, inherited, "/status")).value)).toContain("Effort: high");
    const chosen = await live.chat({ effort: "low", effortDefault: "medium" });
    expect(String((await send(live, chosen, "/status")).value)).toContain("Effort: low");

    const none = await rig(() => reply("hi"), MODELS, { list: [], default: null });
    const stored = await none.chat({ effortDefault: "medium" });
    expect(String((await send(none, stored, "/status")).value)).toContain("Effort: medium");
  });

  test("an unknown cost is said to be unknown, never shown as zero", async () => {
    const r = await rig(
      () => ({
        result: "done" as const,
        data: {
          finalMessage: "hi",
          sessionId: "s",
          usage: {
            model: "sonnet",
            tokens: { input: 4, output: 2, cacheread: 0, cachewrite: 0 },
            costMicros: null,
            costQuality: null,
          },
        },
      }),
      MODELS,
      EFFORTS,
    );
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    const text = String((await send(r, chat, "/status")).value);
    expect(text).toContain("Cost: unknown · 4 in / 2 out tokens");
    expect(text).toContain("Last reply: cost unknown · 4 in / 2 out tokens");
    expect(text).not.toContain("$0.00");
  });

  test("a session that mixes reported and unreported usage says the totals are partial", async () => {
    let count = 0;
    const r = await rig(
      () => {
        count += 1;
        return count === 1 ? usageReply(10, 5, 100_000, "exact")() : reply("hi");
      },
      MODELS,
      EFFORTS,
    );
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await r.say(chat, "two");
    await r.round(chat);

    const text = String((await send(r, chat, "/status")).value);
    expect(text).toContain("Cost: ≥$0.10 · at least 10 in / 5 out tokens");
    expect(text).toContain("Last reply: cost unknown · tokens unknown");
  });

  test("an agent that reports no usage leaves both costs and tokens unknown", async () => {
    const r = await rig(() => reply("hi"), MODELS, EFFORTS);
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    const text = String((await send(r, chat, "/status")).value);
    expect(text).toContain("Cost: unknown · tokens unknown");
    expect(text).toContain("Last reply: cost unknown · tokens unknown");
  });

  test("a run a crash left without an ending entry is not called writing", async () => {
    const r = await rig(() => reply("x"), MODELS, EFFORTS);
    const chat = await r.chat();
    await r.say(chat, "hello");
    // A crash left the run fact and the unanswered message, but no failure or
    // stopped entry; the host says the run is gone.
    await r.store.append({
      type: RUN_FACT,
      object: chatRef(chat),
      cause: "test",
      data: { runId: "run-crashed" },
    });

    const text = String((await send(r, chat, "/status")).value);
    expect(text).toContain("Reply: not writing");
    expect(text).toContain("Waiting: 1 message");
  });

  test("works while a reply is being written and says since when and how many wait", async () => {
    let markStarted: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await rig(async () => {
      markStarted();
      await gate;
      return reply("done");
    }, MODELS, EFFORTS);
    const chat = await r.chat();
    await r.say(chat, "hi");

    const round = r.round(chat);
    await entered;
    const during = String((await send(r, chat, "/status")).value);
    expect(during).toMatch(/Reply: writing since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(during).toContain("Waiting: 1 message");

    release();
    expect((await round).result).toBe("done");
    const after = String((await send(r, chat, "/status")).value);
    expect(after).toContain("Reply: not writing");
    expect(after).toContain("Waiting: 0 messages");
  });
});
