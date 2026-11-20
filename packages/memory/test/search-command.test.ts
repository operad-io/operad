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
  return { home, bot, registry };
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
