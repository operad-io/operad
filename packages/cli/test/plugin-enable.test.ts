import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

interface Output {
  readonly io: CliIo;
  text(): string;
}

function capture(): Output {
  let out = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        out += text;
      },
    },
    text: () => out,
  };
}

/** A home whose `config.json` lists no plugins, so `memory` is not in it. */
async function makeHomeWithoutPlugins(): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: {},
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  return home;
}

function pluginsOf(home: string): Record<string, { module: string; enabled: boolean }> {
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    plugins: Record<string, { module: string; enabled: boolean }>;
  };
  return config.plugins;
}

describe("plugin enable", () => {
  test("the plugins a new home leaves off can be turned on", async () => {
    const home = await makeHomeWithoutPlugins();
    for (const name of ["shell", "pool", "dev"]) {
      const enabled = capture();
      expect(await main(["plugin", "enable", name], { home, io: enabled.io })).toBe(0);
      expect(enabled.text()).toContain(`${name}: enabled`);
    }
    expect(Object.keys(pluginsOf(home))).toEqual(["shell", "pool", "dev"]);
  });

  test("enabling dev also enables pool and shell and names each", async () => {
    const home = await makeHomeWithoutPlugins();
    // dev's actions read chat objects, so a home that loads dev has chat.
    const file = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { plugins: object };
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ ...file, plugins: { chat: { module: "@operad-io/chat", enabled: true } } }),
    );
    const first = capture();
    expect(await main(["plugin", "enable", "dev"], { home, io: first.io })).toBe(0);
    expect(first.text().trim().split("\n")).toEqual(["pool: enabled", "shell: enabled", "dev: enabled"]);
    expect(Object.values(pluginsOf(home)).every((entry) => entry.enabled)).toBe(true);
    expect(Object.keys(pluginsOf(home)).sort()).toEqual(["chat", "dev", "pool", "shell"]);

    const again = capture();
    expect(await main(["plugin", "enable", "dev"], { home, io: again.io })).toBe(0);
    expect(again.text().trim()).toBe("dev: enabled");

    const off = capture();
    expect(await main(["plugin", "disable", "pool"], { home, io: off.io })).toBe(0);
    expect(off.text().trim()).toBe("pool: disabled");
    expect(pluginsOf(home).pool?.enabled).toBe(false);
    expect(pluginsOf(home).dev?.enabled).toBe(true);
  });

  test("memory is added from the shipped package and listed as enabled", async () => {
    const home = await makeHomeWithoutPlugins();

    const enabled = capture();
    expect(await main(["plugin", "enable", "memory"], { home, io: enabled.io })).toBe(0);
    expect(enabled.text()).toContain("memory: enabled");
    expect(pluginsOf(home).memory).toEqual({ module: "@operad-io/memory", enabled: true });

    const listed = capture();
    expect(await main(["plugin", "list"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toMatch(
      /^memory {2}\d+\.\d+\.\d+ {2}enabled {2}a wiki and memory that agents search and keep up to date$/m,
    );
  });
});
