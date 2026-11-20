import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  ViewError,
  createViews,
  type ListOptions,
  type ListPage,
  type ObjectTypeDefinition,
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
  readonly store: CountingStore;
}

/** A store that counts its lists, so a read that scans the notes is visible. */
class CountingStore extends MemoryPluginStore {
  lists = 0;

  override list(type: string, options: ListOptions = {}): ListPage {
    this.lists += 1;
    return super.list(type, options);
  }
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
  const store = new CountingStore({ root: join(root, "plugins") });
  const registry = new PluginRegistry([createMemoryPlugin()], {
    home,
    cwd: root,
    store,
    settings: { memory: {} },
    onLog: () => undefined,
  });
  const views = createViews({ registry, store, home, onLog: () => undefined });
  return { home, wiki, views, store };
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

  test("a folder whose name ends in .md is a folder, not a note", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-wiki-md-folder-"));
    roots.push(root);
    const home = join(root, "home");
    file(join(home, "wiki", "topics.md", "tea.md"), "# Tea\n");
    const store = new MemoryPluginStore({ root: join(root, "plugins") });
    const plugin = createMemoryPlugin();
    const types: readonly ObjectTypeDefinition[] = plugin.objects ?? [];
    for (const type of types) await type.prepare?.({ store, home, settings: {} });
    const claim = async (type: string, id: string): Promise<string | undefined> => {
      const definition = types.find((entry) => entry.name === type);
      return definition?.resolve?.({ cwd: root, store }, type, id);
    };
    expect(await claim(WIKI_FOLDER_TYPE, "topics.md")).toBe("topics.md");
    expect(await claim(WIKI_NOTE_TYPE, "topics.md")).toBeUndefined();
  });

  test("a list does not build the search index", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "tea.md"), "# Tea\n");
    });
    await r.views.list(WIKI_NOTE_TYPE, { root: true });
    expect(existsSync(join(r.home, "store", "search.sqlite"))).toBe(false);
  });

  test("a section read does not list the note objects again", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "tea.md"), "# Tea\n\nSee [[other]].\n");
      file(join(wiki, "other.md"), "# Other\n");
    });
    const object = await r.views.get(`${WIKI_NOTE_TYPE}:tea.md`);
    const lists = r.store.lists;
    const content = await r.views.section(object.id, WIKI_CONTENT_SECTION);
    expect(content.data?.["links"]).toMatchObject([
      { target: "other", kind: "wikilink", object: "note:other.md" },
    ]);
    expect(r.store.lists).toBe(lists);
  });

  test("a note edited after its first read is projected before its next section", async () => {
    const r = rig((wiki) => {
      file(join(wiki, "tea.md"), "# Tea\n\nSee [[old]].\n");
      file(join(wiki, "old.md"), "# Old\n");
    });
    const object = await r.views.get(`${WIKI_NOTE_TYPE}:tea.md`);
    file(join(r.wiki, "new.md"), "# New\n");
    file(join(r.wiki, "tea.md"), "# Tea\n\nSee [[new]].\n");
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(r.wiki, "tea.md"), later, later);
    const content = await r.views.section(object.id, WIKI_CONTENT_SECTION);
    expect(content.data?.["links"]).toMatchObject([
      { target: "new", kind: "wikilink", object: "note:new.md" },
    ]);
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

  test("a bare id the wiki does not hold is not claimed by the wiki types", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-wiki-claim-"));
    roots.push(root);
    const home = join(root, "home");
    file(join(home, "wiki", "topics", "tea.md"), "# Tea\n");
    const store = new MemoryPluginStore({ root: join(root, "plugins") });
    const plugin = createMemoryPlugin();
    const types: readonly ObjectTypeDefinition[] = plugin.objects ?? [];
    for (const type of types) await type.prepare?.({ store, home, settings: {} });
    const claim = async (type: string, id: string): Promise<string | undefined> => {
      const definition = types.find((entry) => entry.name === type);
      return definition?.resolve?.({ cwd: root, store }, type, id);
    };
    // A task id is a valid relative path, but no wiki folder or note has it.
    // Claiming it would make every bare task id ambiguous next to the task type.
    expect(await claim(WIKI_FOLDER_TYPE, "T-0597-wiki-link-table")).toBeUndefined();
    expect(await claim(WIKI_NOTE_TYPE, "T-0597-wiki-link-table.md")).toBeUndefined();
    expect(await claim(WIKI_FOLDER_TYPE, "topics")).toBe("topics");
    expect(await claim(WIKI_NOTE_TYPE, "topics/tea.md")).toBe("topics/tea.md");
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
