import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@operad-io/engine";
import { openMcpTools } from "../src/index.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const memoryPlugin = fileURLToPath(new URL("../../memory/src/index.ts", import.meta.url));

async function home(): Promise<{ readonly home: string; readonly bot: string }> {
  const root = mkdtempSync(join(tmpdir(), "mcp-search-"));
  roots.push(root);
  const home = join(root, "home");
  const bot = join(home, "bot", "default");
  mkdirSync(join(home, "wiki", "notes"), { recursive: true });
  mkdirSync(join(bot, "memory"), { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: { memory: { module: memoryPlugin } },
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  writeFileSync(
    join(home, "wiki", "notes", "tea.md"),
    "---\ntags: [drink, warm]\n---\n\n# Tea\n\nGreen tea brews cooler.\n",
  );
  writeFileSync(join(bot, "memory", "note.md"), "# Memory\n\nMy own jasmine blend.\n");
  return { home, bot };
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("the tool gave no object");
  return value;
}

describe("the search tool a bot gets", () => {
  test("searches the wiki and the bot's memory and names the document and line range", async () => {
    const h = await home();
    const tools = await openMcpTools({ home: h.home, cwd: h.bot });
    try {
      const result = await tools.call("search", { query: "jasmine", scope: "memory" });
      expect(result.isError).toBeUndefined();
      const value = record(result.structuredContent);
      const hits = Array.isArray(value["hits"]) ? value["hits"].filter(isRecord) : [];
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ scope: "memory", title: "Memory" });
      expect(result.content[0]?.text).toContain("jasmine");
    } finally {
      await tools.close();
    }
  });

  test("filters by a frontmatter field", async () => {
    const h = await home();
    const tools = await openMcpTools({ home: h.home, cwd: h.bot });
    try {
      const found = await tools.call("search", { query: "green", scope: "wiki", fields: { tags: "drink" } });
      const value = record(found.structuredContent);
      expect(Array.isArray(value["hits"]) ? value["hits"] : []).toHaveLength(1);
      const missing = await tools.call("search", { query: "green", scope: "wiki", fields: { tags: "food" } });
      const empty = record(missing.structuredContent);
      expect(Array.isArray(empty["hits"]) ? empty["hits"] : []).toHaveLength(0);
    } finally {
      await tools.close();
    }
  });

  test("reads the document a search returned by its line range", async () => {
    const h = await home();
    const tools = await openMcpTools({ home: h.home, cwd: h.bot });
    try {
      const found = await tools.call("search", { query: "jasmine", scope: "memory" });
      const value = record(found.structuredContent);
      const hits = Array.isArray(value["hits"]) ? value["hits"].filter(isRecord) : [];
      const id = hits[0]?.["id"];
      expect(typeof id).toBe("string");
      const result = await tools.call("read", { id, from: 3, to: 3 });
      expect(result.isError).toBeUndefined();
      const read = record(result.structuredContent);
      expect(read["text"]).toBe("My own jasmine blend.");
      expect(result.content[0]?.text).toContain("My own jasmine blend.");
    } finally {
      await tools.close();
    }
  });

  test("a read ends with the notes that link to the document", async () => {
    const h = await home();
    writeFileSync(join(h.home, "wiki", "index.md"), "# Index\n\n- [[notes/tea|Tea]]\n");
    const tools = await openMcpTools({ home: h.home, cwd: h.bot });
    try {
      const result = await tools.call("read", { id: "wiki:notes/tea.md" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain("## Backlinks");
      expect(result.content[0]?.text).toContain("- `index.md` line 3 — - [[notes/tea|Tea]]");
      const value = record(result.structuredContent);
      expect(value["backlinks"]).toMatchObject([{ path: "index.md", line: 3, untrusted: false }]);
    } finally {
      await tools.close();
    }
  });

  test("a chat is not reachable when the bot's own has no message", async () => {
    const h = await home();
    const tools = await openMcpTools({ home: h.home, cwd: h.bot });
    try {
      const result = await tools.call("search", { query: "curry", scope: "chats" });
      expect(result.isError).toBeUndefined();
      const value = record(result.structuredContent);
      expect(Array.isArray(value["hits"]) ? value["hits"] : []).toHaveLength(0);
    } finally {
      await tools.close();
    }
  });

  test("an unknown scope is an error result, not a crash", async () => {
    const h = await home();
    const tools = await openMcpTools({ home: h.home, cwd: h.bot });
    try {
      expect(await tools.call("search", { query: "tea", scope: "elsewhere" })).toMatchObject({ isError: true });
    } finally {
      await tools.close();
    }
  });
});
