import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_MCP,
  DEFAULT_PLUGINS,
  configJson,
  defaultConfig,
  ensureConfig,
  readConfig,
  storeRootOf,
  writeConfig,
} from "../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./plugin/support.ts";

afterAll(cleanupTempRoots);

describe("operad config", () => {
  test("the default plugins are shell, the radian harness, chat and dev", async () => {
    expect(DEFAULT_PLUGINS).toEqual(["shell", "harness-radian", "chat", "dev"]);
    const root = await tempRoot();
    const home = join(root, "home");
    await ensureConfig(home);
    const text = JSON.parse(
      await readFile(join(home, "config.json"), "utf8"),
    ) as { plugins: Record<string, { module: string; enabled: boolean }> };
    expect(text.plugins).toEqual({
      shell: { module: "@operad-io/shell", enabled: true },
      "harness-radian": {
        module: "@operad-io/harness-radian",
        enabled: true,
      },
      chat: { module: "@operad-io/chat", enabled: true },
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
      http: { enabled: true, port: 7480, listen: ["127.0.0.1"] },
      notify: { command: null, on: ["waiting"] },
      mcp: { ...DEFAULT_MCP, actions: [...DEFAULT_MCP.actions] },
      ask: { graceSecs: 600 },
    });
    expect(storeRootOf(config)).toBe(join(home, "store"));
  });

  test("init adds the default plugins to a config that names none", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await Bun.write(join(home, "config.json"), JSON.stringify({ store: { path: "s" } }));
    const ensured = await ensureConfig(home);
    expect(ensured.created).toBe(false);
    expect(ensured.config.plugins).toEqual(defaultConfig(home).plugins);
    const text = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      store: { path: string };
    };
    expect(text.store.path).toBe("s");
    const again = await ensureConfig(home);
    expect(again.config.plugins).toEqual(defaultConfig(home).plugins);
  });

  test("a failed write leaves the existing config whole", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const written = JSON.stringify({ store: { path: "s" } });
    await Bun.write(join(home, "config.json"), written);
    // A directory where the temp file goes makes the write fail.
    await mkdir(join(home, "config.json.tmp"));
    await expect(ensureConfig(home)).rejects.toThrow();
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(written);
  });

  test("adding the default plugins leaves no temp file behind", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await Bun.write(join(home, "config.json"), JSON.stringify({ store: { path: "s" } }));
    await ensureConfig(home);
    expect(await readdir(home)).toEqual(["config.json"]);
  });

  test("init leaves a config that names plugins alone", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const written = JSON.stringify({ plugins: {} });
    await Bun.write(join(home, "config.json"), written);
    expect((await ensureConfig(home)).config.plugins).toEqual([]);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(written);
  });

  test("an older config's moved module name still loads", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ plugins: ["@operad-io/engine/shell", "./x.ts"] }),
    );
    const config = await readConfig(home);
    expect(config.plugins.map((entry) => entry.module)).toEqual(["@operad-io/shell", "./x.ts"]);
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

  test("reads notify and applies its defaults", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ notify: { command: "ntfy pub x" } }),
    );
    expect((await readConfig(home)).notify).toEqual({
      command: "ntfy pub x",
      on: ["waiting"],
    });
    await Bun.write(join(home, "config.json"), JSON.stringify({ notify: {} }));
    expect((await readConfig(home)).notify).toEqual({
      command: null,
      on: ["waiting"],
    });
  });

  test("rejects a malformed notify section", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    for (const [notify, pattern] of [
      [{ command: 3 }, /notify.command/],
      [{ command: "  " }, /notify.command/],
      [{ on: ["done"] }, /notify.on/],
      [{ on: "waiting" }, /notify.on/],
      ["ntfy", /notify: must be an object/],
    ] as const) {
      await Bun.write(join(home, "config.json"), JSON.stringify({ notify }));
      await expect(readConfig(home)).rejects.toThrow(pattern);
    }
  });

  test("reads ask.graceSecs and rejects a malformed ask section", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await Bun.write(join(home, "config.json"), JSON.stringify({ ask: { graceSecs: 90 } }));
    expect((await readConfig(home)).ask).toEqual({ graceSecs: 90 });
    await Bun.write(join(home, "config.json"), JSON.stringify({ ask: {} }));
    expect((await readConfig(home)).ask).toEqual({ graceSecs: 600 });
    await Bun.write(join(home, "config.json"), JSON.stringify({ ask: { graceSecs: 0 } }));
    expect((await readConfig(home)).ask).toEqual({ graceSecs: 0 });
    for (const [ask, pattern] of [
      [{ graceSecs: -1 }, /ask.graceSecs/],
      [{ graceSecs: "10" }, /ask.graceSecs/],
      [{ graceSecs: null }, /ask.graceSecs/],
      [{ graceSecs: 2_147_484 }, /from 0 to 2147483/],
      ["10", /ask: must be an object/],
    ] as const) {
      await Bun.write(join(home, "config.json"), JSON.stringify({ ask }));
      await expect(readConfig(home)).rejects.toThrow(pattern);
    }
  });

  test("a written config keeps the notify command", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ notify: { command: "ntfy pub x" } }),
    );
    const config = await readConfig(home);
    await writeConfig(home, config);
    expect((await readConfig(home)).notify.command).toBe("ntfy pub x");
  });

  test("ships a JSON Schema with the store and http keys", async () => {
    const path = new URL("../config.schema.json", import.meta.url);
    const schema = JSON.parse(await readFile(path, "utf8")) as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.plugins).toBeDefined();
    expect(schema.properties?.store).toBeDefined();
    expect(schema.properties?.http).toBeDefined();
    expect(schema.properties?.notify).toBeDefined();
    expect(schema.properties?.mcp).toBeDefined();
  });

  test("reads http options and applies their defaults", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await ensureConfig(home);
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        http: { enabled: true, port: 9000, listen: ["127.0.0.1", "100.64.0.2"] },
      }),
    );
    const config = await readConfig(home);
    expect(config.http).toEqual({
      enabled: true,
      port: 9000,
      listen: ["127.0.0.1", "100.64.0.2"],
    });

    await Bun.write(join(home, "config.json"), JSON.stringify({ http: {} }));
    expect((await readConfig(home)).http).toEqual({
      enabled: true,
      port: 7480,
      listen: ["127.0.0.1"],
    });

    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ http: { enabled: false } }),
    );
    expect((await readConfig(home)).http.enabled).toBe(false);
  });

  test("rejects a malformed http section", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await ensureConfig(home);
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ http: { port: -1 } }),
    );
    await expect(readConfig(home)).rejects.toThrow(/http.port/);

    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ http: { listen: "127.0.0.1" } }),
    );
    await expect(readConfig(home)).rejects.toThrow(/http.listen/);
  });
  test("reads mcp actions and applies their defaults", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        mcp: {
          actions: ["dev:merge", "demo:approve"],
          confirmActions: ["dev:merge"],
        },
      }),
    );
    expect((await readConfig(home)).mcp).toEqual({
      channel: { notify: ["waiting", "ended", "loop"], loopAfter: 3 },
      actions: ["dev:merge", "demo:approve"],
      confirmActions: ["dev:merge"],
    });
    await Bun.write(join(home, "config.json"), JSON.stringify({ mcp: {} }));
    expect((await readConfig(home)).mcp).toEqual({
      channel: { notify: ["waiting", "ended", "loop"], loopAfter: 3 },
      actions: [...DEFAULT_MCP.actions],
      confirmActions: [],
    });
  });

  test("reads mcp.channel and keeps it when written", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ mcp: { channel: { notify: ["changes"], loopAfter: 5 } } }),
    );
    const config = await readConfig(home);
    expect(config.mcp.channel).toEqual({ notify: ["changes"], loopAfter: 5 });
    await writeConfig(home, config);
    expect((await readConfig(home)).mcp.channel).toEqual({
      notify: ["changes"],
      loopAfter: 5,
    });
  });

  test("rejects a malformed mcp section and keeps it when written", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    for (const [mcp, pattern] of [
      [{ actions: "dev:merge" }, /mcp.actions/],
      [{ actions: ["dev:merge", 3] }, /mcp.actions/],
      [{ confirmActions: [""] }, /mcp.confirmActions/],
      ["all", /mcp: must be an object/],
      [{ channel: { notify: ["waiting", "bogus"] } }, /mcp.channel.notify.*"bogus"/],
      [{ channel: { notify: "waiting" } }, /mcp.channel.notify/],
      [{ channel: { loopAfter: 1 } }, /mcp.channel.loopAfter/],
      [{ channel: [] }, /mcp.channel: must be an object/],
    ] as const) {
      await Bun.write(join(home, "config.json"), JSON.stringify({ mcp }));
      await expect(readConfig(home)).rejects.toThrow(pattern);
    }

    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({ mcp: { actions: ["dev:merge"], confirmActions: ["dev:merge"] } }),
    );
    const config = await readConfig(home);
    await writeConfig(home, config);
    expect((await readConfig(home)).mcp).toEqual({
      channel: { notify: ["waiting", "ended", "loop"], loopAfter: 3 },
      actions: ["dev:merge"],
      confirmActions: ["dev:merge"],
    });
  });

});
