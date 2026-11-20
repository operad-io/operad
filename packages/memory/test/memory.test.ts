import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_INDEX_MAX,
  MEMORY_PLUGIN,
  MEMORY_SETTINGS,
  MEMORY_SKILL_DIR,
  createMemoryPlugin,
  ensureMemoryLayout,
  ensureRepository,
  ensureWiki,
  expandMemoryPath,
  memoryEnabled,
  memoryGit,
  memoryNotes,
  wikiDirectory,
  wikiDirectoryOfHome,
} from "../src/index.ts";

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-test-"));
  roots.push(root);
  return join(root, "home");
}

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function commitCount(dir: string): number {
  return Number(memoryGit(dir, ["rev-list", "--count", "HEAD"]).out);
}

describe("the memory settings", () => {
  test("the wiki directory is an editable setting with a title", () => {
    const declared = createMemoryPlugin();
    expect(declared.name).toBe(MEMORY_PLUGIN);
    expect(declared.settings).toEqual(MEMORY_SETTINGS);
    const wiki = MEMORY_SETTINGS.properties?.["wikiDir"];
    expect(wiki).toMatchObject({ type: "string", editable: true, title: "Wiki directory", default: "wiki" });
  });

  test("the schema file carries the title the plugin declares", () => {
    const file = JSON.parse(readFileSync(join(import.meta.dir, "..", "memory.schema.json"), "utf8")) as {
      properties?: Record<string, { title?: string; default?: string }>;
    };
    expect(file.properties?.["wikiDir"]?.title).toBe("Wiki directory");
    expect(file.properties?.["wikiDir"]?.default).toBe("wiki");
  });

  test("the default is the wiki in the operad home, and a written path is expanded", async () => {
    const h = await home();
    expect(wikiDirectory(h)).toBe(join(h, "wiki"));
    expect(wikiDirectory(h, { wikiDir: "~/notes" }, "/Users/someone")).toBe("/Users/someone/notes");
    expect(wikiDirectory(h, { wikiDir: "notes/wiki" })).toBe(join(h, "notes", "wiki"));
    expect(expandMemoryPath("~", h, "/Users/someone")).toBe("/Users/someone");
  });

  test("the home's config names the wiki, and says whether the plugin is enabled", async () => {
    const h = await home();
    expect(memoryEnabled(h)).toBe(false);
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, "config.json"), JSON.stringify({ plugins: { memory: { settings: { wikiDir: "~/vault" } } } }));
    expect(memoryEnabled(h)).toBe(true);
    expect(wikiDirectoryOfHome(h, "/Users/someone")).toBe("/Users/someone/vault");
    writeFileSync(join(h, "config.json"), JSON.stringify({ plugins: { memory: { enabled: false } } }));
    expect(memoryEnabled(h)).toBe(false);
    writeFileSync(join(h, "config.json"), JSON.stringify({ plugins: { memory: "@operad-io/memory" } }));
    expect(memoryEnabled(h)).toBe(true);
  });

  test("the memory skill is shipped with the package", () => {
    expect(existsSync(join(MEMORY_SKILL_DIR, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(MEMORY_SKILL_DIR, "SKILL.md"), "utf8")).toContain("name: memory");
  });
});

describe("the wiki directory", () => {
  test("is created when missing, with a git repository", async () => {
    const h = await home();
    const wiki = join(h, "wiki");
    expect(existsSync(wiki)).toBe(false);
    const made = ensureWiki(h);
    expect(made).toMatchObject({ path: wiki, root: wiki, created: true });
    expect(existsSync(join(wiki, ".git"))).toBe(true);
  });

  test("an existing directory that is no repository gets one and keeps its files", async () => {
    const h = await home();
    const wiki = join(h, "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "note.md"), "mine\n");
    const made = ensureWiki(h, { wikiDir: wiki });
    expect(made.created).toBe(true);
    expect(readFileSync(join(wiki, "note.md"), "utf8")).toBe("mine\n");
    expect(memoryGit(wiki, ["rev-parse", "--show-toplevel"]).out).toBe(realpathSync(wiki));
  });

  test("a directory that is already a repository is used as it is, never re-initialised", async () => {
    const h = await home();
    const wiki = join(h, "vault");
    mkdirSync(wiki, { recursive: true });
    expect(memoryGit(wiki, ["init", "--quiet", "-b", "notes"]).ok).toBe(true);
    writeFileSync(join(wiki, "note.md"), "mine\n");
    expect(
      memoryGit(wiki, ["-c", "user.name=A", "-c", "user.email=a@example.com", "add", "-A"]).ok,
    ).toBe(true);
    expect(
      memoryGit(wiki, ["-c", "user.name=A", "-c", "user.email=a@example.com", "commit", "-m", "mine"]).ok,
    ).toBe(true);
    const before = commitCount(wiki);
    const made = ensureWiki(h, { wikiDir: wiki });
    expect(made).toMatchObject({ root: wiki, created: false });
    expect(memoryGit(wiki, ["rev-parse", "--abbrev-ref", "HEAD"]).out).toBe("notes");
    expect(commitCount(wiki)).toBe(before);
  });

  test("a directory inside someone else's repository stays part of that repository", async () => {
    const h = await home();
    const repo = join(h, "notes");
    mkdirSync(repo, { recursive: true });
    expect(memoryGit(repo, ["init", "--quiet"]).ok).toBe(true);
    const wiki = join(repo, "wiki");
    mkdirSync(wiki, { recursive: true });
    const made = ensureWiki(h, { wikiDir: wiki });
    expect(made).toMatchObject({ root: realpathSync(repo), created: false });
    expect(existsSync(join(wiki, ".git"))).toBe(false);
  });
});

describe("the memory layout", () => {
  test("the index, the daily log and the instructions are made, and nothing is overwritten", async () => {
    const h = await home();
    const memory = join(h, "bot", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "index.md"), "my index\n");
    ensureMemoryLayout(memory);
    expect(readFileSync(join(memory, "index.md"), "utf8")).toBe("my index\n");
    expect(existsSync(join(memory, "log"))).toBe(true);
    expect(readFileSync(join(memory, "instructions.md"), "utf8")).toContain("Instructions");
  });

  test("a bot's memory is a repository of its own", async () => {
    const h = await home();
    const memory = join(h, "bot", "reader", "memory");
    const made = ensureRepository(memory);
    expect(made.root).toBe(memory);
    expect(existsSync(join(memory, ".git"))).toBe(true);
    // Reading it again makes nothing new.
    expect(ensureRepository(memory)).toMatchObject({ root: memory, created: false });
  });
});

describe("the plugin declaration", () => {
  test("it declares its settings and one step", () => {
    const plugin = createMemoryPlugin();
    expect(plugin.name).toBe("memory");
    expect(plugin.kind).toBe("domain");
    expect(plugin.steps?.map((step) => step.name)).toEqual(["commit"]);
    expect(plugin.settings).toEqual(MEMORY_SETTINGS);
  });
});

describe("the files a bot chat carries as notes", () => {
  test("the index is cut at 8,000 characters and the instructions are whole", async () => {
    const h = await home();
    const memory = join(h, "bot", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "index.md"), "index\n");
    writeFileSync(join(memory, "instructions.md"), "instructions\n");
    const notes = memoryNotes(memory);
    expect(MEMORY_INDEX_MAX).toBe(8000);
    expect(notes).toEqual([
      { name: "memory/index.md", path: join(memory, "index.md"), maxChars: MEMORY_INDEX_MAX },
      { name: "memory/instructions.md", path: join(memory, "instructions.md") },
    ]);
  });

  test("a file that is not there yet is left out", async () => {
    const h = await home();
    const memory = join(h, "bot", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "index.md"), "index\n");
    expect(memoryNotes(memory).map((note) => note.name)).toEqual(["memory/index.md"]);
  });
});
