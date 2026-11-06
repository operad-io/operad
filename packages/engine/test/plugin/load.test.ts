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
  test("loads nothing when the config file is missing", async () => {
    const root = await tempRoot();
    const registry = await loadPluginRegistry({
      home: join(root, "absent"),
      storeRoot: join(root, "store"),
    });
    expect(registry.names()).toEqual([]);
    expect(registry.stepTypes()).toEqual([]);
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

  test("rejects a plugins value that is not a list of names", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({
      plugins: "notes",
    });
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot }),
    ).rejects.toThrow(/plugins: must be an array/);
  });

  test("names the module when it cannot be imported", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({
      plugins: ["./does-not-exist.ts"],
    });
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot }),
    ).rejects.toThrow(/import failed/);
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot }),
    ).rejects.toThrow(/does-not-exist\.ts/);
  });

  test("names the module when it has no default export", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({
      plugins: [noDefault],
    });
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot }),
    ).rejects.toThrow(/no default export/);
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot }),
    ).rejects.toThrow(noDefault);
  });

  test("names the module when it throws on import", async () => {
    const { home, configPath, storeRoot } = await homeWithConfig({
      plugins: [throws],
    });
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot }),
    ).rejects.toThrow(/import failed/);
    await expect(
      loadPluginRegistry({ home, configPath, storeRoot }),
    ).rejects.toThrow(/explodes on import/);
  });
});
