import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPluginRegistry,
  MemoryPluginStore,
  PluginRegistry,
  PLUGIN_API_VERSION,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "./support.ts";

const configuredPath = fileURLToPath(
  new URL("../fixtures/plugins/configured.ts", import.meta.url),
);

afterAll(cleanupTempRoots);

async function registry(
  definitions: readonly unknown[],
  options: { readonly settings?: Record<string, unknown>; readonly disabled?: readonly string[] } = {},
): Promise<{ readonly registry: PluginRegistry; readonly logs: string[] }> {
  const root = await tempRoot();
  const logs: string[] = [];
  const created = new PluginRegistry(definitions, {
    home: join(root, "home"),
    store: new MemoryPluginStore({ root: join(root, "store") }),
    onLog: (message) => logs.push(message),
    ...options,
  });
  return { registry: created, logs };
}

describe("plugin settings", () => {
  test("fills declared defaults and gives the step a read-only section", async () => {
    let seen: Readonly<Record<string, unknown>> | undefined;
    const plugin = def({
      name: "configured",
      settings: {
        type: "object",
        properties: {
          region: { type: "string", default: "us-east" },
          retries: { type: "integer", default: 3 },
          token: { type: "string" },
        },
        required: ["token"],
        additionalProperties: false,
      },
      steps: [
        {
          name: "read",
          results: ["ok"],
          run(ctx) {
            seen = ctx.settings;
            return { result: "ok" };
          },
        },
      ],
    });
    const { registry: loaded } = await registry([plugin], {
      settings: { configured: { token: "abc" } },
    });

    await loaded.runStep("configured/read", {}, { runId: "run-1" });
    expect(seen).toEqual({ region: "us-east", retries: 3, token: "abc" });
    expect(Reflect.set(seen as object, "region", "eu-west")).toBe(false);
  });

  test("an invalid section refuses only that plugin and names the field", async () => {
    const broken = def({
      name: "broken",
      settings: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
      },
    });
    const healthy = def({ name: "healthy" });
    const { registry: loaded, logs } = await registry([broken, healthy], {
      settings: { broken: { token: 42 } },
    });

    expect(loaded.names()).toEqual(["healthy"]);
    expect(logs.join("\n")).toContain('plugin "broken"');
    expect(logs.join("\n")).toContain("settings.token");
  });

  test("a null settings section refuses the plugin instead of becoming an empty object", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        plugins: { configured: { module: configuredPath, settings: null } },
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      }),
    );
    const logs: string[] = [];
    const loaded = await loadPluginRegistry({
      home,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      onLog: (message) => logs.push(message),
    });
    expect(loaded.names()).toEqual([]);
    expect(logs.join("\n")).toContain('plugin "configured"');
    expect(logs.join("\n")).toContain("settings: must be an object");
  });

  test("a plugin without a settings schema gets an empty read-only object", async () => {
    let seen: Readonly<Record<string, unknown>> | undefined;
    const plugin = def({
      name: "plain",
      steps: [
        {
          name: "read",
          results: ["ok"],
          run(ctx) {
            seen = ctx.settings;
            return { result: "ok" };
          },
        },
      ],
    });
    const { registry: loaded } = await registry([plugin]);
    await loaded.runStep("plain/read", {}, { runId: "run-1" });
    expect(seen).toEqual({});
    expect(Reflect.set(seen as object, "anything", true)).toBe(false);
  });
});

describe("plugin requires", () => {
  test("refuses a plugin whose required plugin is missing", async () => {
    const plugin = def({
      name: "app",
      requires: { plugins: { base: "^1.0.0" } },
    });
    const { registry: loaded, logs } = await registry([plugin]);
    expect(loaded.names()).toEqual([]);
    expect(logs.join("\n")).toContain('requires plugin "base" "^1.0.0"');
    expect(logs.join("\n")).toContain("is not loaded");
  });

  test("refuses a plugin whose required API range is not met", async () => {
    const plugin = def({ name: "app", requires: { api: "^2.0.0" } });
    const { registry: loaded, logs } = await registry([plugin]);
    expect(loaded.names()).toEqual([]);
    expect(logs.join("\n")).toContain('requires api "^2.0.0"');
    expect(logs.join("\n")).toContain(PLUGIN_API_VERSION);
  });

  test("accepts a compatible dependency and API", async () => {
    const base = def({ name: "base", version: "1.2.0" });
    const app = def({
      name: "app",
      requires: { plugins: { base: ">=1.0.0" }, api: "^1.0.0" },
    });
    const { registry: loaded } = await registry([app, base]);
    expect(loaded.names()).toEqual(["app", "base"]);
  });

  test("refuses a chain of two plugins, each with its own line", async () => {
    const base = def({ name: "base", requires: { plugins: { missing: "^1.0.0" } } });
    const app = def({ name: "app", requires: { plugins: { base: "^0.0.1" } } });
    const { registry: loaded, logs } = await registry([app, base]);
    expect(loaded.names()).toEqual([]);
    expect(logs.join("\n")).toContain('plugin "base"');
    expect(logs.join("\n")).toContain('plugin "app"');
    expect(logs.join("\n")).toContain('"base" was refused');
  });

  test("names a disabled dependency as disabled", async () => {
    const app = def({ name: "app", requires: { plugins: { base: "^1.0.0" } } });
    const { registry: loaded, logs } = await registry([app], {
      disabled: ["base"],
    });
    expect(loaded.names()).toEqual([]);
    expect(logs.join("\n")).toContain('"base" is disabled');
  });
});
