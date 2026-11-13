import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfiesRange } from "@operad-io/engine";

const packages = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** Every package that ships a plugin, by directory under `packages/`. */
const SHIPPING = [
  "bot",
  "chat",
  "dev",
  "pool",
  "shell",
  "source-cron",
  "harness/claude",
  "harness/codex",
  "harness/pi",
  "harness/radian",
];

interface Shipped {
  readonly name: string;
  readonly version: string;
  readonly packageVersion: string;
  readonly requires: { readonly plugins?: Readonly<Record<string, string>> } | undefined;
}

async function load(dir: string): Promise<Shipped> {
  const manifest = JSON.parse(readFileSync(join(packages, dir, "package.json"), "utf8")) as { version: string };
  const module = (await import(join(packages, dir, "src/index.ts"))) as {
    default: { name: string; version: string; requires?: Shipped["requires"] };
  };
  const plugin = module.default;
  return { name: plugin.name, version: plugin.version, packageVersion: manifest.version, requires: plugin.requires };
}

const shipped = await Promise.all(SHIPPING.map(load));

describe("plugin versions", () => {
  for (const plugin of shipped) {
    test(`${plugin.name} reports the version of the package that ships it`, () => {
      expect(plugin.version).toBe(plugin.packageVersion);
    });
  }

  test("every plugin's requirements are met by the versions in this workspace", () => {
    const versions = new Map(shipped.map((plugin) => [plugin.name, plugin.packageVersion]));
    for (const plugin of shipped) {
      for (const [dependency, range] of Object.entries(plugin.requires?.plugins ?? {})) {
        const version = versions.get(dependency);
        expect(version, `${plugin.name} requires ${dependency}, which no package here ships`).toBeDefined();
        if (version === undefined) continue;
        expect(satisfiesRange(version, range), `${plugin.name} requires ${dependency} ${range}; workspace has ${version}`).toBe(true);
      }
    }
  });
});
