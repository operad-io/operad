import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkReport } from "../src/link-report.ts";
import { MemorySearch, searchDatabasePath } from "../src/search/service.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

interface ReportRig {
  readonly home: string;
  readonly wiki: string;
  readonly search: MemorySearch;
}

function rig(): ReportRig {
  const root = mkdtempSync(join(tmpdir(), "memory-link-report-"));
  roots.push(root);
  const home = join(root, "home");
  const wiki = join(home, "wiki");
  mkdirSync(wiki, { recursive: true });
  mkdirSync(join(home, "bot", "default", "memory"), { recursive: true });
  return { home, wiki, search: new MemorySearch(home, {}, { file: searchDatabasePath(home) }) };
}

describe("the link report a tidy reads", () => {
  test("a fixture wiki gives broken links with their line, orphans, wanted targets and unlinked mentions", async () => {
    const r = rig();
    file(join(r.wiki, "index.md"), "# Index\n\n[[a]]\n[[missing-one]]\n");
    file(
      join(r.wiki, "notes", "a.md"),
      "# Alpha\n\n[[b]]\n[[missing-one]]\n[[missing-wanted]]\n",
    );
    file(join(r.wiki, "notes", "b.md"), "# Beta\n\n[[a]]\n[[missing-wanted]]\n");
    file(join(r.wiki, "notes", "c.md"), "# Gamma\n\n[[missing-wanted]]\n");
    file(join(r.wiki, "notes", "d.md"), "# Delta\n\nAlpha is named here without a link.\n");
    file(join(r.wiki, "log", "2026-01-01.md"), "# Log\n");
    file(join(r.wiki, "_about.md"), "# About\n");
    await r.search.refresh();

    const report = linkReport(r.search, { scope: "wiki" });
    expect(report.broken).toEqual([
      { path: "index.md", line: 4, target: "missing-one" },
      { path: "notes/a.md", line: 4, target: "missing-one" },
      { path: "notes/a.md", line: 5, target: "missing-wanted" },
      { path: "notes/b.md", line: 4, target: "missing-wanted" },
      { path: "notes/c.md", line: 3, target: "missing-wanted" },
    ]);
    expect(report.orphans).toEqual(["notes/c.md", "notes/d.md"]);
    expect(report.wanted).toEqual([{ target: "missing-wanted", notes: 3 }]);
    expect(report.unlinked).toEqual([
      { path: "notes/d.md", title: "Alpha", target: "notes/a.md" },
    ]);
    r.search.close();
  });

  test("a target is wanted only when three different notes link to it", async () => {
    const r = rig();
    file(join(r.wiki, "a.md"), "# A\n\n[[wanted]]\n");
    file(join(r.wiki, "b.md"), "# B\n\n[[wanted]] [[wanted]]\n");
    await r.search.refresh();
    expect(linkReport(r.search, { scope: "wiki" }).wanted).toEqual([]);

    file(join(r.wiki, "c.md"), "# C\n\n[[wanted]]\n");
    await r.search.refresh();
    expect(linkReport(r.search, { scope: "wiki" }).wanted).toEqual([
      { target: "wanted", notes: 3 },
    ]);
    r.search.close();
  });

  test("the index, the log and a directory description are never orphans", async () => {
    const r = rig();
    file(join(r.wiki, "index.md"), "# Index\n");
    file(join(r.wiki, "log", "today.md"), "# Today\n");
    file(join(r.wiki, "notes", "_about.md"), "# Notes\n");
    file(join(r.wiki, "notes", "orphan.md"), "# Orphan\n");
    await r.search.refresh();

    expect(linkReport(r.search, { scope: "wiki" }).orphans).toEqual(["notes/orphan.md"]);
    r.search.close();
  });

  test("a title a note already links to is not an unlinked mention", async () => {
    const r = rig();
    file(join(r.wiki, "a.md"), "# Alpha\n");
    file(join(r.wiki, "b.md"), "# Beta\n\n[[a]] also names Alpha in the text.\n");
    await r.search.refresh();

    expect(linkReport(r.search, { scope: "wiki" }).unlinked).toEqual([]);
    r.search.close();
  });

  test("unlinked mentions stop at the cap", async () => {
    const r = rig();
    const lines = ["# Source", ""];
    for (let index = 1; index <= 25; index += 1) {
      const name = String(index).padStart(2, "0");
      file(join(r.wiki, "t", `${name}.md`), `# Page ${name}\n`);
      lines.push(`Page ${name}`);
    }
    file(join(r.wiki, "source.md"), `${lines.join("\n")}\n`);
    await r.search.refresh();

    const report = linkReport(r.search, { scope: "wiki" });
    expect(report.unlinked).toHaveLength(20);
    expect(report.unlinked[0]).toEqual({
      path: "source.md",
      title: "Page 01",
      target: "t/01.md",
    });
    expect(report.unlinked.at(-1)?.target).toBe("t/20.md");
    r.search.close();
  });
});
