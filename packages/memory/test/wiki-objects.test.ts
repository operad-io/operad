import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  ViewError,
  createViews,
  type Views,
} from "@operad-io/engine";
import {
  WIKI_BACKLINKS_SECTION,
  WIKI_CONTENT_SECTION,
  WIKI_FOLDER_TYPE,
  WIKI_NOTE_TYPE,
  WIKI_PAGE_CHARS,
  createMemoryPlugin,
} from "../src/index.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Rig {
  readonly home: string;
  readonly wiki: string;
  readonly views: Views;
}

function file(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function rig(write: (wiki: string) => void): Rig {
  const root = mkdtempSync(join(tmpdir(), "memory-wiki-objects-"));
  roots.push(root);
  const home = join(root, "home");
  const wiki = join(home, "wiki");
  mkdirSync(wiki, { recursive: true });
  write(wiki);
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const registry = new PluginRegistry([createMemoryPlugin()], {
    home,
    cwd: root,
    store,
    settings: { memory: {} },
    onLog: () => undefined,
  });
  const views = createViews({ registry, store, home, onLog: () => undefined });
  return { home, wiki, views };
}

describe("the wiki objects", () => {
  test("the root lists the top-level folders and notes", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "index.md"), "# Index\n");
      file(join(wiki, "notes", "tea.md"), "# Tea\n");
      file(join(wiki, "notes", "deep", "coffee.md"), "# Coffee\n");
      file(join(wiki, "empty", "keep.txt"), "not a note\n");
    });
    const page = await r.views.listTree(undefined, { root: true });
    const ids = page.rows.map((row) => row.id);
    expect(ids).toContain("index.md");
    expect(ids).toContain("notes");
    expect(ids).toContain("empty");
    expect(ids).not.toContain("notes/tea.md");
    const notes = page.rows.find((row) => row.id === "notes");
    expect(notes).toMatchObject({
      title: "notes",
      state: "open",
      note: "2 notes",
    });
    expect(notes?.parent).toBeUndefined();
    expect(notes?.mark).toBeUndefined();
  });

  test("a folder lists its subfolders and notes, and nothing else", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "notes", "tea.md"), "# Tea\n");
      file(join(wiki, "notes", "deep", "coffee.md"), "# Coffee\n");
      file(join(wiki, "elsewhere.md"), "# Elsewhere\n");
    });
    const page = await r.views.listTree(undefined, { parent: "notes" });
    expect(page.rows.map((row) => row.id).sort()).toEqual(["notes/deep", "notes/tea.md"]);
    expect(page.rows.every((row) => row.parent === "notes")).toBe(true);
    const folders = await r.views.list(WIKI_FOLDER_TYPE, { parent: "notes" });
    expect(folders.rows.map((row) => row.id)).toEqual(["notes/deep"]);
    const notes = await r.views.list(WIKI_NOTE_TYPE, { parent: "notes" });
    expect(notes.rows.map((row) => row.id)).toEqual(["notes/tea.md"]);
  });

  test("a note shows its content, its backlinks and its untrusted mark", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "notes", "tea.md"), "# Tea\n\nGreen tea. See [[other]].\n");
      file(join(wiki, "other.md"), "# Other\n\nSee [[notes/tea|Tea]].\n");
      file(
        join(wiki, "untrusted.md"),
        "---\nuntrusted: true\n---\n\n# Untrusted\n\nSee [Tea](notes/tea.md).\n",
      );
    });
    const object = await r.views.get(`${WIKI_NOTE_TYPE}:notes/tea.md`);
    expect(object.actions).toEqual([]);
    expect(object.row).toMatchObject({ id: "notes/tea.md", title: "Tea", state: "open" });
    expect(object.row.mark).toBeUndefined();
    expect(object.sections.map((section) => section.id)).toEqual([
      WIKI_CONTENT_SECTION,
      WIKI_BACKLINKS_SECTION,
      "history",
    ]);

    const content = await r.views.section(object.id, WIKI_CONTENT_SECTION);
    expect(content.markdown).toContain("Green tea. See [[other]].");
    expect(content.data?.["links"]).toMatchObject([
      { target: "other", kind: "wikilink", object: "note:other.md" },
    ]);

    const backlinks = await r.views.section(object.id, WIKI_BACKLINKS_SECTION);
    expect(backlinks.markdown).toContain("[Other](operad://objects/note%3Aother.md)");
    expect(backlinks.markdown).toContain("[Untrusted](operad://objects/note%3Auntrusted.md)");
    expect(backlinks.markdown).toContain("(untrusted)");
    expect(backlinks.data?.["backlinks"]).toMatchObject([
      { object: "note:other.md", path: "other.md", untrusted: false },
      { object: "note:untrusted.md", path: "untrusted.md", untrusted: true },
    ]);

    const untrusted = await r.views.list(WIKI_NOTE_TYPE, { root: true });
    const row = untrusted.rows.find((entry) => entry.id === "untrusted.md");
    expect(row?.note).toContain("(untrusted)");
    expect(row?.mark).toBeUndefined();
  });

  test("a note with no backlinks has no Backlinks section", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "alone.md"), "# Alone\n");
    });
    const object = await r.views.get(`${WIKI_NOTE_TYPE}:alone.md`);
    expect(object.sections.map((section) => section.id)).toEqual([WIKI_CONTENT_SECTION, "history"]);
  });

  test("a missing note is not found", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "there.md"), "# There\n");
    });
    await expect(r.views.get(`${WIKI_NOTE_TYPE}:missing.md`)).rejects.toMatchObject({
      name: "ViewError",
      kind: "not-found",
    });
  });

  test("a path outside the wiki is refused", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "inside.md"), "# Inside\n");
    });
    file(join(r.home, "outside.md"), "# Outside\n");
    await expect(r.views.get(`${WIKI_NOTE_TYPE}:../outside.md`)).rejects.toMatchObject({
      name: "ViewError",
      kind: "args",
    });
    await expect(r.views.get(`${WIKI_NOTE_TYPE}:/tmp/outside.md`)).rejects.toMatchObject({
      name: "ViewError",
      kind: "args",
    });
  });

  test("the links in a note resolve to the object ids a client opens", async () => {
    const r = rig((wiki) => {
      file(
        join(wiki, "notes", "tea.md"),
        "# Tea\n\n[[other]] and [Coffee](deep/coffee.md#Beans) and [[missing]].\n",
      );
      file(join(wiki, "notes", "deep", "coffee.md"), "# Coffee\n");
      file(join(wiki, "other.md"), "# Other\n");
    });
    const object = await r.views.get(`${WIKI_NOTE_TYPE}:notes/tea.md`);
    const content = await r.views.section(object.id, WIKI_CONTENT_SECTION);
    expect(content.data?.["links"]).toMatchObject([
      { target: "other", kind: "wikilink", object: "note:other.md" },
      { target: "deep/coffee.md", heading: "Beans", kind: "markdown", object: "note:notes/deep/coffee.md" },
      { target: "missing", kind: "wikilink" },
    ]);
  });

  test("a large note is paged by the section read", async () => {
    const body = `# Long\n\n${"line of the long note\n".repeat(
      Math.ceil((WIKI_PAGE_CHARS * 2) / "line of the long note\n".length),
    )}`;
    const r = rig((wiki) => {
      file(join(wiki, "long.md"), body);
    });
    const object = await r.views.get(`${WIKI_NOTE_TYPE}:long.md`);
    const first = await r.views.section(object.id, WIKI_CONTENT_SECTION);
    expect(first.pages?.length).toBeGreaterThan(1);
    expect(first.next).toBe("1");
    const second = await r.views.section(object.id, WIKI_CONTENT_SECTION, first.next);
    expect(second.markdown.length).toBeGreaterThan(0);
    expect(second.markdown).not.toBe(first.markdown);
  });

  test("only the wiki is listed, not a bot's memory", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "shared.md"), "# Shared\n");
    });
    file(join(r.home, "bot", "default", "memory", "private.md"), "# Private\n");
    const page = await r.views.list(WIKI_NOTE_TYPE, { root: true });
    expect(page.rows.map((row) => row.id)).toEqual(["shared.md"]);
  });
});
