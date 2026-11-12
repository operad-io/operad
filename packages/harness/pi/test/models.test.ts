import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "@operad-io/harness-process/test-support";
import { createPiHarnessPlugin, parsePiCatalogue } from "../src/index.ts";

afterAll(cleanupTempRoots);

const TABLE = [
  "provider     model              context  max-out  thinking  images",
  "openai       gpt-5              400K     128K     yes       yes",
  "opencode-go  deepseek-v4.1-flash  128K   32K      no        no",
  "zai          glm-5              200K     64K      yes       no",
  "",
].join("\n");

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

function registryFor(
  env: Env,
  settings: Record<string, unknown>,
  extra: { now?: () => number; listTimeoutMs?: number } = {},
): PluginRegistry {
  const plugin = createPiHarnessPlugin({ piSettingsPath: env.settingsPath, ...extra });
  return new PluginRegistry([plugin], {
    home: env.root,
    cwd: env.root,
    store: new MemoryPluginStore({ root: join(env.root, "store") }),
    settings: { pi: { command: env.fake, ...settings } },
  });
}

describe("the models pi declares", () => {
  test("parsePiCatalogue reads provider/id from each row and skips the header", () => {
    expect(parsePiCatalogue(TABLE)).toEqual([
      "openai/gpt-5",
      "opencode-go/deepseek-v4.1-flash",
      "zai/glm-5",
    ]);
  });

  test("the list is pi's catalogue", async () => {
    const env = await fakePi(catalogueBody());
    const models = registryFor(env, {}).loadedModels().pi;
    expect(models?.list).toEqual(["openai/gpt-5", "opencode-go/deepseek-v4.1-flash", "zai/glm-5"]);
    expect(models?.default).toBeNull();
  });

  test("the models setting narrows the list", async () => {
    const env = await fakePi(catalogueBody());
    const models = registryFor(env, { models: ["zai/glm-5"] }).loadedModels().pi;
    expect(models?.list).toEqual(["zai/glm-5"]);
  });

  test("the default is the model setting, else pi's own default, else none", async () => {
    const env = await fakePi(catalogueBody());
    writeFileSync(env.settingsPath, JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5" }));
    expect(registryFor(env, { model: "openai/gpt-5" }).loadedModels().pi?.default).toBe("openai/gpt-5");
    expect(registryFor(env, {}).loadedModels().pi?.default).toBe("zai/glm-5");
    writeFileSync(env.settingsPath, JSON.stringify({ defaultProvider: "zai", defaultModel: "gone" }));
    expect(registryFor(env, {}).loadedModels().pi?.default).toBeNull();
  });

  test("a pi that exits non-zero gives an empty list", async () => {
    const env = await fakePi(`${catalogueBody()}\nexit 3`);
    const models = registryFor(env, {}).loadedModels().pi;
    expect(models?.list).toEqual([]);
    expect(models?.default).toBeNull();
  });

  test("a missing pi gives an empty list", async () => {
    const env = await fakePi("exit 0");
    const registry = registryFor({ ...env, fake: join(env.root, "no-such-pi") }, {});
    expect(registry.loadedModels().pi?.list).toEqual([]);
  });

  test("a pi that does not answer in time gives an empty list", async () => {
    const env = await fakePi("exec sleep 30");
    const models = registryFor(env, {}, { listTimeoutMs: 200 }).loadedModels().pi;
    expect(models?.list).toEqual([]);
  });

  test("pi is not asked at load, and the answer is kept until it is old", async () => {
    const env = await fakePi(catalogueBody());
    let at = 1_000;
    const registry = registryFor(env, {}, { now: () => at });
    expect(registry.names()).toEqual(["pi"]);
    expect(existsSync(env.asked)).toBe(false);
    registry.loadedModels();
    registry.loadedModels();
    expect(await Bun.file(env.asked).text()).toBe("x\n");
    at += 10 * 60_000;
    registry.loadedModels();
    expect(await Bun.file(env.asked).text()).toBe("x\nx\n");
  });
});
