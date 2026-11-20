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
      error: () => {},
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
  test("memory is added from the shipped package and listed as enabled", async () => {
    const home = await makeHomeWithoutPlugins();

    const enabled = capture();
    expect(await main(["plugin", "enable", "memory"], { home, io: enabled.io })).toBe(0);
    expect(enabled.text()).toContain("memory: enabled");
    expect(pluginsOf(home).memory).toEqual({ module: "@operad-io/memory", enabled: true });

    const listed = capture();
    expect(await main(["plugin", "list"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toMatch(/^memory {2}\d+\.\d+\.\d+ {2}enabled$/m);
  });
});
