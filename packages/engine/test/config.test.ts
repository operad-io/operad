import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_PLUGINS,
  configJson,
  defaultConfig,
  ensureConfig,
  readConfig,
  storeRootOf,
} from "../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./plugin/support.ts";

afterAll(cleanupTempRoots);

describe("operad config", () => {
  test("the default plugins are shell and dev", async () => {
    expect(DEFAULT_PLUGINS).toEqual(["shell", "dev"]);
    const root = await tempRoot();
    const home = join(root, "home");
    await ensureConfig(home);
    const text = JSON.parse(
      await readFile(join(home, "config.json"), "utf8"),
    ) as { plugins: Record<string, { module: string; enabled: boolean }> };
    expect(text.plugins).toEqual({
      shell: { module: "@operad-io/shell", enabled: true },
      dev: { module: "@operad-io/dev", enabled: true },
    });
  });

  test("a missing config means jsonl at <home>/store", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const config = await readConfig(home);
    expect(config).toEqual({
      plugins: defaultConfig(home).plugins,
      store: { backend: "jsonl", path: join(home, "store") },
    });
    expect(storeRootOf(config)).toBe(join(home, "store"));
  });

  test("reads plugins and a sqlite store with a relative path", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const ensured = await ensureConfig(home);
    expect(ensured.created).toBe(true);
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        plugins: { dev: { module: "./plugins/dev.ts" } },
        store: { backend: "sqlite", path: "data/log.sqlite" },
      }),
    );

    const config = await readConfig(home);
    expect(config.plugins).toEqual([
      {
        name: "dev",
        module: "./plugins/dev.ts",
        enabled: true,
        settings: {},
      },
    ]);
    expect(config.store).toEqual({
      backend: "sqlite",
      path: join(home, "data", "log.sqlite"),
    });
    expect(storeRootOf(config)).toBe(join(home, "data"));
  });

  test("init is idempotent", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const first = await ensureConfig(home);
    const second = await ensureConfig(home);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.config).toEqual(defaultConfig(home));
    const text = await readFile(join(home, "config.json"), "utf8");
    expect(JSON.parse(text)).toEqual(configJson(defaultConfig(home)));
  });

  test("rejects an unknown backend", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await ensureConfig(home);
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ store: { backend: "postgres", path: "x" } }),
    );
    await expect(readConfig(home)).rejects.toBeInstanceOf(ConfigError);
  });

  test("rejects a plugins value that is not a list or an object", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await ensureConfig(home);
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ plugins: "dev" }),
    );
    await expect(readConfig(home)).rejects.toThrow(/plugins: must be an object/);
  });

  test("ships a JSON Schema with the store keys", async () => {
    const path = new URL("../config.schema.json", import.meta.url);
    const schema = JSON.parse(await readFile(path, "utf8")) as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.plugins).toBeDefined();
    expect(schema.properties?.store).toBeDefined();
  });
});
