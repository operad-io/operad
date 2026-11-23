import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SectionContent, ViewContext } from "@operad-io/engine";
import { allMessages, CHAT_TYPE, chatData, chatRef, chatViews, COMMAND_FACT, NEW_FACT, readChat, segmentsOf, SEGMENT_TITLE_FACT } from "../src/index.ts";
import { clock as testClock, cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

const realNow = testClock.now;
const day = (n: number): number => Date.UTC(2026, 10, n, 10, 0, 0);

async function view(r: Rig, chat: string, options: { readonly cursor?: string; readonly after?: string } = {}): Promise<SectionContent> {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
    sectionCapBytes: 1_000_000,
    runTimes: async () => ({ startedAt: 1, endedAt: 2, segments: [] }),
  } as unknown as ViewContext;
  return chatViews.load(ctx, object, "transcript", options);
}

async function slashNew(r: Rig, chat: string): Promise<void> {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  await r.registry.runAction("chat/send", { note: "/new" }, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

function compacted(r: Rig, chat: string): void {
  r.store.append({
    type: COMMAND_FACT,
    object: chatRef(chat),
    cause: "test",
    data: { from: { via: "fake", id: "fake" }, command: "compact", outcome: "The context was compacted.", ok: true },
  });
}

const titling = (call: { params: Record<string, unknown> }): boolean => String(call.params.prompt).includes("Give a title");

/** Three segments on three days: the start, a `/new` and a compaction. */
async function threeSegments(r: Rig, set: (at: number) => void): Promise<{ chat: string; bravo: string; mark: string | undefined }> {
  const chat = await r.chat();
  set(day(20));
  await r.say(chat, "alpha question");
  await r.round(chat);
  set(day(21));
  await slashNew(r, chat);
  const bravo = await r.say(chat, "bravo question");
  await r.round(chat);
  const mark = (await view(r, chat)).mark;
  set(day(22));
  compacted(r, chat);
  await r.say(chat, "charlie question");
  await r.round(chat);
  return { chat, bravo, mark };
}

function scripted(titles: (n: number) => string | undefined): Parameters<typeof rig>[0] {
  let n = 0;
  return (_ctx, call) => {
    if (!titling(call)) return reply("an answer");
    n += 1;
    const text = titles(n);
    return text === undefined ? { result: "failed", data: {} } : { result: "done", data: { finalMessage: text } };
  };
}

describe("segments of a long chat", () => {
  test("a /new and a compaction each start a segment; the transcript marks it with its date and a generated title", async () => {
    let clock = day(20);
    testClock.now = () => clock;
    try {
      const r = await rig(scripted((n) => (n === 1 ? "Pasta night plans" : "Garden irrigation")));
      const { chat } = await threeSegments(r, (at) => {
        clock = at;
      });
      const read = readChat(r.store, chat);
      expect(segmentsOf(read.facts, "Test").map((segment) => [segment.number, segment.kind, segment.title])).toEqual([
        [1, "first", "Test"],
        [2, "new", "Pasta night plans"],
        [3, "compact", "Garden irrigation"],
      ]);
      const page = await view(r, chat);
      expect(page.markdown).toContain("### Pasta night plans · 2026-11-21");
      expect(page.markdown).toContain("### Garden irrigation · 2026-11-22");
      expect(page.markdown.match(/^### /gmu)).toHaveLength(2);
      expect(page.markdown.indexOf("alpha question")).toBeLessThan(page.markdown.indexOf("### Pasta night plans"));
      expect(page.markdown.indexOf("### Pasta night plans")).toBeLessThan(page.markdown.indexOf("bravo question"));
      expect(page.markdown.indexOf("### Garden irrigation")).toBeLessThan(page.markdown.indexOf("charlie question"));
      expect(page.data?.segments).toEqual([
        { number: 1, at: day(20), kind: "first", title: "Test", cursor: "segment:1" },
        { number: 2, at: day(21), kind: "new", title: "Pasta night plans", cursor: "segment:2" },
        { number: 3, at: day(22), kind: "compact", title: "Garden irrigation", cursor: "segment:3" },
      ]);
      // The call used the question and the answer, and none was made for the first segment.
      const calls = r.calls.filter(titling);
      expect(calls).toHaveLength(2);
      expect(String(calls[0]?.params.prompt)).toContain("bravo question");
      expect(String(calls[0]?.params.prompt)).toContain("an answer");
      // A segment is named once: another exchange makes no call.
      await r.say(chat, "delta question");
      await r.round(chat);
      expect(r.calls.filter(titling)).toHaveLength(2);
    } finally {
      testClock.now = realNow;
    }
  });

  test("the title call asks for the agent's background model when it declares one", async () => {
    const r = await rig(scripted(() => "Named"), undefined, undefined, "fake", [], { backgroundModel: "small" });
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await slashNew(r, chat);
    await r.say(chat, "two");
    await r.round(chat);
    expect(r.calls.filter(titling)[0]?.params.args).toEqual(["--model", "small"]);
  });

  test("the title call is paid like a reply: the chat's cost counts it as soon as it is made", async () => {
    const r = await rig((_ctx, call) =>
      titling(call)
        ? { result: "done", data: { finalMessage: "Named", usage: { model: "m", costMicros: 7, costQuality: "exact" } } }
        : { result: "done", data: { finalMessage: "ok", usage: { model: "m", costMicros: 100, costQuality: "exact" } } },
    );
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await slashNew(r, chat);
    await r.say(chat, "two");
    await r.round(chat);
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).costMicros).toBe(207);
  });

  test("a title call that fails leaves the first words of the question, once", async () => {
    const r = await rig(scripted(() => undefined));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await slashNew(r, chat);
    await r.say(chat, "plan the migration\nsecond line");
    await r.round(chat);
    await r.say(chat, "again");
    await r.round(chat);
    expect(segmentsOf(readChat(r.store, chat).facts, "Test")[1]?.title).toBe("plan the migration");
    expect(r.calls.filter(titling)).toHaveLength(1);
    expect(readChat(r.store, chat).facts.filter((fact) => fact.type === SEGMENT_TITLE_FACT)).toHaveLength(1);
  });

  test("the goal of /new is the title and no call is made for it", async () => {
    const r = await rig(scripted(() => "never used"));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    r.store.append({ type: NEW_FACT, object: chatRef(chat), cause: "test", data: { by: { via: "cli", id: "me" }, goal: "add the\n export command" } });
    await r.say(chat, "two");
    await r.round(chat);
    expect(segmentsOf(readChat(r.store, chat).facts, "Test")[1]?.title).toBe("add the export command");
    expect(r.calls.filter(titling)).toHaveLength(0);
    expect((await view(r, chat)).markdown).toContain("### add the export command · ");
  });

  test("a stretch with no message is not a segment, and a chat with one segment shows none", async () => {
    const r = await rig(scripted(() => "Second"));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    expect((await view(r, chat)).data?.segments).toBeUndefined();
    expect((await view(r, chat)).markdown).not.toContain("###");
    await slashNew(r, chat);
    await slashNew(r, chat);
    compacted(r, chat);
    expect(segmentsOf(readChat(r.store, chat).facts, "Test")).toHaveLength(1);
    await r.say(chat, "two");
    await r.round(chat);
    expect(segmentsOf(readChat(r.store, chat).facts, "Test").map((segment) => segment.number)).toEqual([1, 2]);
    expect(allMessages(r.store, chat)).toHaveLength(4);
  });

  test("a read that comes after a mark carries the marker of a segment that began since", async () => {
    let clock = day(20);
    testClock.now = () => clock;
    try {
      const r = await rig(scripted((n) => `Title ${n}`));
      const { chat, mark } = await threeSegments(r, (at) => {
        clock = at;
      });
      const delta = await view(r, chat, mark === undefined ? {} : { after: mark });
      expect(delta.delta).toBe(true);
      expect(delta.markdown).toContain("### Title 2 · 2026-11-22");
      expect(delta.markdown).not.toContain("### Title 1");
      expect(delta.markdown).not.toContain("bravo question");
    } finally {
      testClock.now = realNow;
    }
  });
});

describe("reading the transcript from a segment, a date or a message", () => {
  async function long(): Promise<{ r: Rig; chat: string; bravo: string }> {
    let clock = day(20);
    testClock.now = () => clock;
    try {
      const r = await rig(scripted((n) => `Title ${n}`));
      const made = await threeSegments(r, (at) => {
        clock = at;
      });
      return { r, ...made };
    } finally {
      testClock.now = realNow;
    }
  }

  test("segment:N starts at that segment", async () => {
    const { r, chat } = await long();
    const page = await view(r, chat, { cursor: "segment:3" });
    expect(page.markdown).toContain("### Title 2 · 2026-11-22");
    expect(page.markdown).toContain("charlie question");
    expect(page.markdown).not.toContain("bravo question");
    const first = await view(r, chat, { cursor: "segment:1" });
    expect(first.markdown).toContain("alpha question");
    await expect(view(r, chat, { cursor: "segment:9" })).rejects.toThrow("no segment 9");
  });

  test("date:YYYY-MM-DD starts at the first thing on or after that day", async () => {
    const { r, chat } = await long();
    const page = await view(r, chat, { cursor: "date:2026-11-22" });
    expect(page.markdown).not.toContain("bravo question");
    expect(page.markdown).toContain("charlie question");
    const earlier = await view(r, chat, { cursor: "date:2026-01-01" });
    expect(earlier.markdown).toContain("alpha question");
    await expect(view(r, chat, { cursor: "date:2027-01-01" })).rejects.toThrow("nothing on or after");
    await expect(view(r, chat, { cursor: "date:yesterday" })).rejects.toThrow("YYYY-MM-DD");
  });

  test("message:ID starts at the message a search hit named", async () => {
    const { r, chat, bravo } = await long();
    const page = await view(r, chat, { cursor: `message:${bravo}` });
    expect(page.markdown).not.toContain("alpha question");
    expect(page.markdown).toContain("bravo question");
    await expect(view(r, chat, { cursor: "message:nope" })).rejects.toThrow("no message nope");
  });

  test("a page that starts inside the chat continues with next and never loops back", async () => {
    const r = await rig((_ctx, call) => (titling(call) ? { result: "done", data: { finalMessage: "T" } } : reply("ok")));
    const chat = await r.chat();
    await r.say(chat, "first");
    await r.round(chat);
    await slashNew(r, chat);
    for (let n = 0; n < 40; n += 1) {
      await r.say(chat, `message ${n}`);
      await r.round(chat);
    }
    const seen: string[] = [];
    let cursor: string | undefined = "segment:2";
    let pages = 0;
    while (cursor !== undefined && pages < 10) {
      const page: SectionContent = await view(r, chat, { cursor });
      seen.push(page.markdown);
      cursor = page.next;
      pages += 1;
    }
    expect(pages).toBe(2);
    const text = seen.join("\n");
    expect(text).toContain("message 0");
    expect(text).toContain("message 39");
    expect(text).not.toContain("first");
    expect(text.match(/message 39/gu)).toHaveLength(1);
  });
});
