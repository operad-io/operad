import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSearchBackend } from "../src/search/backend.ts";
import { parseNoteLinks, resolveNoteLink } from "../src/links.ts";
import { MemorySearch, searchDatabasePath } from "../src/search/service.ts";
import type { NoteLink } from "../src/search/types.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function wikilink(target: string): NoteLink {
  return { target, kind: "wikilink" };
}

function file(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** Makes an index look like one built before the link table, or with an older one. */
function forgetLinks(database: string, mode: "missing" | "older"): void {
  const db = new Database(database);
  try {
    db.run("DELETE FROM search_links");
    if (mode === "missing") db.run("DELETE FROM search_meta WHERE key = 'links'");
    else db.run("UPDATE search_meta SET value = '0' WHERE key = 'links'");
  } finally {
    db.close();
  }
}

interface LinkRig {
  readonly root: string;
  readonly home: string;
  readonly wiki: string;
  readonly search: MemorySearch;
}

function rig(): LinkRig {
  const root = mkdtempSync(join(tmpdir(), "memory-links-"));
  roots.push(root);
  const home = join(root, "home");
  const wiki = join(home, "wiki");
  mkdirSync(wiki, { recursive: true });
  mkdirSync(join(home, "bot", "default", "memory"), { recursive: true });
  return { root, home, wiki, search: new MemorySearch(home, {}, { file: searchDatabasePath(home) }) };
}

describe("the links a note writes", () => {
  test("a wikilink keeps its target and heading, and drops its display text", () => {
    const links = parseNoteLinks(
      "[[tea]] [[tea|Tea]] [[tea#Brewing]] [[notes/tea#Brewing|the tea]]",
    );
    expect(links).toEqual([
      { target: "tea", kind: "wikilink" },
      { target: "tea", kind: "wikilink" },
      { target: "tea", heading: "Brewing", kind: "wikilink" },
      { target: "notes/tea", heading: "Brewing", kind: "wikilink" },
    ]);
  });

  test("an escaped pipe in a table separates the target from the display text", () => {
    const links = parseNoteLinks("| Page | Note |\n|---|---|\n| x | [[notes/tea\\|Tea]] |\n");
    expect(links).toEqual([{ target: "notes/tea", kind: "wikilink" }]);
  });

  test("a relative markdown link is percent-decoded and keeps its heading", () => {
    const links = parseNoteLinks(
      "[the tea](notes/tea.md#Brewing) and [mine](notes/my%20tea.md)",
    );
    expect(links).toEqual([
      { target: "notes/tea.md", heading: "Brewing", kind: "markdown" },
      { target: "notes/my tea.md", kind: "markdown" },
    ]);
  });

  test("a markdown target may have a space or be enclosed in angle brackets", () => {
    const links = parseNoteLinks(
      "[tea](notes/my tea.md) and [other](<notes/other page.md#Top>)",
    );
    expect(links).toEqual([
      { target: "notes/my tea.md", kind: "markdown" },
      { target: "notes/other page.md", heading: "Top", kind: "markdown" },
    ]);
  });

  test("a wikilink may name a heading in its own note", () => {
    expect(parseNoteLinks("[[#Brewing]]")).toEqual([
      { target: "", heading: "Brewing", kind: "wikilink" },
    ]);
    expect(
      resolveNoteLink(
        "notes/tea.md",
        { target: "", heading: "Brewing", kind: "wikilink" },
        ["notes/tea.md"],
      ),
    ).toBe("notes/tea.md");
  });

  test("a bare percent is kept as written instead of throwing", () => {
    expect(parseNoteLinks("[odd](100%.md)")).toEqual([{ target: "100%.md", kind: "markdown" }]);
  });

  test("code blocks and inline code are not links", () => {
    const text = [
      "`[[inline]]` and [[real]]",
      "",
      "```md",
      "[[fenced]] and [also](fenced.md)",
      "```",
      "",
      "~~~~",
      "[[tilde]]",
      "~~~~",
    ].join("\n");
    expect(parseNoteLinks(text)).toEqual([{ target: "real", kind: "wikilink" }]);
  });

  test("an indented code block is not links, but an indented paragraph line is", () => {
    const text = [
      "    [[indented]]",
      "\t[[tabbed]]",
      "",
      "prose",
      "    [[continuation]]",
    ].join("\n");
    expect(parseNoteLinks(text)).toEqual([{ target: "continuation", kind: "wikilink" }]);
  });

  test("external links and image embeds are not note links", () => {
    const text = [
      "[web](https://example.com/a.md)",
      "[mail](mailto:a@example.com)",
      "[other](//example.com/x.md)",
      "![picture](picture.png)",
    ].join(" ");
    expect(parseNoteLinks(text)).toEqual([]);
  });
});

describe("how a link resolves", () => {
  test("a path from the scope root wins over a file of the same name", () => {
    const notes = ["tea.md", "notes/tea.md", "notes/a.md"];
    expect(resolveNoteLink("notes/a.md", wikilink("tea"), notes)).toBe("tea.md");
  });

  test("a file name is found with or without .md", () => {
    const notes = ["notes/tea.md", "notes/a.md"];
    expect(resolveNoteLink("notes/a.md", wikilink("tea"), notes)).toBe("notes/tea.md");
    expect(resolveNoteLink("notes/a.md", wikilink("tea.md"), notes)).toBe("notes/tea.md");
  });

  test("among files of the same name the one nearest the source note wins", () => {
    const notes = ["a/note.md", "a/b/note.md", "a/b/c/note.md", "a/b/x/source.md"];
    expect(resolveNoteLink("a/b/x/source.md", wikilink("note"), notes)).toBe("a/b/note.md");
  });

  test("a markdown target not at the root is taken relative to the source note", () => {
    // The nearest `tea.md` is the one beside the source; `../tea.md` is the other.
    const notes = ["notes/tea.md", "notes/sub/tea.md", "notes/sub/a.md"];
    expect(
      resolveNoteLink("notes/sub/a.md", { target: "../tea.md", kind: "markdown" }, notes),
    ).toBe("notes/tea.md");
    expect(resolveNoteLink("notes/sub/a.md", wikilink("tea"), notes)).toBe("notes/sub/tea.md");
  });

  test("a target with a path is not reduced to a file name", () => {
    const notes = ["tea.md", "other/tea.md", "notes/a.md"];
    expect(resolveNoteLink("notes/a.md", wikilink("other/tea"), notes)).toBe("other/tea.md");
    expect(resolveNoteLink("notes/a.md", wikilink("elsewhere/tea"), notes)).toBeUndefined();
    expect(
      resolveNoteLink("notes/a.md", { target: "elsewhere/tea.md", kind: "markdown" }, notes),
    ).toBeUndefined();
    expect(
      resolveNoteLink("notes/a.md", { target: "tea.md", kind: "markdown" }, ["other/tea.md"]),
    ).toBeUndefined();
  });

  test("a target nobody wrote resolves to nothing", () => {
    expect(resolveNoteLink("a.md", wikilink("later"), ["a.md"])).toBeUndefined();
    expect(
      resolveNoteLink("a.md", { target: "../../up.md", kind: "markdown" }, ["a.md"]),
    ).toBeUndefined();
  });
});

describe("the link table in the backend", () => {
  test("removing a document drops its links and leaves the links to it unresolved", () => {
    const backend = new SqliteSearchBackend({ file: ":memory:" });
    try {
      const note = (name: string, target: string) => ({
        id: `wiki:${name}.md`,
        scope: "wiki" as const,
        owner: "",
        file: `/${name}.md`,
        path: `${name}.md`,
        directory: "",
        name: `${name}.md`,
        title: name,
        text: "",
        fields: {},
        lineCount: 0,
        digest: name,
        links: [{ target, kind: "wikilink" as const }],
      });
      backend.put(note("a", "b"));
      backend.put(note("b", "a"));
      backend.setLinkTargets([
        { docId: "wiki:a.md", ordinal: 0, targetId: "wiki:b.md" },
        { docId: "wiki:b.md", ordinal: 0, targetId: "wiki:a.md" },
      ]);
      backend.remove("wiki:b.md");
      expect(backend.allLinks()).toEqual([
        { docId: "wiki:a.md", ordinal: 0, target: "b", kind: "wikilink" },
      ]);
    } finally {
      backend.close();
    }
  });
});

describe("the link table", () => {
  test("a read lists the notes that link to it, with the line and excerpt", async () => {
    const r = rig();
    file(join(r.wiki, "notes", "tea.md"), "# Tea\n\nGreen tea brews cooler.\n");
    file(join(r.wiki, "index.md"), "# Index\n\n- [[notes/tea|Tea]]\n");
    file(
      join(r.wiki, "notes", "about.md"),
      "---\nuntrusted: true\n---\n\nWe discussed [[notes/tea]] last week.\n",
    );
    await r.search.refresh();

    const read = r.search.read({ id: "wiki:notes/tea.md" });
    expect(read.backlinks).toHaveLength(2);
    expect(read.backlinks[0]).toMatchObject({
      id: "wiki:index.md",
      path: "index.md",
      title: "Index",
      target: "notes/tea",
      kind: "wikilink",
      line: 3,
      untrusted: false,
    });
    expect(read.backlinks[0]?.excerpt).toContain("[[notes/tea|Tea]]");
    expect(read.backlinks[1]).toMatchObject({
      id: "wiki:notes/about.md",
      path: "notes/about.md",
      title: "about",
      target: "notes/tea",
      kind: "wikilink",
      line: 2,
      untrusted: true,
    });
    expect(read.backlinks[1]?.excerpt).toContain("We discussed [[notes/tea]]");

    file(join(r.wiki, "alone.md"), "# Alone\n\nNothing points here.\n");
    await r.search.refresh();
    expect(r.search.read({ id: "wiki:alone.md" }).backlinks).toEqual([]);
    r.search.close();
  });

  test("a read leaves out a note's link to itself and keeps a link's place after code", async () => {
    const r = rig();
    file(
      join(r.wiki, "self.md"),
      ["# Self", "", "```", "[[self]]", "```", "", "[[self]] and [[#Self]]", ""].join("\n"),
    );
    file(
      join(r.wiki, "code.md"),
      ["# Code", "", "```md", "[[target]]", "```", "", "then [[target]]", ""].join("\n"),
    );
    file(join(r.wiki, "target.md"), "# Target\n");
    await r.search.refresh();

    expect(r.search.read({ id: "wiki:self.md" }).backlinks).toEqual([]);
    expect(r.search.linksFrom("wiki:self.md")).toHaveLength(2);
    const back = r.search.read({ id: "wiki:target.md" }).backlinks;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ path: "code.md", line: 7 });
    expect(back[0]?.excerpt).toContain("then [[target]]");
    r.search.close();
  });

  test("links from a note, backlinks and unresolved targets come from the same index", async () => {
    const r = rig();
    file(
      join(r.wiki, "notes", "tea.md"),
      "# Tea\n\nsee [[notes/green]], [[notes/rooibos]] and [the index](index.md)\n",
    );
    file(join(r.wiki, "notes", "green.md"), "# Green\n\n[[notes/rooibos]]\n");
    file(join(r.wiki, "index.md"), "# Index\n\n- [[notes/tea|Tea]]\n- [missing](notes/rooibos.md)\n");
    await r.search.refresh();

    const from = r.search.linksFrom("wiki:notes/tea.md");
    expect(from).toHaveLength(3);
    expect(from[0]).toMatchObject({
      from: "wiki:notes/tea.md",
      fromPath: "notes/tea.md",
      to: "wiki:notes/green.md",
      toPath: "notes/green.md",
      target: "notes/green",
      kind: "wikilink",
    });
    expect(from[1]).toMatchObject({ target: "notes/rooibos", kind: "wikilink" });
    expect(from[1]?.to).toBeUndefined();
    expect(from[2]).toMatchObject({
      to: "wiki:index.md",
      target: "index.md",
      kind: "markdown",
    });

    const back = r.search.backlinks("wiki:notes/tea.md");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      from: "wiki:index.md",
      fromPath: "index.md",
      to: "wiki:notes/tea.md",
      target: "notes/tea",
      kind: "wikilink",
    });

    expect(r.search.unresolvedTargets({ scope: "wiki" })).toEqual([
      { target: "notes/rooibos", count: 2 },
      { target: "notes/rooibos.md", count: 1 },
    ]);
    r.search.close();
  });

  test("a link stays in the scope of the note that writes it", async () => {
    const r = rig();
    file(join(r.wiki, "index.md"), "# Index\n\n[[taste]]\n");
    const owner = join(r.home, "bot", "default");
    file(join(owner, "memory", "topics", "taste.md"), "# Taste\n\n[[index]]\n");
    await r.search.refresh();

    expect(r.search.linksFrom("wiki:index.md")[0]?.to).toBeUndefined();
    expect(r.search.linksFrom(`memory:${owner}:topics/taste.md`)[0]?.to).toBeUndefined();
    expect(r.search.unresolvedTargets()).toEqual([
      { target: "index", count: 1 },
      { target: "taste", count: 1 },
    ]);
    expect(r.search.orphanNotes().map((note) => note.path)).toEqual([
      "index.md",
      "topics/taste.md",
    ]);
    r.search.close();
  });

  test("a note no other note links to is an orphan", async () => {
    const r = rig();
    file(join(r.wiki, "a.md"), "# A\n\n[[b]]\n");
    file(join(r.wiki, "b.md"), "# B\n");
    file(join(r.wiki, "c.md"), "# C\n\n[[c]]\n");
    await r.search.refresh();

    const orphans = r.search.orphanNotes({ scope: "wiki" });
    expect(orphans.map((note) => note.path)).toEqual(["a.md", "c.md"]);
    expect(orphans.map((note) => note.id)).toEqual(["wiki:a.md", "wiki:c.md"]);
    r.search.close();
  });

  test("editing a note replaces the links it wrote", async () => {
    const r = rig();
    const note = join(r.wiki, "n.md");
    file(join(r.wiki, "a.md"), "# A\n");
    file(join(r.wiki, "b.md"), "# B\n");
    file(note, "# N\n\n[[a]]\n");
    await r.search.refresh();
    expect(r.search.linksFrom("wiki:n.md").map((link) => link.target)).toEqual(["a"]);

    file(note, "# N\n\nnow [[b]] and [[a]]\n");
    await r.search.refresh();
    expect(r.search.linksFrom("wiki:n.md").map((link) => link.target)).toEqual(["b", "a"]);
    expect(r.search.backlinks("wiki:a.md").map((link) => link.from)).toEqual(["wiki:n.md"]);

    r.search.close();
  });

  test("renaming a note points the links that named it at the new place", async () => {
    const r = rig();
    file(join(r.wiki, "notes", "index.md"), "# Index\n\n[[tea]]\n");
    file(join(r.wiki, "notes", "tea.md"), "# Tea\n");
    await r.search.refresh();
    expect(r.search.linksFrom("wiki:notes/index.md")[0]?.to).toBe("wiki:notes/tea.md");

    mkdirSync(join(r.wiki, "archive"), { recursive: true });
    renameSync(join(r.wiki, "notes", "tea.md"), join(r.wiki, "archive", "tea.md"));
    await r.search.refresh();

    const link = r.search.linksFrom("wiki:notes/index.md")[0];
    expect(link).toMatchObject({ to: "wiki:archive/tea.md", toPath: "archive/tea.md" });
    expect(r.search.backlinks("wiki:archive/tea.md").map((back) => back.from)).toEqual([
      "wiki:notes/index.md",
    ]);
    expect(r.search.backlinks("wiki:notes/tea.md")).toEqual([]);
    r.search.close();
  });

  test("a deleted note keeps the links to it, and drops the links it wrote", async () => {
    const r = rig();
    file(join(r.wiki, "index.md"), "# Index\n\n[[notes/green]]\n");
    file(join(r.wiki, "notes", "green.md"), "# Green\n\n[[notes/old]]\n");
    await r.search.refresh();
    expect(r.search.linksFrom("wiki:notes/green.md").map((link) => link.target)).toEqual([
      "notes/old",
    ]);

    unlinkSync(join(r.wiki, "notes", "green.md"));
    await r.search.refresh();

    expect(r.search.linksFrom("wiki:notes/green.md")).toEqual([]);
    expect(r.search.backlinks("wiki:notes/green.md")).toEqual([]);
    const unresolved = r.search.unresolvedTargets({ scope: "wiki" });
    expect(unresolved).toEqual([{ target: "notes/green", count: 1 }]);
    expect(r.search.linksFrom("wiki:index.md")[0]?.to).toBeUndefined();
    r.search.close();
  });

  test("a note written under a name somebody linked to takes those links", async () => {
    const r = rig();
    file(join(r.wiki, "index.md"), "# Index\n\n[[notes/rooibos]]\n");
    await r.search.refresh();
    expect(r.search.unresolvedTargets()).toEqual([{ target: "notes/rooibos", count: 1 }]);
    expect(r.search.backlinks("wiki:notes/rooibos.md")).toEqual([]);

    file(join(r.wiki, "notes", "rooibos.md"), "# Rooibos\n");
    await r.search.refresh();

    expect(r.search.unresolvedTargets()).toEqual([]);
    expect(r.search.backlinks("wiki:notes/rooibos.md").map((back) => back.from)).toEqual([
      "wiki:index.md",
    ]);
    r.search.close();
  });

  test("an index built before the link table fills it on the next refresh", async () => {
    const r = rig();
    file(join(r.wiki, "a.md"), "# A\n\n[[b]]\n");
    file(join(r.wiki, "b.md"), "# B\n");
    await r.search.refresh();
    expect(r.search.backlinks("wiki:b.md")).toHaveLength(1);
    r.search.close();

    forgetLinks(searchDatabasePath(r.home), "missing");

    const upgraded = new MemorySearch(r.home);
    try {
      await upgraded.refresh();
      expect(upgraded.linksFrom("wiki:a.md")[0]?.to).toBe("wiki:b.md");
      expect(upgraded.backlinks("wiki:b.md").map((back) => back.from)).toEqual(["wiki:a.md"]);
      expect(upgraded.orphanNotes({ scope: "wiki" }).map((note) => note.path)).toEqual(["a.md"]);
    } finally {
      upgraded.close();
    }
  });

  test("a link table from an older version is filled again from the notes", async () => {
    const r = rig();
    file(join(r.wiki, "a.md"), "# A\n\n[[b]]\n");
    file(join(r.wiki, "b.md"), "# B\n");
    await r.search.refresh();
    r.search.close();

    forgetLinks(searchDatabasePath(r.home), "older");

    const upgraded = new MemorySearch(r.home);
    try {
      await upgraded.refresh();
      expect(upgraded.backlinks("wiki:b.md")).toHaveLength(1);
    } finally {
      upgraded.close();
    }
  });

  test("a rebuilt index gives the same table", async () => {
    const r = rig();
    file(join(r.wiki, "a.md"), "# A\n\n[[b]] and [c](c.md#Top)\n");
    file(join(r.wiki, "b.md"), "# B\n\n[[missing]]\n");
    file(join(r.wiki, "c.md"), "# C\n");
    await r.search.refresh();
    const before = structuredClone(r.search.backend.allLinks());
    const beforeFrom = r.search.linksFrom("wiki:a.md");
    const beforeMissing = r.search.unresolvedTargets();
    expect(before.length).toBe(3);

    r.search.close();
    unlinkSync(searchDatabasePath(r.home));
    const again = new MemorySearch(r.home);
    try {
      await again.refresh();
      expect(again.backend.allLinks()).toEqual(before);
      expect(again.linksFrom("wiki:a.md")).toEqual(beforeFrom);
      expect(again.unresolvedTargets()).toEqual(beforeMissing);
    } finally {
      again.close();
    }
  });

  test("a rebuild for another tokenizer drops the old link table", async () => {
    const r = rig();
    file(join(r.wiki, "a.md"), "# A\n\n[[b]]\n");
    file(join(r.wiki, "b.md"), "# B\n");
    await r.search.refresh();
    expect(r.search.backend.allLinks()).toHaveLength(1);
    r.search.close();

    const rebuilt = new MemorySearch(r.home, {}, { tokenizer: "unicode61" });
    try {
      // Before a refresh the rebuilt index has no links: they were part of
      // what the tokenizer change threw away.
      expect(rebuilt.backend.allLinks()).toEqual([]);
      await rebuilt.refresh();
      expect(rebuilt.backend.allLinks()).toHaveLength(1);
    } finally {
      rebuilt.close();
    }
  });
});
