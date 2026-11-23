import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_TYPE, allMessages, chatRef, RUN_FACT, STOP_FACT } from "@operad-io/chat";
import { createViews, type ClientApi, type JsonValue, type ObjectStore, type RunControl } from "@operad-io/engine";
import { EMPTY_LINK_REPORT, TIDY_ORIGIN, createMemoryPlugin, ensureRepository, lastTidyCommit, memoryGit, tidyCommitForChat } from "@operad-io/memory";
import {
  BotTidySource,
  TIDY_TYPE,
  tidyDataOf,
  tidyOutcomeLine,
  tidyPrompt,
  tidyWork,
  type ScheduleNotice,
  type TidyWork,
} from "../src/index.ts";
import { cleanupRoots, rig, writePlugins } from "./support.ts";

process.env.TZ = "UTC";

afterAll(cleanupRoots);

interface Clock {
  value: number;
}

interface SetupOptions {
  readonly client?: ClientApi | undefined;
  readonly work?: ((store: ObjectStore, bot: string, cwd: string) => Promise<TidyWork>) | undefined;
  readonly prepare?: ((memory: string) => void) | undefined;
  readonly runs?: RunControl | undefined;
  readonly harnesses?: readonly string[] | undefined;
}

async function setup(
  bots: Readonly<Record<string, JsonValue>> = { default: { tidyTime: "03:30" } },
  clockAt = "2026-01-01T02:00:00Z",
  capabilities: (harness: string) => { readonly backgroundModel?: string; readonly accessLevels?: readonly string[] } = () => ({}),
  options: SetupOptions = {},
) {
  const r = await rig({ default: {} }, [...(options.harnesses ?? ["pi"])], undefined, [createMemoryPlugin()]);
  writePlugins(r.home, { memory: {}, bot: { settings: { bots } } });
  const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
  const clock: Clock = { value: Date.parse(clockAt) };
  const notices: ScheduleNotice[] = [];
  const memory = join(r.home, "bot", "default", "memory");
  options.prepare?.(memory);
  const source = new BotTidySource(
    {
      store: r.store,
      home: r.home,
      settings: { bots },
      clock: () => clock.value,
      logger: { write: async () => "" },
      client: options.client ?? (views as unknown as ClientApi),
      harnesses: options.harnesses ?? ["pi"],
      harnessCapabilities: capabilities,
      ...(options.work === undefined ? {} : { work: options.work }),
      ...(options.runs === undefined ? {} : { runs: options.runs }),
    },
    {
      notify: async (notice) => {
        notices.push(notice);
      },
    },
  );
  await source.begin();
  return { r, views, clock, notices, source, memory };
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

async function tidy(r: Awaited<ReturnType<typeof rig>>) {
  const object = await r.store.get(TIDY_TYPE, "default");
  return object === undefined ? undefined : tidyDataOf(object.data);
}

function note(memory: string, name: string, text: string): void {
  mkdirSync(join(memory, "topics"), { recursive: true });
  writeFileSync(join(memory, "topics", name), text);
}

function commitMemory(memory: string, message: string): void {
  ensureRepository(memory);
  const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
  expect(memoryGit(memory, [...identity, "add", "-A"]).ok).toBe(true);
  expect(memoryGit(memory, [...identity, "commit", "--allow-empty", "--no-verify", "-m", message]).ok).toBe(true);
}

async function failChat(r: Awaited<ReturnType<typeof rig>>, chat: string): Promise<void> {
  await r.store.append({
    type: "chat.entry",
    object: { type: CHAT_TYPE, id: chat },
    cause: "test",
    data: { runId: "run-failed", kind: "failure", text: "The reply failed: quota" },
  });
  await r.store.append({
    type: "memory.tidy",
    object: { type: CHAT_TYPE, id: chat },
    cause: "test",
    data: { chat, ok: false },
  });
}

function noteWork(): TidyWork {
  return {
    notes: [{ path: "topics/tea.md", content: "likes tea\n", date: "2026-07-03" }],
    chats: [],
    links: { wiki: EMPTY_LINK_REPORT, memory: EMPTY_LINK_REPORT },
    indexOver: false,
    indexBytes: 0,
    baseline: undefined,
    today: "2026-11-23",
  };
}

describe("the nightly memory check", () => {
  test("a night with no work ends at no cost, with no chat and no card", async () => {
    const s = await setup();
    try {
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      expect(await tidy(s.r)).toMatchObject({ state: "idle", counts: { notes: 0, chats: 0 } });
      expect(await chats(s.r)).toEqual([]);
      expect(await s.r.registry.standing()).toEqual([]);
    } finally {
      s.views.close();
    }
  });

  test("a night with work sends one card, and the next check updates the same card's counts", async () => {
    const s = await setup();
    try {
      note(s.memory, "tea.md", "likes tea\n");
      const chat = await s.r.open("default");
      await s.r.say(chat, "remember the tea");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();

      let data = await tidy(s.r);
      expect(data).toMatchObject({ state: "pending", counts: { notes: 1, chats: 1 } });
      const items = await s.r.registry.standing();
      expect(items).toHaveLength(1);
      expect(items[0]?.actions).toEqual([
        { plugin: "bot", action: "run" },
        { plugin: "bot", action: "skip" },
      ]);
      expect(items[0]?.prompt).toContain("1 new or changed note, 1 chat to check");

      note(s.memory, "coffee.md", "likes coffee\n");
      const second = await s.r.open("default");
      await s.r.say(second, "remember the coffee");
      s.clock.value = Date.parse("2026-01-02T03:31:00Z");
      await s.source.poll();

      data = await tidy(s.r);
      expect(data).toMatchObject({ state: "pending", counts: { notes: 2, chats: 2 } });
      const objects = await s.r.store.list(TIDY_TYPE);
      expect(objects.objects).toHaveLength(1);
      expect((await s.r.registry.standing())[0]?.prompt).toContain("2 new or changed notes, 2 chats to check");
    } finally {
      s.views.close();
    }
  });

  test("a missed night is caught up once, not once for every night", async () => {
    const s = await setup({ default: { tidyTime: "03:30", runWithoutAsking: true } });
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-04T05:00:00Z");
      await s.source.poll();
      expect(await chats(s.r)).toHaveLength(1);
      expect((await tidy(s.r))?.plannedAt).toBe(Date.parse("2026-01-04T03:30:00Z"));
      await s.source.poll();
      expect(await chats(s.r)).toHaveLength(1);
    } finally {
      s.views.close();
    }
  });
});

  test("the first check only sets a baseline", async () => {
    const s = await setup(
      { default: { tidyTime: "03:30" } },
      "2026-01-01T03:31:00Z",
      () => ({}),
      { prepare: (memory) => note(memory, "tea.md", "likes tea\n") },
    );
    try {
      expect(await chats(s.r)).toEqual([]);
      expect(await s.r.registry.standing()).toEqual([]);
      expect((await tidy(s.r))?.state).toBe("idle");

      s.clock.value = Date.parse("2026-01-02T03:31:00Z");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("pending");
    } finally {
      s.views.close();
    }
  });

  test("a tidy's own chat is not counted as work for the next check", async () => {
    const s = await setup();
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      await s.r.act(TIDY_TYPE, "default", "bot/run");
      await s.source.poll();
      const id = (await chats(s.r))[0];
      if (id === undefined) throw new Error("no tidy chat");
      await s.r.reply(id);
      await s.source.settled();
      await s.r.say(id, "a later message in the tidy chat");

      note(s.memory, "coffee.md", "likes coffee\n");
      s.clock.value = Date.parse("2026-01-02T03:31:00Z");
      await s.source.poll();
      const data = await tidy(s.r);
      expect(data).toMatchObject({ state: "pending", counts: { notes: 1, chats: 0 } });
    } finally {
      s.views.close();
    }
  });

  test("a running card with no chat is reported failed when the source resumes", async () => {
    const s = await setup();
    try {
      const before = await tidy(s.r);
      if (before === undefined) throw new Error("no tidy state");
      await s.r.store.put(
        TIDY_TYPE,
        "default",
        { ...before, state: "running", auto: false },
        "test",
      );
      await s.source.begin();
      expect((await tidy(s.r))?.state).toBe("failed");
      expect((await s.r.registry.standing())[0]?.prompt).toContain("failed");
    } finally {
      s.views.close();
    }
  });

  test("a launch that opens no chat leaves a failed card, not a running one", async () => {
    const client = { act: async () => ({}) } as unknown as ClientApi;
    const s = await setup(undefined, undefined, undefined, { client });
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      await s.r.act(TIDY_TYPE, "default", "bot/run");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("failed");
      expect((await s.r.registry.standing())[0]?.prompt).toContain("started no run");
    } finally {
      s.views.close();
    }
  });

describe("dates in the tidy prompt", () => {
  test("the prompt names today, each note's date, and the rules for dating facts", () => {
    const prompt = tidyPrompt("default", noteWork());
    expect(prompt).toContain("Today is 2026-11-23.");
    expect(prompt).toContain("### topics/tea.md (changed 2026-07-03)");
    expect(prompt).toContain("using the note's date");
    expect(prompt).toContain("Went to Singapore in July 2026");
    expect(prompt).toContain("until YYYY-MM-DD");
    expect(prompt).toContain("marked as replaced with the date");
    expect(prompt).toContain("never delete it");
    expect(prompt).toContain("Do not change instructions.md");
  });

  test("the work takes today from the injected clock and a note's date from its file", async () => {
    const s = await setup();
    try {
      note(s.memory, "trip.md", "Going to Singapore next week\n");
      const stamp = new Date("2026-07-03T12:00:00");
      utimesSync(join(s.memory, "topics", "trip.md"), stamp, stamp);
      const work = await tidyWork(s.r.store, "default", join(s.r.home, "bot", "default"), {
        home: s.r.home,
        now: new Date("2026-11-23T03:30:00").getTime(),
      });
      expect(work.today).toBe("2026-11-23");
      expect(work.notes.find((n) => n.path === "topics/trip.md")?.date).toBe("2026-07-03");
      expect(tidyPrompt("default", work)).toContain("### topics/trip.md (changed 2026-07-03)");
    } finally {
      s.views.close();
    }
  });
});

describe("the link lists in the tidy prompt", () => {
  test("a list with something to look at is in the prompt, and empty lists add nothing", () => {
    const report = {
      broken: [{ path: "notes/a.md", line: 4, target: "notes/missing" }],
      orphans: ["notes/c.md"],
      wanted: [{ target: "notes/wanted", notes: 3 }],
      unlinked: [{ path: "notes/d.md", title: "Alpha", target: "notes/a.md" }],
    };
    const prompt = tidyPrompt("default", {
      ...noteWork(),
      links: { wiki: report, memory: EMPTY_LINK_REPORT },
    });
    expect(prompt).toContain("## Links to look after");
    expect(prompt).toContain("Fix a broken link when the right target is clear");
    expect(prompt).toContain("### Wiki");
    expect(prompt).toContain("notes/a.md:4 -> notes/missing");
    expect(prompt).toContain("notes/c.md");
    expect(prompt).toContain("notes/wanted (linked from 3 notes)");
    expect(prompt).toContain('notes/d.md mentions "Alpha" (notes/a.md)');
    expect(prompt).not.toContain("### Bot memory");

    const empty = tidyPrompt("default", noteWork());
    expect(empty).not.toContain("Links to look after");
    expect(empty).not.toContain("Broken links");
  });

  test("the check reads the wiki and this bot's memory from the link table", async () => {
    const s = await setup();
    try {
      mkdirSync(join(s.r.home, "wiki", "notes"), { recursive: true });
      writeFileSync(join(s.r.home, "wiki", "notes", "a.md"), "# Alpha\n\n[[missing]]\n");
      note(s.memory, "tea.md", "# Tea\n\n[[nowhere]]\n");

      const work = await tidyWork(s.r.store, "default", join(s.r.home, "bot", "default"), {
        home: s.r.home,
      });
      expect(work.links.wiki.broken).toEqual([
        { path: "notes/a.md", line: 3, target: "missing" },
      ]);
      expect(work.links.memory.broken).toEqual([
        { path: "topics/tea.md", line: 3, target: "nowhere" },
      ]);
      const prompt = tidyPrompt("default", work);
      expect(prompt).toContain("## Links to look after");
      expect(prompt).toContain("notes/a.md:3 -> missing");
      expect(prompt).toContain("topics/tea.md:3 -> nowhere");
    } finally {
      s.views.close();
    }
  });

  test("the memory lists stay with this bot's memory", async () => {
    const s = await setup();
    try {
      mkdirSync(join(s.r.home, "bot", "other", "memory", "topics"), { recursive: true });
      writeFileSync(
        join(s.r.home, "bot", "other", "memory", "topics", "other.md"),
        "# Other\n\n[[other-missing]]\n",
      );
      note(s.memory, "tea.md", "# Tea\n\n[[nowhere]]\n");

      const work = await tidyWork(s.r.store, "default", join(s.r.home, "bot", "default"), {
        home: s.r.home,
      });
      expect(work.links.memory.broken.map((link) => link.path)).toEqual(["topics/tea.md"]);
    } finally {
      s.views.close();
    }
  });

  test("a link table that cannot be opened leaves empty lists instead of failing the check", async () => {
    const s = await setup();
    try {
      mkdirSync(join(s.r.home, "store", "search.sqlite"), { recursive: true });
      note(s.memory, "tea.md", "# Tea\n\n[[nowhere]]\n");

      const work = await tidyWork(s.r.store, "default", join(s.r.home, "bot", "default"), {
        home: s.r.home,
      });
      expect(work.notes).toHaveLength(1);
      expect(work.links).toEqual({ wiki: EMPTY_LINK_REPORT, memory: EMPTY_LINK_REPORT });
    } finally {
      s.views.close();
    }
  });

  test("a check with no home reads no link table", async () => {
    const s = await setup();
    try {
      note(s.memory, "tea.md", "# Tea\n\n[[nowhere]]\n");

      const work = await tidyWork(s.r.store, "default", join(s.r.home, "bot", "default"));
      expect(work.links).toEqual({ wiki: EMPTY_LINK_REPORT, memory: EMPTY_LINK_REPORT });
    } finally {
      s.views.close();
    }
  });
});

describe("Run and Skip", () => {
  test("Skip closes a pending card until the next check finds work", async () => {
    const s = await setup();
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("pending");

      await s.r.act(TIDY_TYPE, "default", "bot/skip");
      expect((await tidy(s.r))?.state).toBe("skipped");
      expect(await s.r.registry.standing()).toEqual([]);

      note(s.memory, "coffee.md", "likes coffee\n");
      s.clock.value = Date.parse("2026-01-02T03:31:00Z");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("pending");
    } finally {
      s.views.close();
    }
  });

  test("Run starts the tidy after no chat is replying and leaves no pending item when it finishes", async () => {
    const s = await setup();
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("pending");

      await s.r.act(TIDY_TYPE, "default", "bot/run");
      expect((await tidy(s.r))?.state).toBe("requested");
      await s.source.poll();
      const opened = await chats(s.r);
      expect(opened).toHaveLength(1);
      const id = opened[0];
      if (id === undefined) throw new Error("no tidy chat");
      expect((await s.r.store.get(CHAT_TYPE, id))?.data.scheduled).toEqual({
        bot: "default",
        entry: TIDY_ORIGIN,
      });
      expect((await tidy(s.r))?.state).toBe("running");
      // The tidy never changes the person's instructions: the file is read-only while it runs.
      expect(statSync(join(s.memory, "instructions.md")).mode & 0o222).toBe(0);

      await s.r.reply(id);
      await s.source.settled();
      expect((await tidy(s.r))?.state).toBe("result");
      expect(await s.r.registry.standing()).toEqual([]);
      expect(s.notices).toHaveLength(1);
      expect(s.notices[0]?.summary).toContain("default:");
      expect(s.notices[0]?.summary).toContain("cost unknown");
      expect(s.notices[0]?.summary).not.toContain("ok");
      // The run is not a chat; Dreaming is a routine with the run in its history.
      expect(id.startsWith("R-")).toBe(true);
      expect(s.notices[0]).toMatchObject({ routineId: "dreaming-default", runId: id, title: "Dreaming" });
      const row = (await s.views.list("bot-routine")).rows.find((item) => item.id === "dreaming-default");
      expect(row).toMatchObject({ title: "Dreaming", parent: "bot:default", state: "open" });
      expect(row?.data).toMatchObject({ builtin: true, bot: "default", schedule: "30 3 * * *", lastResult: "done" });
      const detail = await s.views.get("bot-routine:dreaming-default");
      expect(detail.sections.map((section) => section.id)).toEqual(["routine", `run-${id}`, "history"]);
      expect((await s.views.section("bot-routine:dreaming-default", "routine", undefined, { full: true })).markdown).toContain("Run or Skip");
      // It is built in: no action edits or removes it.
      expect(detail.actions.map((action) => action.name)).not.toContain("bot:remove");
    } finally {
      s.views.close();
    }
  });

  test("a finished run's full result stays in the tidy object's own section", async () => {
    const s = await setup();
    try {
      commitMemory(s.memory, "memory: bot default, chat C-0");
      commitMemory(s.memory, "tidy: bot default, chat C-0");

      writeFileSync(
        join(s.memory, "index.md"),
        "# Memory index\n\n- [one](topics/one.md): first\n- [two](topics/two.md): second\n",
      );
      note(s.memory, "two.md", "second\n");
      commitMemory(s.memory, "memory: bot default, chat C-1");

      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("pending");
      await s.r.act(TIDY_TYPE, "default", "bot/run");
      await s.source.poll();
      const id = (await chats(s.r))[0];
      if (id === undefined) throw new Error("no tidy chat");

      await s.r.reply(id);
      await s.source.settled();

      const data = await tidy(s.r);
      expect(data?.state).toBe("result");
      expect(data?.outcome?.changed).toBe(true);
      expect(data?.outcome?.summary).toContain("2 files changed");
      expect(await s.r.registry.standing()).toEqual([]);

      const page = await s.views.section(`${TIDY_TYPE}:default`, "tidy");
      expect(page.markdown).toContain("2 files changed");
      expect(page.markdown).toContain("Reply: ok");

      expect(s.notices).toHaveLength(1);
      expect(s.notices[0]?.summary).toContain("default:");
      expect(s.notices[0]?.summary).toContain("2 files changed");
      expect(s.notices[0]?.summary).toContain("cost unknown");
      expect(s.notices[0]?.summary).not.toContain("Reply:");
    } finally {
      s.views.close();
    }
  });

  test("a stored result state is not a pending item", async () => {
    const s = await setup();
    try {
      const before = await tidy(s.r);
      if (before === undefined) throw new Error("no tidy state");
      await s.r.store.put(
        TIDY_TYPE,
        "default",
        {
          ...before,
          state: "result",
          outcome: {
            chatId: "C-0",
            at: s.clock.value,
            costMicros: null,
            changed: true,
            voided: false,
            summary: "1 file changed, 1 insertion(+)",
            reply: "the agent's raw reply",
          },
        },
        "test",
      );

      expect(await s.r.registry.standing()).toEqual([]);
      const row = (await s.views.list(TIDY_TYPE)).rows.find((entry) => entry.id === "default");
      expect(row).toMatchObject({ state: "result", waiting: false });
      const page = await s.views.section(`${TIDY_TYPE}:default`, "tidy");
      expect(page.markdown).toContain("1 file changed");
      expect(page.markdown).toContain("the agent's raw reply");
    } finally {
      s.views.close();
    }
  });

  test("the notice line names the change, the cost and a voided rewrite", () => {
    expect(
      tidyOutcomeLine("default", {
        chatId: "C-1",
        at: 0,
        costMicros: 1_500_000,
        changed: true,
        voided: true,
        summary: "1 file changed, 2 insertions(+)",
        reply: "raw reply",
      }),
    ).toBe("default: 1 file changed, 2 insertions(+); cost $1.50; only additions were kept");
    expect(
      tidyOutcomeLine("default", {
        chatId: "C-1",
        at: 0,
        costMicros: null,
        changed: false,
        voided: false,
        summary: "No memory change.",
        reply: "",
      }),
    ).toBe("default: no memory change; cost unknown");
  });

  test("a Run waits while a chat of the bot is writing a reply", async () => {
    const s = await setup();
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      const busy = await s.r.open("default");
      await s.r.say(busy, "still talking");
      await s.r.store.append({
        type: "chat.run",
        object: { type: CHAT_TYPE, id: busy },
        cause: "test",
        data: { runId: "run-live" },
      });

      await s.r.act(TIDY_TYPE, "default", "bot/run");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("requested");
      expect(await chats(s.r)).toEqual([busy]);

      const message = allMessages(s.r.store, busy)[0];
      if (message === undefined) throw new Error("no message");
      await s.r.store.append({
        type: "chat.message",
        object: { type: CHAT_TYPE, id: busy },
        cause: "test",
        data: {
          id: "assistant-live",
          role: "assistant",
          from: { via: "pi", id: "pi" },
          text: "done",
          attachments: [],
          source: { kind: "pi", ref: null },
          replyTo: [message.id],
          runId: "run-live",
        },
      });
      await s.source.poll();
      expect(await chats(s.r)).toHaveLength(2);
    } finally {
      s.views.close();
    }
  });

  test("a Run waits while the latest reply run is active, and starts once it has ended", async () => {
    let activeRun: string | undefined = "run-live";
    const s = await setup(undefined, undefined, undefined, {
      runs: {
        cancel: () => false,
        active: (runId) => runId === activeRun,
      },
    });
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      const stale = await s.r.open("default");
      await s.r.say(stale, "the reply that ended");
      await s.r.store.append({
        type: "chat.run",
        object: { type: CHAT_TYPE, id: stale },
        cause: "test",
        data: { runId: "run-live" },
      });

      await s.r.act(TIDY_TYPE, "default", "bot/run");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("requested");
      expect(await chats(s.r)).toEqual([stale]);

      activeRun = undefined;
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("running");
      expect(await chats(s.r)).toContain(stale);
      expect(await chats(s.r)).toHaveLength(2);
    } finally {
      s.views.close();
    }
  });

  test("a requested Run does not check its work on every tick while a chat is replying", async () => {
    let workCalls = 0;
    const s = await setup(undefined, undefined, undefined, {
      work: async () => {
        workCalls += 1;
        return noteWork();
      },
    });
    try {
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      expect(workCalls).toBe(1);

      const busy = await s.r.open("default");
      await s.r.say(busy, "still talking");
      await s.r.store.append({
        type: "chat.run",
        object: { type: CHAT_TYPE, id: busy },
        cause: "test",
        data: { runId: "run-live" },
      });
      await s.r.act(TIDY_TYPE, "default", "bot/run");
      await s.source.poll();
      expect((await tidy(s.r))?.state).toBe("requested");
      expect(workCalls).toBe(1);
    } finally {
      s.views.close();
    }
  });

  test("an automatic tidy does not check its work on every tick while a chat is replying", async () => {
    let workCalls = 0;
    const s = await setup(
      { default: { tidyTime: "03:30", runWithoutAsking: true } },
      undefined,
      undefined,
      {
        work: async () => {
          workCalls += 1;
          return noteWork();
        },
      },
    );
    try {
      const busy = await s.r.open("default");
      await s.r.say(busy, "still talking");
      await s.r.store.append({
        type: "chat.run",
        object: { type: CHAT_TYPE, id: busy },
        cause: "test",
        data: { runId: "run-live" },
      });
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      expect(workCalls).toBe(0);
      expect(await chats(s.r)).toEqual([busy]);
    } finally {
      s.views.close();
    }
  });

  test("a tidy run that fails leaves a failed card", async () => {
    const s = await setup(undefined, undefined, undefined, {
      runs: {
        active: (runId) => (runId === "run-crashed" ? false : undefined),
        cancel: () => false,
      },
    });
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      await s.r.act(TIDY_TYPE, "default", "bot/run");
      await s.source.poll();
      const id = (await chats(s.r))[0];
      if (id === undefined) throw new Error("no tidy chat");
      // A latest run the host says ended, whose failure entry was never recorded.
      await s.r.store.append({
        type: RUN_FACT,
        object: chatRef(id),
        cause: "test",
        data: { runId: "run-crashed" },
      });
      await failChat(s.r, id);
      await s.source.settled();

      expect((await tidy(s.r))?.state).toBe("failed");
      const card = (await s.r.registry.standing())[0];
      expect(card?.prompt).toBe("Dreaming for bot default failed: The reply failed: quota.");
      expect(card?.prompt).not.toContain("\n");
      expect(card?.actions).toEqual([
        { plugin: "bot", action: "run" },
        { plugin: "bot", action: "skip" },
      ]);
    } finally {
      s.views.close();
    }
  });
});

describe("Run without asking", () => {
  test("a run that changes nothing makes the memory commit but sends no notice", async () => {
    const s = await setup({ default: { tidyTime: "03:30", runWithoutAsking: true } });
    try {
      writeFileSync(
        join(s.memory, "index.md"),
        `# Memory index\n\n${"- [tea](topics/tea.md): a line\n".repeat(500)}`,
      );
      ensureRepository(s.memory);
      const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
      expect(memoryGit(s.memory, [...identity, "add", "-A"]).ok).toBe(true);
      expect(memoryGit(s.memory, [...identity, "commit", "--no-verify", "-m", "tidy: bot default, chat C-0"]).ok).toBe(true);
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      const id = (await chats(s.r))[0];
      if (id === undefined) throw new Error("no tidy chat");
      await s.r.reply(id);
      await s.source.settled();
      expect(s.notices).toEqual([]);
      expect((await tidy(s.r))?.state).toBe("idle");
      const repository = ensureRepository(s.memory);
      expect(lastTidyCommit(repository, s.memory)).toBeString();
      expect(tidyCommitForChat(repository, s.memory, id)).toBeString();
    } finally {
      s.views.close();
    }
  });

  test("the model is the harness's declared background model, and a bot setting overrides it", async () => {
    const declared = await setup(
      { default: { tidyTime: "03:30", runWithoutAsking: true } },
      "2026-01-01T02:00:00Z",
      () => ({ backgroundModel: "pi-a" }),
    );
    try {
      note(declared.memory, "tea.md", "likes tea\n");
      declared.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await declared.source.poll();
      const first = (await chats(declared.r))[0];
      if (first === undefined) throw new Error("no tidy chat");
      expect((await declared.r.store.get(CHAT_TYPE, first))?.data.model).toBe("pi-a");
    } finally {
      declared.views.close();
    }

    const overridden = await setup(
      { default: { tidyTime: "03:30", runWithoutAsking: true, backgroundModel: "pi-b" } },
      "2026-01-01T02:00:00Z",
      () => ({ backgroundModel: "pi-a" }),
    );
    try {
      note(overridden.memory, "tea.md", "likes tea\n");
      overridden.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await overridden.source.poll();
      const first = (await chats(overridden.r))[0];
      if (first === undefined) throw new Error("no tidy chat");
      expect((await overridden.r.store.get(CHAT_TYPE, first))?.data.model).toBe("pi-b");
    } finally {
      overridden.views.close();
    }
  });

  test("the background model comes from the first agent that carries the starting level", async () => {
    const asked: Record<string, unknown>[] = [];
    const client = {
      act: async (_action: string, _target: string, input: { readonly args: Record<string, unknown> }) => {
        asked.push(input.args);
        return {};
      },
    } as unknown as ClientApi;
    const s = await setup(
      { default: { tidyTime: "03:30", runWithoutAsking: true } },
      "2026-01-01T02:00:00Z",
      (harness) =>
        harness === "pi"
          ? { backgroundModel: "pi-a", accessLevels: ["edits"] }
          : { backgroundModel: "other-a", accessLevels: ["ask", "edits"] },
      { harnesses: ["pi", "other"], client },
    );
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      expect(asked[0]?.model).toBe("other-a");
    } finally {
      s.views.close();
    }
  });

  test("an automatic tidy that fails sends one notice line", async () => {
    const s = await setup({ default: { tidyTime: "03:30", runWithoutAsking: true } });
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      const id = (await chats(s.r))[0];
      if (id === undefined) throw new Error("no tidy chat");
      await failChat(s.r, id);
      await s.source.settled();

      expect((await tidy(s.r))?.state).toBe("idle");
      expect(s.notices).toHaveLength(1);
      expect(s.notices[0]?.summary).toContain("The reply failed: quota");
    } finally {
      s.views.close();
    }
  });

  test("the tidy runs with no card, and a change sends one notice line", async () => {
    const s = await setup({ default: { tidyTime: "03:30", runWithoutAsking: true } });
    try {
      note(s.memory, "tea.md", "likes tea\n");
      s.clock.value = Date.parse("2026-01-01T03:31:00Z");
      await s.source.poll();
      const opened = await chats(s.r);
      expect(opened).toHaveLength(1);
      expect((await s.r.registry.standing())).toEqual([]);
      const id = opened[0];
      if (id === undefined) throw new Error("no tidy chat");

      note(s.memory, "coffee.md", "likes coffee\n");
      await s.r.reply(id);
      await s.source.settled();
      expect((await tidy(s.r))?.state).toBe("idle");
      expect(s.notices).toHaveLength(1);
      expect(s.notices[0]?.summary).toContain("default:");
      expect(s.notices[0]?.summary).not.toContain("\n");

      s.clock.value = Date.parse("2026-01-02T03:31:00Z");
      await s.source.poll();
      expect(await chats(s.r)).toHaveLength(1);
    } finally {
      s.views.close();
    }
  });
});

describe("the instructions after a tidy run", () => {
  const ended: RunControl = { active: () => false, cancel: () => false };
  const writable = (memory: string): boolean => (statSync(join(memory, "instructions.md")).mode & 0o222) !== 0;

  async function running(s: Awaited<ReturnType<typeof setup>>): Promise<string> {
    note(s.memory, "tea.md", "likes tea\n");
    s.clock.value = Date.parse("2026-01-01T03:31:00Z");
    await s.source.poll();
    await s.r.act(TIDY_TYPE, "default", "bot/run");
    await s.source.poll();
    const id = (await chats(s.r))[0];
    if (id === undefined) throw new Error("no tidy chat");
    expect(writable(s.memory)).toBe(false);
    return id;
  }

  test("a cancelled run, with no commit, makes the file writable again", async () => {
    const s = await setup(undefined, undefined, undefined, { runs: ended });
    try {
      const id = await running(s);
      await s.r.store.append({ type: RUN_FACT, object: chatRef(id), cause: "test", data: { runId: "run-stopped" } });
      await s.r.store.append({
        type: STOP_FACT,
        object: chatRef(id),
        cause: "test",
        data: { runId: "run-stopped", by: { via: "test", id: "person" } },
      });
      await s.source.settled();
      expect(writable(s.memory)).toBe(true);
    } finally {
      s.views.close();
    }
  });

  test("a failed run, with no commit, makes the file writable again", async () => {
    const s = await setup(undefined, undefined, undefined, { runs: ended });
    try {
      const id = await running(s);
      await s.r.store.append({ type: RUN_FACT, object: chatRef(id), cause: "test", data: { runId: "run-failed" } });
      await s.r.store.append({
        type: "chat.entry",
        object: chatRef(id),
        cause: "test",
        data: { runId: "run-failed", kind: "failure", text: "The reply failed: quota" },
      });
      await s.source.settled();
      expect(writable(s.memory)).toBe(true);
    } finally {
      s.views.close();
    }
  });

  test("serve start makes the file writable when no tidy run is going", async () => {
    const s = await setup();
    try {
      expect((await tidy(s.r))?.state).toBe("idle");
      chmodSync(join(s.memory, "instructions.md"), 0o444);
      await s.source.begin();
      expect(writable(s.memory)).toBe(true);
    } finally {
      s.views.close();
    }
  });
});
