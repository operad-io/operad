import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { personStarted } from "@operad-io/access-match";
import { CHAT_TYPE, allMessages } from "@operad-io/chat";
import { createViews, type ClientApi, type TriggerEvent } from "@operad-io/engine";
import {
  BotScheduleSource,
  FOLLOW_UP_DAYS,
  FOLLOW_UP_PER_CHAT,
  followUps,
  parseDue,
  setFollowUp,
} from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

process.env.TZ = "UTC";

afterAll(cleanupRoots);

const NOW = Date.parse("2026-01-01T00:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Rig = Awaited<ReturnType<typeof rig>>;

function sourceFor(r: Rig, views: unknown, clock: { value: number }, events: TriggerEvent[]): BotScheduleSource {
  return new BotScheduleSource({
    store: r.store,
    home: r.home,
    settings: {},
    clock: () => clock.value,
    logger: { path: join(r.root, "log"), write: async () => "" },
    client: views as ClientApi,
    facts: { append: (fact) => r.store.append({ ...fact, cause: "test" }) },
    emit: async (event) => {
      events.push({ ...event, hops: 0 } as unknown as TriggerEvent);
    },
  });
}

async function pending(r: Rig) {
  return followUps((await r.store.get("bot", "default"))?.data ?? {});
}

describe("follow-up time", () => {
  test("a relative and an absolute time are understood; anything else is refused", () => {
    expect(parseDue("+30m", NOW)).toBe(NOW + 30 * 60_000);
    expect(parseDue("+2h", NOW)).toBe(NOW + 2 * HOUR);
    expect(parseDue("in 3 days", NOW)).toBe(NOW + 3 * DAY);
    expect(parseDue("2026-01-05 09:30", NOW)).toBe(Date.parse("2026-01-05T09:30:00Z"));
    expect(parseDue("2026-01-05T09:30:00+02:00", NOW)).toBe(Date.parse("2026-01-05T07:30:00Z"));
    expect(() => parseDue("2026-02-30 09:00", NOW)).toThrow("not understood");
    expect(() => parseDue("sometime", NOW)).toThrow("not understood");
  });
});

describe("setting a follow-up", () => {
  test("the command takes effect at once, with no proposal, and the page and row show it", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    try {
      const chat = await r.open("default");
      const line = await r.command("bot", "follow-up", [chat, "--at", "+2h", "--do", "Check the build."]);
      expect(String(line)).toMatch(/^follow-up F-[0-9a-f]{8} set for /);
      const [entry] = await pending(r);
      expect(entry).toMatchObject({ chat, text: "Check the build." });
      expect((await r.store.list("bot-proposal")).objects).toHaveLength(0);
      const row = (await views.list("bot")).rows.find((item) => item.id === "default");
      const data = row?.data as { readonly followUps?: readonly Record<string, unknown>[] } | undefined;
      expect(data?.followUps?.[0]).toMatchObject({ id: entry?.id, chatId: chat, text: "Check the build." });
      expect(typeof data?.followUps?.[0]?.due).toBe("string");
      const page = await views.section("bot:default", "bot", undefined, { full: true });
      expect(page.markdown).toContain(`${entry?.id}`);
      expect(page.markdown).toContain("Check the build.");
      // A sync of the bot's settings keeps the follow-ups.
      await views.list("bot");
      expect(await pending(r)).toHaveLength(1);
    } finally {
      views.close();
    }
  });

  test("the chat's first-session line names the chat and the command", async () => {
    const r = await rig();
    const chat = await r.open("default");
    const object = await r.store.get(CHAT_TYPE, chat);
    const result = await r.registry.runStep("bot/settings", { chat }, {
      runId: "run-x",
      object: { type: CHAT_TYPE, id: chat, data: object?.data ?? {} },
      params: { chat },
    });
    const context = (result as { readonly data?: { readonly context?: { readonly text?: string } } }).data?.context?.text;
    expect(context).toContain(`chat ${chat}`);
    expect(context).toContain("`follow-up`");
  });

  test("at most 5 not yet due per chat, at most 30 days ahead, and no time already past; each refusal says which", async () => {
    const r = await rig();
    const chat = await r.open("default");
    const other = await r.open("default");
    for (let n = 1; n <= FOLLOW_UP_PER_CHAT; n += 1) await setFollowUp(r.store, chat, `+${n}h`, `Step ${n}.`, NOW);
    await expect(setFollowUp(r.store, chat, "+6h", "One more.", NOW)).rejects.toThrow(
      `already has ${FOLLOW_UP_PER_CHAT} follow-ups not yet due`,
    );
    // Another chat has its own count, and a due one no longer counts.
    await setFollowUp(r.store, other, "+1h", "Elsewhere.", NOW);
    await setFollowUp(r.store, chat, "+1h", "After the first is due.", NOW + 90 * 60_000);
    await expect(setFollowUp(r.store, other, `+${FOLLOW_UP_DAYS + 1}d`, "Too far.", NOW)).rejects.toThrow(
      `at most ${FOLLOW_UP_DAYS} days ahead`,
    );
    await setFollowUp(r.store, other, `+${FOLLOW_UP_DAYS}d`, "Just in range.", NOW);
    await expect(setFollowUp(r.store, other, "2025-12-31 00:00", "Past.", NOW)).rejects.toThrow("already past");
    await expect(setFollowUp(r.store, "C-9999", "+1h", "No chat.", NOW)).rejects.toThrow("there is no chat");
  });

  test("a closed chat takes no follow-up", async () => {
    const r = await rig();
    const chat = await r.open("default");
    await r.act("chat", chat, "chat/close");
    await expect(setFollowUp(r.store, chat, "+1h", "Never.", NOW)).rejects.toThrow("is closed");
  });
});

describe("listing and canceling", () => {
  test("the agent lists and cancels its chat's follow-ups, a person cancels any with the action", async () => {
    const r = await rig();
    const chat = await r.open("default");
    const other = await r.open("default");
    await setFollowUp(r.store, chat, "+1h", "First.", Date.now());
    await setFollowUp(r.store, chat, "+2h", "Second.", Date.now());
    await setFollowUp(r.store, other, "+3h", "Other chat.", Date.now());
    const [first, second] = await pending(r);
    if (first === undefined || second === undefined) throw new Error("no follow-ups");
    const listed = String(await r.command("bot", "follow-ups", [chat]));
    expect(listed).toContain("First.");
    expect(listed).toContain("Second.");
    expect(listed).not.toContain("Other chat.");
    await r.command("bot", "follow-ups", [chat, "--cancel", first.id]);
    expect((await pending(r)).map((entry) => entry.text)).toEqual(["Second.", "Other chat."]);
    // The agent cannot cancel another chat's follow-up.
    const foreign = (await pending(r))[1];
    await expect(r.command("bot", "follow-ups", [chat, "--cancel", foreign?.id ?? ""])).rejects.toThrow("has no follow-up");
    await r.act("bot", "default", "bot/follow-up-cancel", { id: second.id });
    expect((await pending(r)).map((entry) => entry.text)).toEqual(["Other chat."]);
    await expect(r.act("bot", "default", "bot/follow-up-cancel", { id: second.id })).rejects.toThrow("no follow-up");
  });
});

describe("a due follow-up", () => {
  test("is sent into the same chat as a background message from the bot source, once, and not before it is due", async () => {
    const events: TriggerEvent[] = [];
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.now() };
    const source = sourceFor(r, views, clock, events);
    try {
      const chat = await r.open("default");
      await setFollowUp(r.store, chat, "+2h", "Check the build.", clock.value);
      await source.begin();
      clock.value += HOUR;
      await source.poll();
      expect(allMessages(r.store, chat)).toHaveLength(0);
      expect(await pending(r)).toHaveLength(1);

      clock.value += HOUR + 5_000;
      await source.poll();
      await source.poll();
      const messages = allMessages(r.store, chat);
      expect(messages.map((message) => message.text)).toEqual(["Follow-up you set for yourself: Check the build."]);
      expect(await pending(r)).toHaveLength(0);
      const event = events.find((item) => item.source === "bot" && item.type === "message");
      expect(event?.object).toBe(`chat:${chat}`);
      expect(personStarted(event)).toBe(false);
      expect(events.filter((item) => item.source === "bot")).toHaveLength(1);
    } finally {
      views.close();
    }
  });

  test("one that is long overdue says when it was set for and how late it is", async () => {
    const events: TriggerEvent[] = [];
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.now() };
    try {
      const chat = await r.open("default");
      await setFollowUp(r.store, chat, "+1h", "Check the build.", clock.value);
      const due = (await pending(r))[0]?.at ?? 0;
      clock.value = due + 3 * HOUR;
      const source = sourceFor(r, views, clock, events);
      await source.begin();
      const [message] = allMessages(r.store, chat);
      expect(message?.text).toContain("Check the build.");
      expect(message?.text).toContain("this run is 3 hours late");
      expect(message?.text).toContain("Scheduled for ");
    } finally {
      views.close();
    }
  });

  test("a closed chat drops it without a message", async () => {
    const events: TriggerEvent[] = [];
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.now() };
    try {
      const chat = await r.open("default");
      await setFollowUp(r.store, chat, "+1h", "Never.", clock.value);
      await r.act("chat", chat, "chat/close");
      clock.value += 2 * HOUR;
      const source = sourceFor(r, views, clock, events);
      await source.begin();
      expect(allMessages(r.store, chat)).toHaveLength(0);
      expect(await pending(r)).toHaveLength(0);
      expect(events).toHaveLength(0);
    } finally {
      views.close();
    }
  });

  test("survives a restart: a process that set it is killed, and the next one sends it once, late", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "follow-up-child.ts")],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    let line = "";
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      while (!line.includes("\n")) {
        const next = await reader.read();
        if (next.done === true) throw new Error("the child ended before it set the follow-up");
        line += decoder.decode(next.value, { stream: true });
      }
      child.kill("SIGKILL");
      await child.exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    const [root = "", chat = ""] = line.split(" ");
    const events: TriggerEvent[] = [];
    const r = await rig({}, ["claude", "pi"], undefined, [], { sqlite: true, root });
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    try {
      const kept = await pending(r);
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ chat, text: "Check the build." });
      const clock = { value: (kept[0]?.at ?? 0) + 30 * 60_000 };
      const source = sourceFor(r, views, clock, events);
      await source.begin();
      await source.poll();
      const messages = allMessages(r.store, chat);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toContain("this run is 30 minutes late");
      expect(await pending(r)).toHaveLength(0);
    } finally {
      views.close();
    }
  });
});
