import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginRegistry } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const noDefault = fileURLToPath(
  new URL("../fixtures/flows/no-default.ts", import.meta.url),
);
const throws = fileURLToPath(
  new URL("../fixtures/flows/throws.ts", import.meta.url),
);

async function homeWithConfig(config: unknown): Promise<{
  readonly home: string;
  readonly configPath: string;
  readonly storeRoot: string;
}> {
  const root = await tempRoot();
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const configPath = join(home, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return { home, configPath, storeRoot: join(root, "store") };
}

describe("loadPluginRegistry", () => {
  test("loads the default plugins when the config file is missing", async () => {
    const root = await tempRoot();
    const registry = await loadPluginRegistry({
      home: join(root, "absent"),
      storeRoot: join(root, "store"),
      onLog: () => undefined,
    });
    expect(registry.names()).toEqual(["shell"]);
  });

  test("loads nothing when the config has no plugins key", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({});
    const registry = await loadPluginRegistry({
      home,
      configPath,
      storeRoot,
    });
    expect(registry.names()).toEqual([]);
  });

  test("names the config file when it is not valid JSON", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const configPath = join(home, "config.json");
    await writeFile(configPath, "{ nope");

    await expect(
      loadPluginRegistry({ home, configPath, storeRoot: join(root, "store") }),
    ).rejects.toThrow(/invalid JSON/);
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot: join(root, "store") }),
    ).rejects.toThrow(configPath);
  });

  test("rejects a plugins value that is not a list or an object", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({
      plugins: "notes",
    });
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot }),
    ).rejects.toThrow(/plugins: must be an object/);
  });

  test("names the module when it cannot be imported, and loads the rest", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({
      plugins: ["./does-not-exist.ts"],
    });
    const logs: string[] = [];
    const registry = await loadPluginRegistry({
      home,
      configPath,
      storeRoot,
      onLog: (message) => logs.push(message),
    });
    expect(registry.names()).toEqual([]);
    expect(logs.join("\n")).toContain("import failed");
    expect(logs.join("\n")).toContain("does-not-exist.ts");
  });

  test("names the module when it has no default export", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({
      plugins: [noDefault],
    });
    const logs: string[] = [];
    const registry = await loadPluginRegistry({
      home,
      configPath,
      storeRoot,
      onLog: (message) => logs.push(message),
    });
    expect(registry.names()).toEqual([]);
    expect(logs.join("\n")).toContain("no default export");
    expect(logs.join("\n")).toContain(noDefault);
  });

  test("names the module when it throws on import", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({
      plugins: [throws],
    });
    const logs: string[] = [];
    const registry = await loadPluginRegistry({
      home,
      configPath,
      storeRoot,
      onLog: (message) => logs.push(message),
    });
    expect(registry.names()).toEqual([]);
    expect(logs.join("\n")).toContain("import failed");
    expect(logs.join("\n")).toContain("explodes on import");
  });
});
