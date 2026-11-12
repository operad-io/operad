import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqlitePluginStore,
  loadConfiguredPlugins,
  loadPluginRegistry,
  setPluginEnabled,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const notesPath = fileURLToPath(
  new URL("../fixtures/plugins/notes.ts", import.meta.url),
);

async function homeWith(
  plugins: Record<string, unknown>,
): Promise<{ readonly home: string; readonly storeRoot: string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      plugins,
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  return { home, storeRoot: join(root, "store") };
}

describe("plugin enable and disable", () => {
  test("a disabled plugin is not loaded and its objects return after enable", async () => {
    const { home, storeRoot } = await homeWith({
      notes: { module: notesPath, enabled: false },
    });
    const store = new SqlitePluginStore({ root: storeRoot });
    await store.put("note", "1", { text: "kept" }, "seed");

    const disabled = await loadPluginRegistry({ home, store, onLog: () => undefined });
    expect(disabled.names()).toEqual([]);
    expect(disabled.resolveCommand(["notes", "add", "x"])).toBeUndefined();

    const configured = await loadConfiguredPlugins({ home });
    expect(configured.disabled).toEqual(["notes"]);
    expect(configured.loaded).toEqual([]);

    await setPluginEnabled(home, "notes", true);
    const enabled = await loadPluginRegistry({ home, store, onLog: () => undefined });
    expect(enabled.names()).toEqual(["notes"]);
    expect((await enabled.store.get("note", "1"))?.data.text).toBe("kept");
    expect(enabled.resolveCommand(["notes", "add", "x"])).toEqual({
      plugin: "notes",
      command: "add",
      argv: ["x"],
    });
  });

  test("a dependent plugin is not loaded when its dependency is disabled", async () => {
    const { home } = await homeWith({
      notes: { module: notesPath, enabled: false },
    });
    // A plugin is loaded through a module, so use the registry's disabled set
    // directly; the loader passes exactly this set.
    const { PluginRegistry, MemoryPluginStore } = await import("../../src/index.ts");
    const { def } = await import("./support.ts");
    const dependent = def({
      name: "app",
      requires: { plugins: { notes: "^0.0.1" } },
    });
    const logs: string[] = [];
    const registry = new PluginRegistry([dependent], {
      home,
      store: new MemoryPluginStore({ root: join(home, "store") }),
      disabled: ["notes"],
      onLog: (message) => logs.push(message),
    });
    expect(registry.names()).toEqual([]);
    expect(logs.join("\n")).toContain('"notes" is disabled');
  });
});
