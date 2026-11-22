import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { personStarted } from "@operad-io/access-match";
import { CHAT_TYPE, ENTRY_FACT, allMessages, chatRef, RUN_FACT } from "@operad-io/chat";
import { createViews, type ClientApi, type RunControl, type TriggerEvent } from "@operad-io/engine";
import {
  BotScheduleSource,
  PROPOSAL_TYPE,
  nextRun,
  proposalData,
  scheduledPrompts,
  type ScheduleNotice,
  type ScheduledPrompt,
} from "../src/index.ts";
import {
  lateText,
  SCHEDULE_PREAMBLE,
  SCHEDULE_QUIET_MARKER,
  SCHEDULE_RECENT_COUNT,
  SCHEDULE_RECENT_MAX,
} from "../src/schedule.ts";
import { cleanupRoots, rig } from "./support.ts";

process.env.TZ = "UTC";

afterAll(cleanupRoots);

describe("lateText", () => {
  test("counts hours and the minute left in words, singular or plural", () => {
    expect(lateText(59)).toBe("59 seconds");
    expect(lateText(60)).toBe("1 minute");
    expect(lateText(120)).toBe("2 minutes");
    expect(lateText(3660)).toBe("1 hour 1 minute");
    expect(lateText(3720)).toBe("1 hour 2 minutes");
    expect(lateText(7200)).toBe("2 hours");
  });
});

interface Clock {
  value: number;
}

function sourceFor(
  r: Awaited<ReturnType<typeof rig>>,
  client: ClientApi,
  clock: Clock,
  notices: ScheduleNotice[],
  runs?: RunControl | undefined,
): BotScheduleSource {
  return new BotScheduleSource(
    {
      store: r.store,
      home: r.home,
      settings: {},
      clock: () => clock.value,
      logger: { path: join(r.root, "log"), write: async () => "" },
      client,
      ...(runs === undefined ? {} : { runs }),
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
      expect(chat?.data.accessLevel).toBe("full");
      expect(chat?.data.accessDefault).toBe("full");
      expect(chat?.data.scheduled).toEqual({ bot: "default", entry: "Morning" });
      const chatRow = (await views.get(`chat:${id}`)).row;
      expect(chatRow.data).toMatchObject({ scheduled: { bot: "default", entry: "Morning" } });
      const messages = allMessages(r.store, id);
      expect(messages.map((message) => message.text)).toEqual([`Collect the news.\n\n${SCHEDULE_PREAMBLE}`]);

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
      const botRow = (await views.list("bot")).rows.find((row) => row.id === "default");
      const rowData = botRow?.data as
        | { readonly scheduled?: readonly Readonly<Record<string, unknown>>[] }
        | undefined;
      expect(rowData?.scheduled?.[0]).toMatchObject({ lastResult: "ok", lastChatId: id });
      const page = await views.section("bot:default", "bot", undefined, { full: true });
      expect(page.markdown).toContain("Scheduled:");
      expect(page.markdown).toContain("Morning");
      expect(page.markdown).toContain(`chat ${id}: ok`);
    } finally {
      views.close();
    }
  });

  test("a watch reads a reply after the host says its run ended", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const notices: ScheduleNotice[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, notices, {
      active: (runId) => (runId === "run-crashed" ? false : undefined),
      cancel: () => false,
    });
    try {
      await add(r, { name: "Crashed", schedule: "* * * * *", prompt: "Go." });
      await source.begin();
      clock.value = Date.parse("2026-01-01T00:01:10Z");
      await source.poll();
      const id = (await chats(r))[0];
      if (id === undefined) throw new Error("no chat");
      const first = allMessages(r.store, id)[0];
      if (first === undefined) throw new Error("no message");
      await r.store.append({
        type: RUN_FACT,
        object: chatRef(id),
        cause: "test",
        data: { runId: "run-crashed" },
      });
      await r.say(id, "and more");
      await r.store.append({
        type: "chat.message",
        object: chatRef(id),
        cause: "test",
        data: {
          id: "a-crashed",
          role: "assistant",
          from: { via: "claude", id: "claude" },
          text: "the answer before the crash",
          attachments: [],
          source: { kind: "claude", ref: null },
          replyTo: [first.id],
          runId: "run-crashed",
        },
      });
      await source.settled();
      expect(notices.map((notice) => notice.summary)).toEqual(["the answer before the crash"]);
    } finally {
      views.close();
    }
  });

  test("a reply that goes round again is notified when it ends, not at its first message", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const notices: ScheduleNotice[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, notices);
    try {
      await add(r, { name: "Rounds", schedule: "* * * * *", prompt: "Go." });
      await source.begin();
      clock.value = Date.parse("2026-01-01T00:01:10Z");
      await source.poll();
      const id = (await chats(r))[0];
      if (id === undefined) throw new Error("no chat");
      const first = allMessages(r.store, id)[0];
      if (first === undefined) throw new Error("no message");
      const assistant = async (messageId: string, text: string, replyTo: readonly string[]): Promise<void> => {
        await r.store.append({
          type: "chat.message",
          object: { type: "chat", id },
          cause: "test",
          data: {
            id: messageId,
            role: "assistant",
            from: { via: "claude", id: "claude" },
            text,
            attachments: [],
            source: { kind: "claude", ref: null },
            replyTo,
            runId: "run-x",
          },
        });
      };
      await r.store.append({
        type: "chat.run",
        object: { type: "chat", id },
        cause: "test",
        data: { runId: "run-x" },
      });
      await r.say(id, "and more");
      await assistant("a-1", "first round", [first.id]);
      await source.settled();
      expect(notices).toEqual([]);

      const more = allMessages(r.store, id).find((message) => message.text === "and more");
      if (more === undefined) throw new Error("no second message");
      await assistant("a-2", "second round", [more.id]);
      await source.settled();
      expect(notices.map((notice) => notice.summary)).toEqual(["second round"]);
    } finally {
      views.close();
    }
  });

  test("editing the schedule of a firing that awaits its reply still records its result", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const notices: ScheduleNotice[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, notices);
    try {
      await add(r, { name: "Edited", schedule: "* * * * *", prompt: "Go." });
      await source.begin();
      clock.value = Date.parse("2026-01-01T00:01:10Z");
      await source.poll();
      const id = (await chats(r))[0];
      if (id === undefined) throw new Error("no chat");
      await r.act("bot", "default", "bot/schedule-edit", { name: "Edited", schedule: "*/2 * * * *" });
      clock.value = Date.parse("2026-01-01T00:01:40Z");
      await source.poll();
      await r.reply(id);
      await source.settled();
      expect(notices).toHaveLength(1);
      const bot = await r.store.get("bot", "default");
      const entry = scheduledPrompts(bot?.data ?? {}).find((item) => item.name === "Edited");
      expect(entry?.last).toMatchObject({ chatId: id, result: "ok", notified: true });
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

  test("an edit with an empty model or effort clears it", async () => {
    const r = await rig();
    await add(r, {
      name: "Morning",
      schedule: "0 8 * * *",
      prompt: "At eight.",
      model: "claude-a",
      effort: "claude-high",
    });
    await r.act("bot", "default", "bot/schedule-edit", {
      name: "Morning",
      model: "",
      effort: "",
    });
    expect(
      scheduledPrompts((await r.store.get("bot", "default"))?.data ?? {}),
    ).toEqual([{ name: "Morning", schedule: "0 8 * * *", prompt: "At eight.", paused: false }]);
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

  /** Fires the entry at `at`, answers its chat with `text`, and returns the chat id and the prompt sent. */
  async function fireAndAnswer(
    r: Awaited<ReturnType<typeof rig>>,
    source: BotScheduleSource,
    clock: { value: number },
    at: string,
    text: string,
    n: number,
  ): Promise<{ readonly id: string; readonly prompt: string }> {
    const before = await chats(r);
    clock.value = Date.parse(at);
    await source.poll();
    const id = (await chats(r)).find((item) => !before.includes(item));
    if (id === undefined) throw new Error("no new chat");
    const first = allMessages(r.store, id)[0];
    if (first === undefined) throw new Error("no message");
    await r.store.append({
      type: RUN_FACT,
      object: chatRef(id),
      cause: "test",
      data: { runId: `run-q${n}` },
    });
    await r.store.append({
      type: "chat.message",
      object: chatRef(id),
      cause: "test",
      data: {
        id: `a-q${n}`,
        role: "assistant",
        from: { via: "claude", id: "claude" },
        text,
        attachments: [],
        source: { kind: "claude", ref: null },
        replyTo: [first.id],
        runId: `run-q${n}`,
      },
    });
    await source.settled();
    return { id, prompt: first.text };
  }

  test("a reply that is exactly the marker records its result and runs no notify command; any other reply notifies", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const notices: ScheduleNotice[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, notices);
    try {
      await add(r, { name: "Watch", schedule: "* * * * *", prompt: "Look." });
      await source.begin();
      const quiet = await fireAndAnswer(r, source, clock, "2026-01-01T00:01:10Z", ` ${SCHEDULE_QUIET_MARKER}\n`, 1);
      expect(notices).toEqual([]);
      let entry = scheduledPrompts((await r.store.get("bot", "default"))?.data ?? {})[0];
      expect(entry?.last).toMatchObject({ chatId: quiet.id, result: "Nothing to report.", notified: true });

      // The marker inside a longer reply is not a quiet ending.
      const loud = await fireAndAnswer(r, source, clock, "2026-01-01T00:02:10Z", `${SCHEDULE_QUIET_MARKER} but one thing`, 2);
      expect(notices.map((notice) => notice.chatId)).toEqual([loud.id]);
      entry = scheduledPrompts((await r.store.get("bot", "default"))?.data ?? {})[0];
      expect(entry?.last).toMatchObject({ chatId: loud.id, notified: true });
    } finally {
      views.close();
    }
  });

  test("a failed reply notifies even when the entry could end quietly", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const notices: ScheduleNotice[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, notices);
    try {
      await add(r, { name: "Watch", schedule: "* * * * *", prompt: "Look." });
      await source.begin();
      clock.value = Date.parse("2026-01-01T00:01:10Z");
      await source.poll();
      const id = (await chats(r))[0];
      if (id === undefined) throw new Error("no chat");
      await r.store.append({
        type: RUN_FACT,
        object: chatRef(id),
        cause: "test",
        data: { runId: "run-f" },
      });
      await r.store.append({
        type: ENTRY_FACT,
        object: chatRef(id),
        cause: "test",
        data: { runId: "run-f", kind: "failure", text: "agent crashed" },
      });
      await source.settled();
      expect(notices.map((notice) => notice.summary)).toEqual(["agent crashed"]);
    } finally {
      views.close();
    }
  });

  test("the next firing carries the last few results of the same entry, each cut short", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = sourceFor(r, views as unknown as ClientApi, clock, []);
    try {
      await add(r, { name: "Watch", schedule: "* * * * *", prompt: "Look." });
      await add(r, { name: "Other", schedule: "0 5 * * *", prompt: "Elsewhere." });
      await source.begin();
      const first = await fireAndAnswer(r, source, clock, "2026-01-01T00:01:10Z", "result one", 1);
      expect(first.prompt).not.toContain("Earlier results");
      await fireAndAnswer(r, source, clock, "2026-01-01T00:02:10Z", SCHEDULE_QUIET_MARKER, 2);
      await fireAndAnswer(r, source, clock, "2026-01-01T00:03:10Z", "result three", 3);
      const long = "x".repeat(SCHEDULE_RECENT_MAX + 50);
      await fireAndAnswer(r, source, clock, "2026-01-01T00:04:10Z", long, 4);
      const fifth = await fireAndAnswer(r, source, clock, "2026-01-01T00:05:10Z", "five", 5);
      const lines = fifth.prompt.split("\n").filter((line) => line.startsWith("- "));
      expect(lines).toHaveLength(SCHEDULE_RECENT_COUNT);
      expect(lines[0]).toContain("2026-01-01 00:02: Nothing to report.");
      expect(lines[1]).toContain("result three");
      expect(lines[2]).toContain(`${"x".repeat(SCHEDULE_RECENT_MAX - 1)}…`);
      expect(lines[2]).not.toContain("x".repeat(SCHEDULE_RECENT_MAX));
      expect(fifth.prompt).not.toContain("result one");
      expect(fifth.prompt).toContain(SCHEDULE_PREAMBLE);
      // Another entry's results stay out of this prompt.
      const bot = await r.store.get("bot", "default");
      const other = scheduledPrompts(bot?.data ?? {}).find((item) => item.name === "Other");
      expect(other?.recent).toBeUndefined();
      const watch = scheduledPrompts(bot?.data ?? {}).find((item) => item.name === "Watch");
      expect(watch?.recent).toHaveLength(SCHEDULE_RECENT_COUNT);
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

  test("a bot row carries its scheduled prompts as structured data", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    try {
      await add(r, {
        name: "Morning",
        schedule: "0 8 * * *",
        prompt: "Digest.",
        model: "claude-a",
        effort: "claude-high",
      });
      await add(r, { name: "Paused", schedule: "0 9 * * *", prompt: "Later.", paused: true });
      const row = (await views.list("bot")).rows.find((entry) => entry.id === "default");
      const data = row?.data as
        | { readonly scheduled?: readonly Readonly<Record<string, unknown>>[] }
        | undefined;
      expect(data?.scheduled).toHaveLength(2);
      expect(data?.scheduled?.[0]).toMatchObject({
        name: "Morning",
        schedule: "0 8 * * *",
        prompt: "Digest.",
        model: "claude-a",
        effort: "claude-high",
        paused: false,
        lastResult: null,
        lastChatId: null,
      });
      expect(typeof data?.scheduled?.[0]?.nextRun).toBe("string");
      expect(data?.scheduled?.[1]).toMatchObject({
        name: "Paused",
        model: null,
        effort: null,
        paused: true,
        nextRun: null,
      });
      expect((await views.get("bot:default")).row.data).toEqual(row?.data);
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

describe("schedules a chat proposes", () => {
  const entries = async (r: Awaited<ReturnType<typeof rig>>): Promise<readonly ScheduledPrompt[]> =>
    scheduledPrompts((await r.store.get("bot", "default"))?.data ?? {});

  test("a bot chat starts with the line that a schedule is a proposal", async () => {
    const r = await rig();
    const chat = await r.open("default");
    await r.say(chat, "hello");
    await r.reply(chat);
    const prompt = String(r.calls[0]?.params.prompt ?? "");
    expect(prompt).toContain("plugin `bot`");
    expect(prompt).toContain("verb `schedule`");
    expect(prompt).toContain("Pending");
  });

  test("a chat's add makes a pending proposal and no entry; approve adds it, reject leaves none", async () => {
    const r = await rig();
    const said = await r.command("bot", "schedule", [
      "default",
      "add",
      "Morning",
      "--schedule",
      "0 8 * * *",
      "--words",
      "every morning at 8",
      "--prompt",
      "Collect the news.",
      "--model",
      "claude-a",
      "--effort",
      "claude-low",
    ]);
    expect(String(said)).toContain('proposed scheduled prompt "Morning"');
    expect(await entries(r)).toEqual([]);

    const items = await r.registry.standing();
    expect(items).toHaveLength(1);
    expect(items[0]?.actions).toEqual([
      { plugin: "bot", action: "approve" },
      { plugin: "bot", action: "reject" },
      { plugin: "bot", action: "review" },
    ]);
    const id = items[0]?.object?.id;
    if (id === undefined) throw new Error("no proposal item");
    const proposal = await r.store.get(PROPOSAL_TYPE, id);
    if (proposal === undefined) throw new Error("no proposal");
    expect(proposalData(proposal).kind).toBe("schedule");
    expect(proposalData(proposal).state).toBe("pending");

    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const review = await views.section(`${PROPOSAL_TYPE}:${id}`, "review", undefined, {
        full: true,
      });
      expect(review.markdown).toContain("Scheduled prompt Morning");
      expect(review.markdown).toContain("every morning at 8");
      expect(review.markdown).toContain("0 8 * * *");
      expect(review.markdown).toContain("Collect the news.");
      expect(review.markdown).toContain("claude-a");
      expect(review.markdown).toContain("claude-low");
    } finally {
      views.close();
    }

    await r.act(PROPOSAL_TYPE, id, "bot/reject");
    expect(await entries(r)).toEqual([]);
    expect(await r.registry.standing()).toEqual([]);

    await r.command("bot", "schedule", [
      "default",
      "add",
      "Morning",
      "--schedule",
      "0 8 * * *",
      "--words",
      "every morning at 8",
      "--prompt",
      "Collect the news.",
      "--model",
      "claude-a",
      "--effort",
      "claude-low",
    ]);
    const again = (await r.registry.standing())[0]?.object?.id;
    if (again === undefined) throw new Error("no second proposal item");
    await r.act(PROPOSAL_TYPE, again, "bot/approve");
    expect(await entries(r)).toEqual([
      {
        name: "Morning",
        schedule: "0 8 * * *",
        prompt: "Collect the news.",
        model: "claude-a",
        effort: "claude-low",
        paused: false,
      },
    ]);
    expect(await r.registry.standing()).toEqual([]);
  });

  test("a proposed edit leaves the entry as it is until approve", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await r.command("bot", "schedule", [
      "default",
      "edit",
      "Morning",
      "--schedule",
      "0 9 * * *",
      "--words",
      "every morning at 9",
      "--prompt",
      "At nine.",
    ]);
    expect(await entries(r)).toEqual([
      { name: "Morning", schedule: "0 8 * * *", prompt: "At eight.", paused: false },
    ]);
    const id = (await r.registry.standing())[0]?.object?.id;
    if (id === undefined) throw new Error("no proposal item");
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const review = await views.section(`${PROPOSAL_TYPE}:${id}`, "review", undefined, {
        full: true,
      });
      expect(review.markdown).toContain("### Before");
      expect(review.markdown).toContain("At eight.");
      expect(review.markdown).toContain("### After");
      expect(review.markdown).toContain("every morning at 9");
      expect(review.markdown).toContain("0 9 * * *");
      expect(review.markdown).toContain("At nine.");
    } finally {
      views.close();
    }
    await r.act(PROPOSAL_TYPE, id, "bot/approve");
    expect(await entries(r)).toEqual([
      { name: "Morning", schedule: "0 9 * * *", prompt: "At nine.", paused: false },
    ]);
  });

  test("a proposed edit with an empty model or effort clears it on approve", async () => {
    const r = await rig();
    await add(r, {
      name: "Morning",
      schedule: "0 8 * * *",
      prompt: "At eight.",
      model: "claude-a",
      effort: "claude-high",
    });
    await r.command("bot", "schedule", [
      "default",
      "edit",
      "Morning",
      "--model",
      "",
      "--effort",
      "",
      "--words",
      "every morning at 8",
    ]);
    expect(await entries(r)).toEqual([
      {
        name: "Morning",
        schedule: "0 8 * * *",
        prompt: "At eight.",
        model: "claude-a",
        effort: "claude-high",
        paused: false,
      },
    ]);
    const id = (await r.registry.standing())[0]?.object?.id;
    if (id === undefined) throw new Error("no proposal item");
    await r.act(PROPOSAL_TYPE, id, "bot/approve");
    expect(await entries(r)).toEqual([
      { name: "Morning", schedule: "0 8 * * *", prompt: "At eight.", paused: false },
    ]);
  });

  test("approving an edit keeps a pause made after the proposal and applies only what it changed", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await r.command("bot", "schedule", ["default", "edit", "Morning", "--prompt", "At nine.", "--words", "every morning at 8"]);
    const id = (await r.registry.standing())[0]?.object?.id;
    if (id === undefined) throw new Error("no proposal item");
    await r.act("bot", "default", "bot/schedule-pause", { name: "Morning" });
    await r.act("bot", "default", "bot/schedule-edit", { name: "Morning", schedule: "0 7 * * *" });
    await r.act(PROPOSAL_TYPE, id, "bot/approve");
    expect(await entries(r)).toEqual([
      { name: "Morning", schedule: "0 7 * * *", prompt: "At nine.", paused: true },
    ]);
  });

  test("rejecting a proposed edit or remove leaves the entry unchanged", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    const unchanged = [
      { name: "Morning", schedule: "0 8 * * *", prompt: "At eight.", paused: false },
    ];
    await r.command("bot", "schedule", [
      "default",
      "edit",
      "Morning",
      "--schedule",
      "0 9 * * *",
      "--words",
      "every morning at 9",
    ]);
    const edit = (await r.registry.standing())[0]?.object?.id;
    if (edit === undefined) throw new Error("no edit proposal");
    await r.act(PROPOSAL_TYPE, edit, "bot/reject");
    expect(await entries(r)).toEqual(unchanged);

    await r.command("bot", "schedule", ["default", "remove", "Morning", "--words", "every morning at 8"]);
    const removal = (await r.registry.standing())[0]?.object?.id;
    if (removal === undefined) throw new Error("no remove proposal");
    await r.act(PROPOSAL_TYPE, removal, "bot/reject");
    expect(await entries(r)).toEqual(unchanged);
    expect(await r.registry.standing()).toEqual([]);
  });

  test("a proposed remove deletes the entry only after approve", async () => {
    const r = await rig();
    await add(r, { name: "Gone", schedule: "0 8 * * *", prompt: "Never." });
    await r.command("bot", "schedule", [
      "default",
      "remove",
      "Gone",
      "--words",
      "every morning at 8",
    ]);
    expect(await entries(r)).toHaveLength(1);
    const id = (await r.registry.standing())[0]?.object?.id;
    if (id === undefined) throw new Error("no proposal item");
    await r.act(PROPOSAL_TYPE, id, "bot/approve");
    expect(await entries(r)).toEqual([]);
  });
});

describe("schedules a chat refuses to propose", () => {
  const entries = async (r: Awaited<ReturnType<typeof rig>>): Promise<readonly ScheduledPrompt[]> =>
    scheduledPrompts((await r.store.get("bot", "default"))?.data ?? {});

  async function unchanged(r: Awaited<ReturnType<typeof rig>>): Promise<void> {
    expect(await r.registry.standing()).toEqual([]);
    expect(await entries(r)).toEqual([
      { name: "Morning", schedule: "0 8 * * *", prompt: "At eight.", paused: false },
    ]);
  }

  test("an add of a name the bot already has is refused", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await expect(
      r.command("bot", "schedule", [
        "default",
        "add",
        "Morning",
        "--schedule",
        "0 9 * * *",
        "--words",
        "every morning at 9",
        "--prompt",
        "At nine.",
      ]),
    ).rejects.toThrow('bot default already has a scheduled prompt "Morning"');
    await unchanged(r);
  });

  test("an edit of a missing name is refused", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await expect(
      r.command("bot", "schedule", [
        "default",
        "edit",
        "Evening",
        "--prompt",
        "At nine.",
        "--words",
        "every evening at 9",
      ]),
    ).rejects.toThrow('bot default has no scheduled prompt "Evening"');
    await unchanged(r);
  });

  test("a remove of a missing name is refused", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await expect(
      r.command("bot", "schedule", [
        "default",
        "remove",
        "Evening",
        "--words",
        "every evening at 9",
      ]),
    ).rejects.toThrow('bot default has no scheduled prompt "Evening"');
    await unchanged(r);
  });

  test("an add without the schedule in words is refused", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await expect(
      r.command("bot", "schedule", [
        "default",
        "add",
        "Evening",
        "--schedule",
        "0 21 * * *",
        "--prompt",
        "At nine.",
      ]),
    ).rejects.toThrow("give the schedule in words with --words");
    await unchanged(r);
  });

  test("a malformed cron expression is refused", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await expect(
      r.command("bot", "schedule", [
        "default",
        "add",
        "Evening",
        "--schedule",
        "every evening",
        "--words",
        "every evening at 9",
        "--prompt",
        "At nine.",
      ]),
    ).rejects.toThrow();
    await unchanged(r);
  });

  test("an edit with nothing to change is refused", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await expect(
      r.command("bot", "schedule", [
        "default",
        "edit",
        "Morning",
        "--words",
        "every morning at 8",
      ]),
    ).rejects.toThrow("editing a scheduled prompt needs a field to change");
    await unchanged(r);
  });

  test("a remove that carries other fields is refused", async () => {
    const r = await rig();
    await add(r, { name: "Morning", schedule: "0 8 * * *", prompt: "At eight." });
    await expect(
      r.command("bot", "schedule", [
        "default",
        "remove",
        "Morning",
        "--words",
        "every morning at 8",
        "--prompt",
        "At nine.",
      ]),
    ).rejects.toThrow("removing a scheduled prompt takes only its name");
    await unchanged(r);
  });
});
