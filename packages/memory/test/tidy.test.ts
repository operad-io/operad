import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry, isRecord } from "@operad-io/engine";
import {
  TIDY_ORIGIN,
  applyAppendOnly,
  createMemoryPlugin,
  ensureMemoryLayout,
  ensureRepository,
  memoryGit,
  memoryTidyState,
  rewriteDrop,
  tidyCommitForChat,
  tidyCommitSummary,
} from "../src/index.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-tidy-"));
  roots.push(root);
  return join(root, "home");
}

function commit(dir: string, message: string): void {
  ensureRepository(dir);
  const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
  expect(memoryGit(dir, [...identity, "add", "-A"]).ok).toBe(true);
  expect(memoryGit(dir, [...identity, "commit", "--allow-empty", "--no-verify", "-m", message]).ok).toBe(true);
}

describe("the memory tidy's check", () => {
  test("a fresh memory has no work, a new note is work, and the index over its limit is work", async () => {
    const h = await home();
    const memory = join(h, "bot", "default", "memory");
    mkdirSync(memory, { recursive: true });
    ensureMemoryLayout(memory);
    expect(memoryTidyState(memory)).toMatchObject({ notes: [], indexOver: false });

    mkdirSync(join(memory, "topics"), { recursive: true });
    writeFileSync(join(memory, "topics", "tea.md"), "likes tea\n");
    expect(memoryTidyState(memory).notes).toEqual(["topics/tea.md"]);

    writeFileSync(join(memory, "index.md"), `# Memory index\n\n${"- [x](topics/tea.md)\n".repeat(500)}`);
    expect(memoryTidyState(memory).indexOver).toBe(true);
  });

  test("after a tidy commit only what changed since it is work", async () => {
    const h = await home();
    const memory = join(h, "bot", "default", "memory");
    mkdirSync(join(memory, "topics"), { recursive: true });
    ensureMemoryLayout(memory);
    writeFileSync(join(memory, "topics", "tea.md"), "likes tea\n");
    commit(memory, `tidy: bot default, chat C-1`);
    expect(memoryTidyState(memory).notes).toEqual([]);

    writeFileSync(join(memory, "topics", "tea.md"), "likes green tea\n");
    writeFileSync(join(memory, "topics", "coffee.md"), "likes coffee\n");
    const state = memoryTidyState(memory);
    expect(state.baseline).toBeString();
    expect(state.since).toBeNumber();
    expect(state.notes).toEqual(["topics/coffee.md", "topics/tea.md"]);
  });

  test("a tidy commit is found for its own chat, not one whose id has it as a prefix", async () => {
    const h = await home();
    const memory = join(h, "bot", "default", "memory");
    mkdirSync(memory, { recursive: true });
    ensureMemoryLayout(memory);
    commit(memory, "tidy: bot default, chat C-1");
    const one = memoryGit(memory, ["rev-parse", "HEAD"]).out;
    commit(memory, "tidy: bot default, chat C-12");
    const twelve = memoryGit(memory, ["rev-parse", "HEAD"]).out;
    const repository = ensureRepository(memory);

    expect(tidyCommitForChat(repository, memory, "C-1")).toBe(one);
    expect(tidyCommitForChat(repository, memory, "C-12")).toBe(twelve);
  });
});

describe("the void-rewrite guard", () => {
  test("a rewrite that drops at least a quarter of the old index entries is void, and append only keeps them", async () => {
    const h = await home();
    const memory = join(h, "bot", "default", "memory");
    mkdirSync(memory, { recursive: true });
    ensureMemoryLayout(memory);
    writeFileSync(
      join(memory, "index.md"),
      [
        "# Memory index",
        "- [one](topics/one.md): first",
        "- [two](topics/two.md): second",
        "- [three](topics/three.md): third",
        "- [four](topics/four.md): fourth",
        "",
      ].join("\n"),
    );
    commit(memory, `tidy: bot default, chat C-1`);
    const repository = ensureRepository(memory);
    const baseline = memoryTidyState(memory).baseline;
    if (baseline === undefined) throw new Error("no tidy commit");

    writeFileSync(
      join(memory, "index.md"),
      ["# Memory index", "- [one](topics/one.md): first", "- [two](topics/two.md): second", "- [five](topics/five.md): fifth", ""].join("\n"),
    );
    expect(rewriteDrop(repository, memory, baseline)).toEqual({ before: 4, removed: 2, voided: true });

    const changed = applyAppendOnly(repository, memory, baseline);
    expect(changed).toContain("index.md");
    const index = readFileSync(join(memory, "index.md"), "utf8");
    expect(index).toContain("[three](topics/three.md): third");
    expect(index).toContain("[four](topics/four.md): fourth");
    expect(index).toContain("[five](topics/five.md): fifth");
  });

  test("a tidy chat's commit voids the rewrite, keeps the old entries and records why", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-tidy-commit-"));
    roots.push(root);
    const h = join(root, "home");
    const cwd = join(h, "bot", "default");
    const memory = join(cwd, "memory");
    mkdirSync(memory, { recursive: true });
    ensureMemoryLayout(memory);
    writeFileSync(
      join(memory, "index.md"),
      [
        "# Memory index",
        "- [one](topics/one.md): first",
        "- [two](topics/two.md): second",
        "- [three](topics/three.md): third",
        "- [four](topics/four.md): fourth",
        "",
      ].join("\n"),
    );
    commit(memory, `tidy: bot default, chat C-0`);

    const store = new MemoryPluginStore({ root: join(root, "store") });
    const registry = new PluginRegistry([createMemoryPlugin()], {
      home: h,
      cwd: root,
      store,
      settings: { memory: {} },
      onLog: () => undefined,
    });
    await store.put(
      "chat",
      "C-1",
      { parent: "bot:default", cwd, title: "Memory tidy", scheduled: { bot: "default", entry: TIDY_ORIGIN } },
      "test",
    );
    writeFileSync(
      join(memory, "index.md"),
      ["# Memory index", "- [one](topics/one.md): first", "- [two](topics/two.md): second", ""].join("\n"),
    );
    const outcome = await registry.runStep("memory/commit", { chat: "C-1" }, {
      runId: "run-tidy",
      object: { type: "chat", id: "C-1", data: (await store.get("chat", "C-1"))?.data ?? {} },
      params: null,
    });
    expect(outcome.result).toBe("done");
    const index = readFileSync(join(memory, "index.md"), "utf8");
    expect(index).toContain("[three](topics/three.md): third");
    expect(index).toContain("[four](topics/four.md): fourth");

    const log = memoryGit(memory, ["log", "-1", "--format=%B"]);
    expect(log.out).toContain("tidy: bot default, chat C-1");
    expect(log.out).toContain("append only:");
    const hash = memoryGit(memory, ["rev-parse", "HEAD"]).out;
    expect(tidyCommitSummary(ensureRepository(memory), hash).voided).toBe(true);
    const fact = store.facts().find((item) => item.type === "memory.tidy");
    expect(fact).toBeDefined();
    expect(isRecord(fact?.data) && fact.data["ok"]).toBe(true);
  });
});
