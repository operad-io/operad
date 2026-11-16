import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginRegistry, MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "../../process/test/support.ts";
import {
  createPiHarnessPlugin,
  parsePiCatalogue,
  PI_LIST_CACHE_MS,
  piModelListPath,
} from "../src/index.ts";

afterAll(cleanupTempRoots);

const PI_PLUGIN = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const TABLE = [
  "provider     model              context  max-out  thinking  images",
  "openai       gpt-5              400K     128K     yes       yes",
  "opencode-go  deepseek-v4.1-flash  128K   32K      no        no",
  "zai          glm-5              200K     64K      yes       no",
  "",
].join("\n");

const CATALOGUE = ["openai/gpt-5", "opencode-go/deepseek-v4.1-flash", "zai/glm-5"];

interface Env {
  readonly root: string;
  readonly fake: string;
  readonly asked: string;
  readonly settingsPath: string;
}

/** A fake pi: a shell script that records each ask and then runs `body`. */
async function fakePi(body: string): Promise<Env> {
  const root = await tempRoot();
  const fake = join(root, "pi");
  const asked = join(root, "asked");
  writeFileSync(fake, `#!/bin/sh\necho x >> "${asked}"\n${body}\n`);
  chmodSync(fake, 0o755);
  return { root, fake, asked, settingsPath: join(root, "pi-settings.json") };
}

function catalogueBody(): string {
  return `cat <<'EOT'\n${TABLE}EOT`;
}

/** Writes the list a previous process kept under the operad home. */
function writeKept(env: Env, list: readonly string[], at: number): void {
  const path = piModelListPath(env.root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ command: env.fake, at, list }));
}

function askedTimes(env: Env): number {
  return existsSync(env.asked) ? readFileSync(env.asked, "utf8").trim().split("\n").length : 0;
}

function registryFor(
  env: Env,
  settings: Record<string, unknown>,
  extra: { now?: () => number; listTimeoutMs?: number; log?: (message: string) => void } = {},
): PluginRegistry {
  const plugin = createPiHarnessPlugin({
    piSettingsPath: env.settingsPath,
    ...(extra.now === undefined ? {} : { now: extra.now }),
    ...(extra.listTimeoutMs === undefined ? {} : { listTimeoutMs: extra.listTimeoutMs }),
  });
  return new PluginRegistry([plugin], {
    home: env.root,
    cwd: env.root,
    store: new MemoryPluginStore({ root: join(env.root, "store") }),
    settings: { pi: { command: env.fake, ...settings } },
    onLog: extra.log ?? (() => undefined),
  });
}

describe("the models pi declares", () => {
  test("parsePiCatalogue reads provider/id from each row and skips the header", () => {
    expect(parsePiCatalogue(TABLE)).toEqual(CATALOGUE);
  });

  test("pi's no-model sentence is not a model", () => {
    expect(parsePiCatalogue("No models available. Check your installation or add models to models.json.\n")).toEqual([]);
  });

  test("loading the plugins does not start pi, and the kept file gives the list", async () => {
    const env = await fakePi(catalogueBody());
    writeKept(env, ["kept/one"], Date.now());
    const configPath = join(env.root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: { pi: { module: PI_PLUGIN, settings: { command: env.fake } } },
      }),
    );
    const registry = await loadPluginRegistry({
      home: env.root,
      configPath,
      storeRoot: join(env.root, "store"),
      onLog: () => undefined,
    });
    expect(registry.names()).toEqual(["pi"]);
    expect(askedTimes(env)).toBe(0);
    expect(registry.loadedModels().pi?.list).toEqual(["kept/one"]);
    expect(askedTimes(env)).toBe(0);
  });

  test("first use with no kept file waits for one refresh", async () => {
    const env = await fakePi(catalogueBody());
    const registry = registryFor(env, {});
    expect(await registry.loadedModelsReady()).toEqual({
      pi: { list: CATALOGUE, default: null },
    });
    expect(askedTimes(env)).toBe(1);
    expect(registry.loadedModels().pi?.list).toEqual(CATALOGUE);
    expect(askedTimes(env)).toBe(1);
  });

  test("a stale file starts one background refresh and later reads see the new list", async () => {
    const env = await fakePi(catalogueBody());
    let at = 1_000;
    writeKept(env, ["old/one"], at);
    at += PI_LIST_CACHE_MS;
    const registry = registryFor(env, {}, { now: () => at });
    expect(registry.loadedModels().pi?.list).toEqual(["old/one"]);
    expect(registry.loadedModels().pi?.list).toEqual(["old/one"]);
    const ready = await registry.loadedModelsReady();
    expect(ready.pi?.list).toEqual(CATALOGUE);
    expect(askedTimes(env)).toBe(1);
    expect(registry.loadedModels().pi?.list).toEqual(CATALOGUE);
    expect(askedTimes(env)).toBe(1);
  });

  test("two readers at once start one refresh", async () => {
    const env = await fakePi(catalogueBody());
    const registry = registryFor(env, {});
    const [first, second] = await Promise.all([
      registry.loadedModelsReady(),
      registry.loadedModelsReady(),
    ]);
    expect(first.pi?.list).toEqual(CATALOGUE);
    expect(second.pi?.list).toEqual(CATALOGUE);
    expect(askedTimes(env)).toBe(1);
  });

  test("a failed refresh keeps the old list and is logged once", async () => {
    const env = await fakePi("exit 3");
    let at = 1_000;
    writeKept(env, ["old/one"], at);
    at += PI_LIST_CACHE_MS;
    const logs: string[] = [];
    const registry = registryFor(env, {}, { now: () => at, log: (message) => logs.push(message) });
    expect(registry.loadedModels().pi?.list).toEqual(["old/one"]);
    expect((await registry.loadedModelsReady()).pi?.list).toEqual(["old/one"]);
    expect(registry.loadedModels().pi?.list).toEqual(["old/one"]);
    expect(registry.loadedModels().pi?.list).toEqual(["old/one"]);
    expect(askedTimes(env)).toBe(1);
    expect(logs.filter((message) => message.includes("did not answer"))).toHaveLength(1);
  });

  test("a pi that exits non-zero with no kept list gives an empty list", async () => {
    const env = await fakePi(`${catalogueBody()}\nexit 3`);
    const registry = registryFor(env, {});
    expect((await registry.loadedModelsReady()).pi?.list).toEqual([]);
    expect(askedTimes(env)).toBe(1);
  });

  test("a missing pi gives an empty list", async () => {
    const env = await fakePi("exit 0");
    const registry = registryFor({ ...env, fake: join(env.root, "no-such-pi") }, {});
    expect((await registry.loadedModelsReady()).pi?.list).toEqual([]);
  });

  test("a pi that does not answer in time gives an empty list", async () => {
    const env = await fakePi("exec sleep 30");
    const registry = registryFor(env, {}, { listTimeoutMs: 200 });
    expect((await registry.loadedModelsReady()).pi?.list).toEqual([]);
  });

  test("the models setting wins and asks nothing", async () => {
    const env = await fakePi(catalogueBody());
    const models = registryFor(env, { models: ["zai/glm-5"] }).loadedModels().pi;
    expect(models?.list).toEqual(["zai/glm-5"]);
    expect(askedTimes(env)).toBe(0);
  });

  test("the default is the model setting, else pi's own default, else none", async () => {
    const env = await fakePi(catalogueBody());
    writeKept(env, CATALOGUE, 1_000);
    const now = () => 2_000;
    writeFileSync(env.settingsPath, JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5" }));
    expect(registryFor(env, { model: "openai/gpt-5" }, { now }).loadedModels().pi?.default).toBe("openai/gpt-5");
    expect(registryFor(env, {}, { now }).loadedModels().pi?.default).toBe("zai/glm-5");
    writeFileSync(env.settingsPath, JSON.stringify({ defaultProvider: "zai", defaultModel: "gone" }));
    expect(registryFor(env, {}, { now }).loadedModels().pi?.default).toBeNull();
    expect(askedTimes(env)).toBe(0);
  });
});
