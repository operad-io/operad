import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry, isRecord } from "@operad-io/engine";
import { createMemoryPlugin } from "../src/index.ts";
import { SearchError } from "../src/search/types.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Rig {
  readonly home: string;
  readonly bot: string;
  readonly registry: PluginRegistry;
  readonly store: MemoryPluginStore;
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "memory-search-command-"));
  roots.push(root);
  const home = join(root, "home");
  const bot = join(home, "bot", "default");
  mkdirSync(join(home, "wiki", "notes"), { recursive: true });
  mkdirSync(join(bot, "memory"), { recursive: true });
  writeFileSync(join(home, "wiki", "notes", "tea.md"), "# Tea\n\nGreen tea brews cooler.\n");
  writeFileSync(join(bot, "memory", "note.md"), "# Note\n\nMy own jasmine blend.\n");
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const registry = new PluginRegistry([createMemoryPlugin()], {
    home,
    cwd: root,
    store,
    settings: { memory: {} },
    onLog: () => undefined,
  });
  return { home, bot, registry, store };
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("the command gave no object");
  return value;
}

describe("the memory search commands", () => {
  test("search takes JSON arguments and returns hits", async () => {
    const r = rig();
    const run = await r.registry.runCommand(["memory", "search"], {
      cwd: r.bot,
      input: JSON.stringify({ query: "jasmine", scope: "memory" }),
    });
    const value = record(run?.value);
    expect(value["hits"]).toHaveLength(1);
    expect(value["scopes"]).toEqual(["memory"]);
  });

  test("--chat searches inside one chat from any directory; the JSON arguments of a bot's tool cannot", async () => {
    const r = rig();
    await r.store.put("chat", "C-1", { parent: "bot:default", cwd: r.bot, title: "One" }, "test");
    r.store.append({
      type: "chat.message",
      object: { type: "chat", id: "C-1" },
      cause: "test",
      data: { id: "m1", role: "user", text: "the saffron question", from: { via: "cli", id: "p" }, attachments: [], source: { kind: "cli", ref: null } },
    });
    const found = record((await r.registry.runCommand(["memory", "search", "--chat", "C-1", "saffron"], { cwd: tmpdir() }))?.value);
    expect(found["hits"]).toMatchObject([{ id: "chat:C-1", message: "m1" }]);
    const viaTool = record(
      (await r.registry.runCommand(["memory", "search"], { cwd: tmpdir(), input: JSON.stringify({ query: "saffron", chat: "C-1" }) }))?.value,
    );
    expect(viaTool["hits"]).toEqual([]);
  });

  test("search takes words on the command line too", async () => {
    const r = rig();
    const run = await r.registry.runCommand(["memory", "search", "--scope", "wiki", "green", "tea"], {
      cwd: r.bot,
    });
    const value = record(run?.value);
    expect(value["hits"]).toHaveLength(1);
  });

  test("read takes the document id and a line range", async () => {
    const r = rig();
    const found = record(
      (
        await r.registry.runCommand(["memory", "search"], {
          cwd: r.bot,
          input: JSON.stringify({ query: "jasmine", scope: "memory" }),
        })
      )?.value,
    );
    const hits = Array.isArray(found["hits"]) ? found["hits"].filter(isRecord) : [];
    const id = hits[0]?.["id"];
    expect(typeof id).toBe("string");
    const run = await r.registry.runCommand(["memory", "read"], {
      cwd: r.bot,
      input: JSON.stringify({ id, from: 3, to: 3 }),
    });
    const value = record(run?.value);
    expect(value["text"]).toBe("My own jasmine blend.");
    expect(value["lineStart"]).toBe(3);
    expect(value["lineEnd"]).toBe(3);
  });

  test("read ends with Backlinks, and --json gives the backlinks array", async () => {
    const r = rig();
    writeFileSync(join(r.home, "wiki", "index.md"), "# Index\n\n- [[notes/tea|Tea]]\n");
    writeFileSync(
      join(r.home, "wiki", "untrusted.md"),
      "---\nuntrusted: true\n---\n\nSee [[notes/tea]].\n",
    );

    const text = String(
      (await r.registry.runCommand(["memory", "read", "wiki:notes/tea.md"], { cwd: r.bot }))?.value,
    );
    expect(text).toContain("## Backlinks");
    expect(text).toContain("- `index.md` line 3 — - [[notes/tea|Tea]]");
    expect(text).toContain("- `untrusted.md` line 2 (untrusted) — See [[notes/tea]].");
    expect(text.indexOf("## Backlinks")).toBeGreaterThan(text.indexOf("# Tea"));

    const json = record(
      (await r.registry.runCommand(["memory", "read", "wiki:notes/tea.md", "--json"], { cwd: r.bot }))
        ?.value,
    );
    expect(json["backlinks"]).toMatchObject([
      { path: "index.md", line: 3, untrusted: false },
      { path: "untrusted.md", line: 2, untrusted: true },
    ]);

    const alone = String(
      (
        await r.registry.runCommand(["memory", "read", `memory:${r.bot}:note.md`], {
          cwd: r.bot,
        })
      )?.value,
    );
    expect(alone).not.toContain("## Backlinks");
    const aloneJson = record(
      (
        await r.registry.runCommand(["memory", "read", `memory:${r.bot}:note.md`, "--json"], {
          cwd: r.bot,
        })
      )?.value,
    );
    expect(aloneJson["backlinks"]).toEqual([]);
  });

  test("a scope that is not one of the three is refused", async () => {
    const r = rig();
    await expect(
      r.registry.runCommand(["memory", "search"], {
        cwd: r.bot,
        input: JSON.stringify({ query: "tea", scope: "elsewhere" }),
      }),
    ).rejects.toThrow(SearchError);
  });
});
