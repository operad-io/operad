import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
);

async function run(home: string, args: readonly string[]) {
  let out = "";
  let err = "";
  const code = await main(args, {
    home,
    io: { write: (text) => { out += text; }, error: (text) => { err += text; } },
  });
  return { code, out, err };
}

describe("operad list --json while another process holds the store's write lock", () => {
  test("prints the whole page with code 0 instead of failing with 'database is locked'", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [pluginPath],
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      }),
    );
    // The first command creates the stores and records the declarations.
    const first = await run(home, ["list", "item", "--json"]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);

    // A running serve holds the write lock of the plugin store.
    const holder = new Database(join(root, "store", "plugins.sqlite"));
    holder.run("BEGIN IMMEDIATE");
    try {
      const listed = await run(home, ["list", "item", "--json"]);
      expect(listed.err).toBe("");
      expect(listed.code).toBe(0);
      const page = JSON.parse(listed.out) as { rows: unknown[] };
      expect(page.rows).toEqual([]);
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
  });
});

describe("operad list and running while another process holds the log's write lock", () => {
  test("both answer with code 0 instead of failing with 'database is locked'", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [pluginPath],
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      }),
    );
    // The first command creates the stores and records the declarations.
    const first = await run(home, ["list", "item", "--json"]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);

    // A running serve holds the write lock of the log.
    const holder = new Database(join(root, "store", "log.sqlite"));
    holder.run("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      const listed = await run(home, ["list", "item", "--json"]);
      expect(listed.err).toBe("");
      expect(listed.code).toBe(0);
      const page = JSON.parse(listed.out) as { rows: unknown[] };
      expect(page.rows).toEqual([]);

      const running = await run(home, ["running", "--json"]);
      expect(running.err).toBe("");
      expect(running.code).toBe(0);
      expect(JSON.parse(running.out)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
  });
});
