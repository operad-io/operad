import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry, isRecord } from "@operad-io/engine";
import { createMemoryPlugin, memoryGit } from "../src/index.ts";

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
