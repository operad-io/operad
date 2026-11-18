import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { personStarted } from "@operad-io/access-match";
import { CHAT_TYPE, allMessages } from "@operad-io/chat";
import { createViews, type ClientApi, type TriggerEvent } from "@operad-io/engine";
import {
  BotScheduleSource,
  nextRun,
  scheduledPrompts,
  type ScheduleNotice,
  type ScheduledPrompt,
} from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

process.env.TZ = "UTC";

afterAll(cleanupRoots);

interface Clock {
  value: number;
}

function sourceFor(
  r: Awaited<ReturnType<typeof rig>>,
  client: ClientApi,
  clock: Clock,
  notices: ScheduleNotice[],
): BotScheduleSource {
  return new BotScheduleSource(
    {
      store: r.store,
      home: r.home,
      settings: {},
      clock: () => clock.value,
      logger: { path: join(r.root, "log"), write: async () => "" },
      client,
    },
    {
      notify: async (notice) => {
        notices.push(notice);
      },
    },
  );
}

async function chats(r: Awaited<ReturnType<typeof rig>>): Promise<readonly string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await r.store.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.objects.map((object) => object.id));
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

async function add(
  r: Awaited<ReturnType<typeof rig>>,
  args: Record<string, unknown>,
): Promise<void> {
  await r.act("bot", "default", "bot/schedule-add", args);
}

describe("scheduled prompts", () => {
  test("an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary", async () => {
    const events: TriggerEvent[] = [];
    const r = await rig({}, ["claude", "pi"], (event) => events.push(event));
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const notices: ScheduleNotice[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, notices);
    try {
      await add(r, { name: "Morning", schedule: "* * * * *", prompt: "Collect the news." });
      await source.begin();
      expect(await chats(r)).toHaveLength(0);

      clock.value = Date.parse("2026-01-01T00:01:10Z");
      await source.poll();
      const opened = await chats(r);
      expect(opened).toHaveLength(1);
      const id = opened[0];
      if (id === undefined) throw new Error("no chat");
      const chat = await r.store.get(CHAT_TYPE, id);
      expect(chat?.data.parent).toBe("bot:default");
      expect(chat?.data.title).toBe("Morning (2026-01-01)");
      const messages = allMessages(r.store, id);
      expect(messages.map((message) => message.text)).toEqual(["Collect the news."]);

      const event = events.find((item) => item.source === "bot" && item.type === "message");
      expect(event?.object).toBe(`chat:${id}`);
      expect(personStarted(event)).toBe(false);

      // Answer the scheduled prompt as the fake agent does.
      await r.reply(id);
      await source.settled();
      expect(notices).toEqual([{ chatId: id, title: "Morning (2026-01-01)", summary: "ok" }]);
      const bot = await r.store.get("bot", "default");
      const entry = scheduledPrompts(bot?.data ?? {}).find((item) => item.name === "Morning");
      expect(entry?.last).toMatchObject({ chatId: id, result: "ok", notified: true });
      const page = await views.section("bot:default", "bot", undefined, { full: true });
      expect(page.markdown).toContain("Scheduled:");
      expect(page.markdown).toContain("Morning");
      expect(page.markdown).toContain(`chat ${id}: ok`);
    } finally {
      views.close();
    }
  });

  test("two firings make two chats", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, []);
    try {
      await add(r, { name: "Every minute", schedule: "* * * * *", prompt: "Tick." });
      await source.begin();
      clock.value = Date.parse("2026-01-01T00:01:10Z");
      await source.poll();
      clock.value = Date.parse("2026-01-01T00:02:10Z");
      await source.poll();
      expect(await chats(r)).toHaveLength(2);
    } finally {
      views.close();
    }
  });

  test("a paused entry does not fire", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, []);
    try {
      await add(r, { name: "Paused", schedule: "* * * * *", prompt: "Not now.", paused: true });
      await source.begin();
      clock.value = Date.parse("2026-01-01T00:05:10Z");
      await source.poll();
      expect(await chats(r)).toHaveLength(0);
    } finally {
      views.close();
    }
  });

  test("edit changes the next run", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.parse("2026-01-01T07:00:10Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, []);
    try {
      await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
      await source.begin();
      clock.value = Date.parse("2026-01-01T07:30:10Z");
      await r.act("bot", "default", "bot/schedule-edit", { name: "Morning", schedule: "0 9 * * *" });
      await source.poll();
      clock.value = Date.parse("2026-01-01T08:00:10Z");
      await source.poll();
      expect(await chats(r)).toHaveLength(0);
      clock.value = Date.parse("2026-01-01T09:00:10Z");
      await source.poll();
      expect(await chats(r)).toHaveLength(1);
    } finally {
      views.close();
    }
  });

  test("remove stops it", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, []);
    try {
      await add(r, { name: "Gone", schedule: "* * * * *", prompt: "Never." });
      await source.begin();
      await r.act("bot", "default", "bot/schedule-remove", { name: "Gone" });
      clock.value = Date.parse("2026-01-01T00:02:10Z");
      await source.poll();
      expect(await chats(r)).toHaveLength(0);
    } finally {
      views.close();
    }
  });

  test("a catch-up firing adds the planned time and how late it is to the prompt", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.parse("2026-01-01T07:00:10Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, []);
    try {
      await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "Digest." });
      await source.begin();
      clock.value = Date.parse("2026-01-01T08:05:10Z");
      await source.poll();
      const opened = await chats(r);
      expect(opened).toHaveLength(1);
      const id = opened[0];
      if (id === undefined) throw new Error("no chat");
      const text = allMessages(r.store, id)[0]?.text ?? "";
      expect(text).toContain("Digest.");
      expect(text).toContain("Scheduled for 2026-01-01 08:00");
      expect(text).toContain("5 minutes late");
    } finally {
      views.close();
    }
  });

  test("the view shows next run time and the last result and chat id; edit, pause, resume and remove are actions", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    try {
      await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "Digest." });
      const actions = (await views.get("bot:default")).actions.map((action) => action.name);
      expect(actions).toEqual(expect.arrayContaining([
        "bot:schedule-add",
        "bot:schedule-edit",
        "bot:schedule-pause",
        "bot:schedule-resume",
        "bot:schedule-remove",
      ]));
      await r.act("bot", "default", "bot/schedule-pause", { name: "Morning" });
      let entry = scheduledPrompts((await r.store.get("bot", "default"))?.data ?? {})[0];
      expect(entry?.paused).toBe(true);
      await r.act("bot", "default", "bot/schedule-resume", { name: "Morning" });
      entry = scheduledPrompts((await r.store.get("bot", "default"))?.data ?? {})[0];
      expect(entry?.paused).toBe(false);
      if (entry === undefined) throw new Error("no entry");
      expect(nextRun(entry, Date.parse("2026-01-01T07:00:10Z"))).toBe(Date.parse("2026-01-01T08:00:00Z"));
      const page = await views.section("bot:default", "bot", undefined, { full: true });
      expect(page.markdown).toContain("Morning (0 8 * * *");
      expect(page.markdown).toContain("next ");
    } finally {
      views.close();
    }
  });
});
