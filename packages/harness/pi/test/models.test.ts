import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginRegistry, MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import { cleanupTempRoots, tempRoot, waitForFile } from "../../process/test/support.ts";
import { createPiHarnessPlugin } from "../src/index.ts";
import {
  parsePiCatalogue,
  parsePiCatalogueModels,
  parsePiCatalogueRows,
  parsePiRegistry,
  PI_LIST_CACHE_MS,
  piModelListPath,
  refreshPiModelList,
} from "../src/model-list.ts";

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
  writeFileSync(path, JSON.stringify({ at, list }));
}

/** Writes the registry store pi keeps beside its models file. */
function writeRegistry(env: Env, value: unknown): void {
  writeFileSync(join(env.root, "models-store.json"), JSON.stringify(value));
}

function askedTimes(env: Env): number {
  return existsSync(env.asked) ? readFileSync(env.asked, "utf8").trim().split("\n").length : 0;
}

function registryFor(
  env: Env,
  settings: Record<string, unknown>,
  extra: {
    now?: () => number;
    listTimeoutMs?: number;
    log?: (message: string) => void;
    readFile?: (path: string) => string;
  } = {},
): PluginRegistry {
  const plugin = createPiHarnessPlugin({
    piSettingsPath: env.settingsPath,
    ...(extra.now === undefined ? {} : { now: extra.now }),
    ...(extra.listTimeoutMs === undefined ? {} : { listTimeoutMs: extra.listTimeoutMs }),
    ...(extra.readFile === undefined ? {} : { readFile: extra.readFile }),
  });
  return new PluginRegistry([plugin], {
    home: env.root,
    cwd: env.root,
    store: new MemoryPluginStore({ root: join(env.root, "store") }),
    settings: {
      pi: { command: env.fake, modelsPath: join(env.root, "models.json"), ...settings },
    },
    onLog: extra.log ?? (() => undefined),
  });
}

describe("the models pi declares", () => {
  test("parsePiCatalogue reads provider/id from each row and skips the header", () => {
    expect(parsePiCatalogue(TABLE)).toEqual(CATALOGUE);
  });

  test("each row's context column becomes its context window", () => {
    expect(parsePiCatalogueRows(TABLE)).toEqual([
      { name: "openai/gpt-5", window: 400_000 },
      { name: "opencode-go/deepseek-v4.1-flash", window: 128_000 },
      { name: "zai/glm-5", window: 200_000 },
    ]);
  });

  test("pi's registry fills a model's name, provider, vision and reasoning", () => {
    expect(
      parsePiRegistry({
        openai: {
          models: [
            { id: "gpt-5", name: "GPT-5", provider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 400_000 },
            { id: "gpt-4", name: "GPT-4", provider: "openai", reasoning: false, input: ["text"] },
          ],
        },
      }),
    ).toEqual({
      "openai/gpt-5": {
        id: "openai/gpt-5",
        name: "GPT-5",
        provider: "openai",
        window: 400_000,
        capabilities: ["vision", "reasoning"],
      },
      "openai/gpt-4": { id: "openai/gpt-4", name: "GPT-4", provider: "openai" },
    });
  });

  test("the kept list and the registry together describe each offered model", async () => {
    const env = await fakePi(catalogueBody());
    writeKept(env, CATALOGUE, Date.now());
    writeRegistry(env, {
      openai: {
        models: [{ id: "gpt-5", name: "GPT-5", reasoning: true, input: ["text", "image"] }],
      },
      "opencode-go": {
        models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: false, input: ["text"] }],
      },
    });
    const models = registryFor(env, {}).loadedModels().pi;
    expect(models?.info?.["openai/gpt-5"]).toEqual({
      id: "openai/gpt-5",
      name: "GPT-5",
      provider: "openai",
      capabilities: ["vision", "reasoning"],
    });
    expect(models?.info?.["opencode-go/deepseek-v4.1-flash"]).toEqual({
      id: "opencode-go/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      provider: "opencode-go",
    });
  });

  test("a table without a name column still gives each row's provider and known capabilities", () => {
    expect(parsePiCatalogueModels(TABLE)).toEqual([
      {
        name: "openai/gpt-5",
        provider: "openai",
        window: 400_000,
        capabilities: ["reasoning", "vision"],
      },
      { name: "opencode-go/deepseek-v4.1-flash", provider: "opencode-go", window: 128_000 },
      { name: "zai/glm-5", provider: "zai", window: 200_000, capabilities: ["reasoning"] },
    ]);
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

  test("a configured credentials file is read with pi's other files, and none of them is changed", async () => {
    const env = await fakePi("");
    const seen = join(env.root, "seen");
    const read = 'for f in auth.json models.json models-store.json settings.json; do echo "$f=$(cat "$PI_CODING_AGENT_DIR/$f" 2>/dev/null)"; done';
    writeFileSync(env.fake, `#!/bin/sh\n${read} > "${seen}"\n`);
    const own = join(env.root, "agent");
    const other = join(env.root, "other");
    mkdirSync(own);
    mkdirSync(other);
    writeFileSync(join(own, "auth.json"), "own-auth");
    writeFileSync(join(own, "settings.json"), "own-settings");
    writeFileSync(join(other, "creds.json"), "other-auth");
    writeFileSync(join(other, "my-models.json"), "other-models");
    const files = { agentDir: own, authPath: join(other, "creds.json"), modelsPath: join(other, "my-models.json") };
    let now = 0;
    const ask = () => refreshPiModelList({ home: env.root, command: env.fake, now: () => now, files });

    await ask();
    expect(readFileSync(seen, "utf8")).toBe(
      "auth.json=other-auth\nmodels.json=other-models\nmodels-store.json=\nsettings.json=own-settings\n",
    );
    // A later ask sees what changed since, in the same folder.
    writeFileSync(join(other, "models-store.json"), "other-store");
    rmSync(join(other, "my-models.json"));
    now = PI_LIST_CACHE_MS;
    await ask();
    expect(readFileSync(seen, "utf8")).toBe(
      "auth.json=other-auth\nmodels.json=\nmodels-store.json=other-store\nsettings.json=own-settings\n",
    );
    expect(readFileSync(join(own, "auth.json"), "utf8")).toBe("own-auth");
    expect(readFileSync(join(other, "creds.json"), "utf8")).toBe("other-auth");
  });

  test("with pi's default credentials file, pi is left to find its own folder", async () => {
    const env = await fakePi("");
    const seen = join(env.root, "seen");
    writeFileSync(env.fake, `#!/bin/sh\necho "\${PI_CODING_AGENT_DIR-unset}" > "${seen}"\n`);
    await registryFor(env, {}).loadedModelsReady();
    expect(readFileSync(seen, "utf8").trim()).toBe(process.env.PI_CODING_AGENT_DIR ?? "unset");
  });

  test("first use with no kept file waits for one refresh", async () => {
    const env = await fakePi(catalogueBody());
    const registry = registryFor(env, {});
    expect(await registry.loadedModelsReady()).toEqual({
      pi: {
        list: CATALOGUE,
        default: null,
        windows: {
          "openai/gpt-5": 400_000,
          "opencode-go/deepseek-v4.1-flash": 128_000,
          "zai/glm-5": 200_000,
        },
        info: {
          "openai/gpt-5": {
            id: "openai/gpt-5",
            provider: "openai",
            window: 400_000,
            capabilities: ["vision", "reasoning"],
          },
          "opencode-go/deepseek-v4.1-flash": {
            id: "opencode-go/deepseek-v4.1-flash",
            provider: "opencode-go",
            window: 128_000,
          },
          "zai/glm-5": {
            id: "zai/glm-5",
            provider: "zai",
            window: 200_000,
            capabilities: ["reasoning"],
          },
        },
      },
    });
    expect(askedTimes(env)).toBe(1);
    expect(registry.loadedModels().pi?.list).toEqual(CATALOGUE);
    expect(askedTimes(env)).toBe(1);
  });

  test("a stale file starts one background refresh and later reads see the new list", async () => {
    const env = await fakePi(catalogueBody());
    const releasePath = join(env.root, "release");
    writeFileSync(
      env.fake,
      `#!/bin/sh\necho x >> "${env.asked}"\nwhile [ ! -f "${releasePath}" ]; do sleep 0.01; done\n${catalogueBody()}\n`,
    );
    let at = 1_000;
    writeKept(env, ["old/one"], at);
    at += PI_LIST_CACHE_MS;
    const registry = registryFor(env, {}, { now: () => at });
    expect(registry.loadedModels().pi?.list).toEqual(["old/one"]);
    expect(registry.loadedModels().pi?.list).toEqual(["old/one"]);
    await waitForFile(env.asked);
    // The stale rows answer at once, while the one refresh waits behind them.
    expect((await registry.loadedModelsReady()).pi?.list).toEqual(["old/one"]);
    writeFileSync(releasePath, "go");
    await refreshPiModelList({ home: env.root, command: env.fake, now: () => at });
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
    await waitForFile(env.asked);
    expect((await registry.loadedModelsReady()).pi?.list).toEqual(["old/one"]);
    await refreshPiModelList({ home: env.root, command: env.fake, now: () => at });
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

  test("one models read reads each pi file once and leaves an unchanged registry unread", async () => {
    const env = await fakePi(catalogueBody());
    writeKept(env, CATALOGUE, Date.now());
    writeRegistry(env, {
      zai: { models: [{ id: "glm-5", name: "GLM-5", reasoning: true, input: ["text"] }] },
    });
    writeFileSync(env.settingsPath, JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5" }));
    const reads = new Map<string, number>();
    const readFile = (path: string): string => {
      const name = basename(path);
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return readFileSync(path, "utf8");
    };
    const registry = registryFor(env, {}, { readFile });
    const models = registry.loadedModels().pi;
    expect(models?.default).toBe("zai/glm-5");
    expect(models?.info?.["zai/glm-5"]?.name).toBe("GLM-5");
    expect(reads.get("model-list.json")).toBe(1);
    expect(reads.get("models-store.json")).toBe(1);
    expect(reads.get("pi-settings.json")).toBe(1);

    const again = registry.loadedModels().pi;
    expect(again?.info?.["zai/glm-5"]?.name).toBe("GLM-5");
    expect(reads.get("model-list.json")).toBe(2);
    expect(reads.get("pi-settings.json")).toBe(2);
    expect(reads.get("models-store.json")).toBe(1);
  });

  test("a changed registry file is read again and its new description is seen", async () => {
    const env = await fakePi(catalogueBody());
    writeKept(env, CATALOGUE, Date.now());
    writeRegistry(env, {
      zai: { models: [{ id: "glm-5", name: "GLM-5", reasoning: true }] },
    });
    let reads = 0;
    const readFile = (path: string): string => {
      if (basename(path) === "models-store.json") reads += 1;
      return readFileSync(path, "utf8");
    };
    const registry = registryFor(env, {}, { readFile });
    expect(registry.loadedModels().pi?.info?.["zai/glm-5"]?.name).toBe("GLM-5");
    expect(reads).toBe(1);

    const path = join(env.root, "models-store.json");
    writeRegistry(env, {
      zai: { models: [{ id: "glm-5", name: "GLM-5 later", reasoning: true }] },
    });
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    expect(registry.loadedModels().pi?.info?.["zai/glm-5"]?.name).toBe("GLM-5 later");
    expect(reads).toBe(2);
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
