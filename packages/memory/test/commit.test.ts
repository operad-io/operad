import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry, isRecord } from "@operad-io/engine";
import { createMemoryPlugin, memoryGit, parseNoteLinks, resolveNoteLink, withoutUntrustedLines } from "../src/index.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Rig {
  readonly home: string;
  readonly store: MemoryPluginStore;
  readonly registry: PluginRegistry;
  readonly cwd: string;
  run(chat: string, runId: string): Promise<{ readonly result: string; readonly data: Record<string, unknown> }>;
}

async function rig(wiki: string | undefined = undefined): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "memory-commit-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(home, "bot", "default");
  mkdirSync(cwd, { recursive: true });
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const settings = wiki === undefined ? {} : { wikiDir: wiki };
  const registry = new PluginRegistry([createMemoryPlugin()], {
    home,
    cwd: root,
    store,
    settings: { memory: settings },
    onLog: () => undefined,
  });
  return {
    home,
    store,
    registry,
    cwd,
    async run(chat, runId) {
      const stored = await store.get("chat", chat);
      const outcome = await registry.runStep("memory/commit", { chat }, {
        runId,
        ...(stored === undefined ? {} : { object: { type: "chat", id: chat, data: stored.data } }),
        params: null,
      });
      return { result: outcome.result, data: isRecord(outcome.data) ? (outcome.data as Record<string, unknown>) : {} };
    },
  };
}

async function botChat(r: Rig, id: string, bot = "default"): Promise<void> {
  await r.store.put("chat", id, { parent: `bot:${bot}`, cwd: r.cwd, title: "Test" }, "test");
}

function messages(dir: string): string[] {
  return memoryGit(dir, ["log", "--format=%s"]).out.split("\n").filter((line) => line.length > 0);
}

describe("a bot run is recorded in git", () => {
  test("one commit in the memory and one in the wiki, each naming the bot and the chat", async () => {
    const r = await rig();
    await botChat(r, "C-1");
    const memory = join(r.cwd, "memory");
    mkdirSync(join(memory, "topics"), { recursive: true });
    writeFileSync(join(memory, "topics", "taste.md"), "likes tea\n");
    mkdirSync(join(r.home, "wiki"), { recursive: true });
    writeFileSync(join(r.home, "wiki", "note.md"), "a note\n");

    const outcome = await r.run("C-1", "run-1");
    expect(outcome.result).toBe("done");
    expect(outcome.data["bot"]).toBe("default");
    expect(outcome.data["chat"]).toBe("C-1");

    expect(messages(memory)).toEqual(["memory: bot default, chat C-1"]);
    expect(messages(join(r.home, "wiki"))).toEqual(["wiki: bot default, chat C-1"]);
    expect(memoryGit(memory, ["status", "--porcelain"]).out).toBe("");
  });

  test("a second run that wrote nothing makes no commit", async () => {
    const r = await rig();
    await botChat(r, "C-1");
    const memory = join(r.cwd, "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "note.md"), "first\n");
    await r.run("C-1", "run-1");
    const before = messages(memory);
    const again = await r.run("C-1", "run-2");
    expect(again.result).toBe("done");
    expect(again.data["memory"]).toBeNull();
    expect(again.data["wiki"]).toBeNull();
    expect(messages(memory)).toEqual(before);
  });

  test("a note marked as untrusted is kept out of the index, and the note itself stays", async () => {
    const r = await rig();
    await botChat(r, "C-1");
    const memory = join(r.cwd, "memory");
    mkdirSync(join(memory, "topics"), { recursive: true });
    writeFileSync(join(memory, "topics", "from-web.md"), "---\nuntrusted: true\n---\n\nwhat a page said\n");
    writeFileSync(join(memory, "topics", "own.md"), "a correction a person made\n");
    writeFileSync(
      join(memory, "index.md"),
      "# Memory index\n\n- [Tea](topics/own.md): likes it\n- [Web](topics/from-web.md): a page said\n",
    );

    const outcome = await r.run("C-1", "run-1");
    expect(outcome.result).toBe("done");
    expect(outcome.data["unindexed"]).toContain("topics/from-web.md");
    const index = readFileSync(join(memory, "index.md"), "utf8");
    expect(index).toContain("](topics/own.md)");
    expect(index).not.toContain("from-web.md");
    expect(readFileSync(join(memory, "topics", "from-web.md"), "utf8")).toContain("what a page said");
  });

  test("an index line that links to an untrusted note with a wikilink is removed too", async () => {
    const r = await rig();
    await botChat(r, "C-1");
    const memory = join(r.cwd, "memory");
    mkdirSync(join(memory, "topics"), { recursive: true });
    writeFileSync(join(memory, "topics", "from-web.md"), "---\nuntrusted: true\n---\n\nwhat a page said\n");
    writeFileSync(join(memory, "topics", "own.md"), "a correction a person made\n");
    writeFileSync(
      join(memory, "index.md"),
      [
        "# Memory index",
        "",
        "- [[topics/from-web]]: a page said",
        "- [[topics/from-web|a page said]]: a page said",
        "- [[topics/from-web.md]]: a page said",
        "- [[from-web]]: a page said",
        "- [[from-web.md]]: a page said",
        "- [Web](topics/from-web): a page said",
        "| [[topics/from-web\\|a page said]] | a page said |",
        "- [[topics/own]]: a correction a person made",
        "- [[own]]: a correction a person made",
        "- [Own](topics/own): a correction a person made",
        "| [[topics/own\\|a correction]] | a correction a person made |",
        "",
      ].join("\n"),
    );

    const outcome = await r.run("C-1", "run-1");
    expect(outcome.result).toBe("done");
    const index = readFileSync(join(memory, "index.md"), "utf8");
    expect(index).not.toContain("from-web");
    expect(index).toContain("[[topics/own]]");
    expect(index).toContain("[[own]]");
    expect(index).toContain("](topics/own)");
    expect(index).toContain("| [[topics/own\\|a correction]] |");
  });

  test("a Markdown link with a bare percent is not decoded and stays in the index", async () => {
    const r = await rig();
    await botChat(r, "C-1");
    const memory = join(r.cwd, "memory");
    mkdirSync(join(memory, "topics"), { recursive: true });
    writeFileSync(join(memory, "topics", "from-web.md"), "---\nuntrusted: true\n---\n\nwhat a page said\n");
    writeFileSync(
      join(memory, "index.md"),
      "# Memory index\n\n- [Progress](100%.md): progress\n- [Web](topics/from-web.md): a page said\n",
    );

    const outcome = await r.run("C-1", "run-1");
    expect(outcome.result).toBe("done");
    const index = readFileSync(join(memory, "index.md"), "utf8");
    expect(index).toContain("](100%.md)");
    expect(index).not.toContain("from-web");
  });

  test("a wikilink with a bare percent is not decoded and stays in the index", async () => {
    const r = await rig();
    await botChat(r, "C-1");
    const memory = join(r.cwd, "memory");
    mkdirSync(join(memory, "topics"), { recursive: true });
    writeFileSync(join(memory, "topics", "from-web.md"), "---\nuntrusted: true\n---\n\nwhat a page said\n");
    writeFileSync(
      join(memory, "index.md"),
      "# Memory index\n\n- [[100% done]]: progress\n- [[50%|half]]: progress\n- [[topics/from-web]]: a page said\n",
    );

    const outcome = await r.run("C-1", "run-1");
    expect(outcome.result).toBe("done");
    const index = readFileSync(join(memory, "index.md"), "utf8");
    expect(index).toContain("[[100% done]]");
    expect(index).toContain("[[50%|half]]");
    expect(index).not.toContain("from-web");
  });

  test("a note marked as untrusted in the wiki is kept out of the wiki's index too", async () => {
    const r = await rig();
    await botChat(r, "C-1");
    const wiki = join(r.home, "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "from-web.md"), "---\nuntrusted: true\n---\n\nwhat a page said\n");
    writeFileSync(join(wiki, "own.md"), "a correction a person made\n");
    writeFileSync(
      join(wiki, "index.md"),
      "# Wiki index\n\n- [Own](own.md): a person's note\n- [Web](from-web.md): a page said\n",
    );

    const outcome = await r.run("C-1", "run-1");
    expect(outcome.result).toBe("done");
    expect(outcome.data["unindexed"]).toContain("from-web.md");
    const index = readFileSync(join(wiki, "index.md"), "utf8");
    expect(index).toContain("](own.md)");
    expect(index).not.toContain("from-web.md");
    expect(readFileSync(join(wiki, "from-web.md"), "utf8")).toContain("what a page said");
    expect(messages(wiki)).toEqual(["wiki: bot default, chat C-1"]);
  });

  test("a chat that is not a bot's is left alone", async () => {
    const r = await rig();
    await r.store.put("chat", "C-2", { parent: "repo:one", cwd: r.cwd, title: "Repo" }, "test");
    const outcome = await r.run("C-2", "run-1");
    expect(outcome).toEqual({ result: "done", data: { skipped: "not a chat of a bot" } });
  });

  test("a chat the store does not know is left alone", async () => {
    const r = await rig();
    const outcome = await r.run("C-9", "run-1");
    expect(outcome).toEqual({ result: "done", data: { skipped: "not a chat of a bot" } });
  });

  test("a wiki set outside the home is recorded too", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-wiki-"));
    roots.push(root);
    const wiki = join(root, "vault");
    const r = await rig(wiki);
    await botChat(r, "C-1");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "note.md"), "outside\n");
    await r.run("C-1", "run-1");
    expect(messages(wiki)).toEqual(["wiki: bot default, chat C-1"]);
  });
});

describe("one link parser for the index and the link table", () => {
  test("the targets the link table reads are the ones the index commit drops", () => {
    const named: readonly { readonly line: string; readonly target: string; readonly note: string }[] = [
      { line: "- [[topics/from-web]]: a page said", target: "topics/from-web", note: "topics/from-web.md" },
      { line: "- [[topics/from-web|a page said]]: a page said", target: "topics/from-web", note: "topics/from-web.md" },
      { line: "- [[topics/from-web#said]]: a page said", target: "topics/from-web", note: "topics/from-web.md" },
      { line: "- [[topics/from-web.md]]: a page said", target: "topics/from-web.md", note: "topics/from-web.md" },
      { line: "- [[from-web]]: a page said", target: "from-web", note: "topics/from-web.md" },
      { line: "| [[topics/from-web\\|a page said]] | a page said |", target: "topics/from-web", note: "topics/from-web.md" },
      { line: "- [Web](topics/from-web): a page said", target: "topics/from-web", note: "topics/from-web.md" },
      { line: "- [Web](topics/from-web.md#said): a page said", target: "topics/from-web.md", note: "topics/from-web.md" },
      { line: "- [Page](topics/my%20page.md): a page said", target: "topics/my page.md", note: "topics/my page.md" },
    ];
    for (const sample of named) {
      const links = parseNoteLinks(sample.line);
      expect(links.map((link) => link.target)).toEqual([sample.target]);
      const link = links[0];
      if (link === undefined) throw new Error(`no link in ${sample.line}`);
      expect(resolveNoteLink("index.md", link, [sample.note])).toBe(sample.note);
      expect(withoutUntrustedLines(sample.line, [sample.note])).toBe("");
    }

    const unnamed: readonly { readonly line: string; readonly target: string }[] = [
      { line: "- [[50%|half]]: progress", target: "50%" },
      { line: "- [Progress](100%.md): progress", target: "100%.md" },
    ];
    for (const sample of unnamed) {
      expect(parseNoteLinks(sample.line).map((link) => link.target)).toEqual([sample.target]);
      expect(withoutUntrustedLines(sample.line, ["topics/from-web.md"])).toBe(sample.line);
    }
  });
});
