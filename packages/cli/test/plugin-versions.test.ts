import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfiesRange } from "@operad-io/engine";

const packages = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** Every package directory under `packages/` (and one level below, for harness/*) with a plugin entry point. */
function pluginDirs(): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(join(packages, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const child = join(dir, entry.name);
      if (existsSync(join(packages, child, "src/index.ts")) && existsSync(join(packages, child, "package.json"))) found.push(child);
      else if (dir === "") visit(child);
    }
  };
  visit("");
  return found.sort();
}

interface Shipped {
  readonly name: string;
  readonly version: string;
  readonly packageVersion: string;
  readonly requires: { readonly plugins?: Readonly<Record<string, string>> } | undefined;
}

async function load(dir: string): Promise<Shipped | undefined> {
  const manifest = JSON.parse(readFileSync(join(packages, dir, "package.json"), "utf8")) as { version: string };
  const module = (await import(join(packages, dir, "src/index.ts"))) as { default?: Partial<Shipped> & { kind?: string } };
  const plugin = module.default;
  if (plugin === undefined || typeof plugin.name !== "string" || typeof plugin.version !== "string" || plugin.kind === undefined) {
    return undefined;
  }
  return { name: plugin.name, version: plugin.version, packageVersion: manifest.version, requires: plugin.requires };
}

const shipped = (await Promise.all(pluginDirs().map(load))).filter((plugin): plugin is Shipped => plugin !== undefined);

describe("plugin versions", () => {
  test("every plugin package is found", () => {
    expect(shipped.map((plugin) => plugin.name)).toEqual(expect.arrayContaining(["bot", "chat", "dev", "pool", "shell"]));
  });

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
