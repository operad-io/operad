import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore, type FactsOptions, type ObjectRef } from "@operad-io/engine";
import {
  MemorySearch,
  searchDatabasePath,
} from "../src/search/service.ts";
import { SearchError, type SearchResult } from "../src/search/types.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Rig {
  readonly root: string;
  readonly home: string;
  readonly botA: string;
  readonly botB: string;
  readonly store: MemoryPluginStore;
  readonly search: MemorySearch;
}

function file(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

async function rig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "memory-search-"));
  roots.push(root);
  const home = join(root, "home");
  const botA = join(home, "bot", "default");
  const botB = join(home, "bot", "other");
  mkdirSync(join(home, "wiki", "notes"), { recursive: true });
  mkdirSync(join(botA, "memory", "topics"), { recursive: true });
  mkdirSync(join(botB, "memory"), { recursive: true });
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const search = new MemorySearch(home, {}, { file: searchDatabasePath(home) });
  return { root, home, botA, botB, store, search };
}

function message(store: MemoryPluginStore, chat: string, id: string, text: string, role: "user" | "assistant" = "user"): void {
  store.append({
    type: "chat.message",
    object: { type: "chat", id: chat },
    cause: "test",
    data: {
      id,
      role,
      text,
      from: { via: "cli", id: "person" },
      attachments: [],
      source: { kind: "cli", ref: null },
    },
  });
}

function scopeOf(result: SearchResult, id: string): string | undefined {
  return result.hits.find((hit) => hit.id === id)?.scope;
}

describe("the full-text index", () => {
  test("finds a word in the wiki and in the bot's own memory, with a line range", async () => {
    const r = await rig();
    file(join(r.home, "wiki", "notes", "tea.md"), "# Tea\n\nGreen tea is brewed cooler.\nBlack tea takes boiling water.\n");
    file(join(r.botA, "memory", "topics", "taste.md"), "# Taste\n\nThe person prefers jasmine tea.\n");
    await r.search.refresh();
    const wiki = r.search.search({ text: "boiling", cwd: r.botA });
    expect(wiki.hits).toHaveLength(1);
    expect(wiki.hits[0]).toMatchObject({
      id: "wiki:notes/tea.md",
      scope: "wiki",
      path: "notes/tea.md",
      lineStart: 1,
      lineEnd: 5,
    });
    const memory = r.search.search({ text: "jasmine", cwd: r.botA, scopes: ["memory"] });
    expect(memory.hits).toHaveLength(1);
    expect(memory.hits[0]).toMatchObject({ id: `memory:${r.botA}:topics/taste.md`, scope: "memory" });
    r.search.close();
  });

  test("a changed file is found on the next search, and a deleted one is gone", async () => {
    const r = await rig();
    const note = join(r.home, "wiki", "note.md");
    file(note, "# Note\n\nfirst word\n");
    await r.search.refresh();
    expect(r.search.search({ text: "first", cwd: r.botA }).hits).toHaveLength(1);
    // A second write with a different length, so a file system with a coarse
    // timestamp still shows the new content as new.
    file(note, "# Note\n\nsecond word, now longer\n");
    await r.search.refresh();
    expect(r.search.search({ text: "first", cwd: r.botA }).hits).toHaveLength(0);
    expect(r.search.search({ text: "second", cwd: r.botA }).hits).toHaveLength(1);
    unlinkSync(note);
    await r.search.refresh();
    expect(r.search.search({ text: "second", cwd: r.botA }).hits).toHaveLength(0);
    r.search.close();
  });

  test("frontmatter fields filter the results", async () => {
    const r = await rig();
    file(join(r.home, "wiki", "a.md"), "---\ntags: [project, active]\n---\n\n# A\n\nnote about the launch\n");
    file(join(r.home, "wiki", "b.md"), "---\ntags: personal\n---\n\n# B\n\nnote about the weekend\n");
    await r.search.refresh();
    const all = r.search.search({ text: "note", cwd: r.botA });
    expect(all.hits).toHaveLength(2);
    const project = r.search.search({ text: "note", cwd: r.botA, fields: { tags: "project" } });
    expect(project.hits.map((hit) => hit.id)).toEqual(["wiki:a.md"]);
    const personal = r.search.search({ text: "note", cwd: r.botA, fields: { tags: ["personal"] } });
    expect(personal.hits.map((hit) => hit.id)).toEqual(["wiki:b.md"]);
    r.search.close();
  });

  test("a directory's _about.md is returned with its hits", async () => {
    const r = await rig();
    file(join(r.home, "wiki", "notes", "_about.md"), "---\ntitle: Notes\n---\n\nThese are the notes of the wiki.\n");
    file(join(r.home, "wiki", "notes", "garden.md"), "# Garden\n\nWater the garden in the morning.\n");
    file(join(r.home, "wiki", "_about.md"), "The wiki root: rules for every note.\n");
    await r.search.refresh();
    const found = r.search.search({ text: "garden", cwd: r.botA });
    expect(found.hits.map((hit) => hit.id)).toEqual(["wiki:notes/garden.md"]);
    expect(found.about).toEqual([
      {
        id: "wiki:notes/_about.md",
        title: "Notes",
        text: "These are the notes of the wiki.",
      },
    ]);
    const root = r.search.search({ text: "rules", cwd: r.botA });
    expect(root.about.map((note) => note.id)).toEqual(["wiki:_about.md"]);
    r.search.close();
  });

  test("a bot sees only its own memory and chats beside the shared wiki", async () => {
    const r = await rig();
    file(join(r.home, "wiki", "shared.md"), "# Shared\n\ncurry recipe\n");
    file(join(r.botA, "memory", "a.md"), "# A\n\ncurry is my favourite\n");
    file(join(r.botB, "memory", "b.md"), "# B\n\ncurry belongs to the other bot\n");
    await r.store.put("chat", "C-A", { parent: "bot:default", cwd: r.botA, title: "A chat" }, "test");
    await r.store.put("chat", "C-B", { parent: "bot:other", cwd: r.botB, title: "B chat" }, "test");
    message(r.store, "C-A", "m-a", "the curry at home is good");
    message(r.store, "C-B", "m-b", "the curry at the other home is good");
    await r.search.refresh(r.store);

    const forA = r.search.search({ text: "curry", cwd: r.botA, scopes: ["wiki", "memory", "chats"] });
    expect(forA.hits.map((hit) => hit.id).sort()).toEqual([
      "chat:C-A",
      `memory:${r.botA}:a.md`,
      "wiki:shared.md",
    ]);
    const memoryA = r.search.search({ text: "curry", cwd: r.botA, scopes: ["memory"] });
    expect(memoryA.hits.map((hit) => hit.id)).toEqual([`memory:${r.botA}:a.md`]);
    const chatsA = r.search.search({ text: "curry", cwd: r.botA, scopes: ["chats"] });
    expect(chatsA.hits.map((hit) => hit.id)).toEqual(["chat:C-A"]);
    const chatsB = r.search.search({ text: "curry", cwd: r.botB, scopes: ["chats"] });
    expect(chatsB.hits.map((hit) => hit.id)).toEqual(["chat:C-B"]);
    expect(scopeOf(forA, "chat:C-B")).toBeUndefined();
    r.search.close();
  });

  test("a chat that gains a message is found on the next refresh", async () => {
    const r = await rig();
    await r.store.put("chat", "C-1", { parent: "bot:default", cwd: r.botA, title: "Test" }, "test");
    message(r.store, "C-1", "m1", "the first line");
    await r.search.refresh(r.store);
    expect(r.search.search({ text: "first", cwd: r.botA, scopes: ["chats"] }).hits).toHaveLength(1);
    message(r.store, "C-1", "m2", "the second line mentions cardamom");
    await r.search.refresh(r.store);
    expect(r.search.search({ text: "cardamom", cwd: r.botA, scopes: ["chats"] }).hits).toHaveLength(1);
    r.search.close();
  });

  test("a search inside one chat returns every place in it with the message, and reaches no other chat", async () => {
    const r = await rig();
    await r.store.put("chat", "C-1", { parent: "bot:default", cwd: r.botA, title: "One" }, "test");
    await r.store.put("chat", "C-2", { parent: "bot:default", cwd: r.botA, title: "Two" }, "test");
    message(r.store, "C-1", "m1", "we talked about cardamom first");
    message(r.store, "C-1", "m2", "an answer\nover\nseveral\nlines\nof\nfiller\nfiller\nfiller\nfiller\nfiller\nfiller\nfiller\nfiller\nfiller\nfiller\nfiller\nfiller\nfiller", "assistant");
    message(r.store, "C-1", "m3", "much later cardamom came back");
    message(r.store, "C-2", "n1", "cardamom in the other chat");
    await r.search.refresh(r.store);

    // The caller is not the bot: the chat is named, so the chat is reached.
    const found = r.search.search({ text: "cardamom", cwd: r.root, chat: "C-1", store: r.store });
    expect(found.scopes).toEqual(["chats"]);
    expect(found.hits.every((hit) => hit.id === "chat:C-1")).toBe(true);
    expect(found.hits.map((hit) => hit.message).sort()).toEqual(["m1", "m3"]);
    // Without the chat, one document gives one hit.
    expect(r.search.search({ text: "cardamom", cwd: r.botA, scopes: ["chats"] }).hits).toHaveLength(2);
    expect(r.search.search({ text: "cardamom", cwd: r.root, chat: "C-9", store: r.store }).hits).toHaveLength(0);
    r.search.close();
  });

  test("a chat's owner is compared as a resolved path", async () => {
    const r = await rig();
    await r.store.put(
      "chat",
      "C-1",
      { parent: "bot:default", cwd: `${r.botA}/./`, title: "Test" },
      "test",
    );
    message(r.store, "C-1", "m1", "the cardamom line");
    await r.search.refresh(r.store);

    const found = r.search.search({ text: "cardamom", cwd: r.botA, scopes: ["chats"] });
    expect(found.hits.map((hit) => hit.id)).toEqual(["chat:C-1"]);
    r.search.close();
  });

  test("an unchanged chat's facts are not read on the next refresh", async () => {
    const r = await rig();
    await r.store.put("chat", "C-1", { parent: "bot:default", cwd: r.botA, title: "Test" }, "test");
    message(r.store, "C-1", "m1", "the first line");
    await r.search.refresh(r.store);

    const original = r.store.facts.bind(r.store);
    let chatReads = 0;
    r.store.facts = function (object?: ObjectRef, options?: FactsOptions) {
      if (object?.type === "chat") chatReads += 1;
      return object === undefined ? original() : original(object, options);
    } as typeof r.store.facts;

    await r.search.refresh(r.store);
    expect(chatReads).toBe(0);

    message(r.store, "C-1", "m2", "the cardamom line");
    await r.search.refresh(r.store);
    expect(chatReads).toBeGreaterThan(0);
    expect(r.search.search({ text: "cardamom", cwd: r.botA, scopes: ["chats"] }).hits).toHaveLength(1);
    r.search.close();
  });

  test("read returns the document by id and the asked line range", async () => {
    const r = await rig();
    file(join(r.home, "wiki", "lines.md"), "# Lines\n\nsecond line\nthird line\nfourth line\n");
    await r.search.refresh();
    const found = r.search.search({ text: "third", cwd: r.botA });
    const hit = found.hits[0];
    expect(hit).toBeDefined();
    if (hit === undefined) return;
    const part = r.search.read({ id: hit.id, from: 3, to: 4 });
    expect(part).toMatchObject({
      id: "wiki:lines.md",
      lineStart: 3,
      lineEnd: 4,
      totalLines: 6,
      text: "second line\nthird line",
    });
    expect(() => r.search.read({ id: "wiki:missing.md" })).toThrow(SearchError);
    r.search.close();
  });

  test("deleting the index file only costs a rebuild", async () => {
    const r = await rig();
    file(join(r.home, "wiki", "note.md"), "# Note\n\nrebuild me\n");
    await r.search.refresh();
    expect(r.search.search({ text: "rebuild", cwd: r.botA }).hits).toHaveLength(1);
    const database = searchDatabasePath(r.home);
    r.search.close();
    expect(existsSync(database)).toBe(true);
    unlinkSync(database);
    const again = new MemorySearch(r.home);
    try {
      await again.refresh();
      expect(again.search({ text: "rebuild", cwd: r.botA }).hits.length).toBeGreaterThan(0);
    } finally {
      again.close();
    }
  });
});
