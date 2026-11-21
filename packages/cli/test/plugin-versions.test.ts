import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, normalizeActionArgs, satisfiesRange } from "@operad-io/engine";

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
  readonly settings: unknown;
  readonly projectSettings: {
    readonly files?: readonly { readonly name?: string; readonly schema?: unknown }[];
  } | undefined;
}

async function load(dir: string): Promise<Shipped | undefined> {
  const manifest = JSON.parse(readFileSync(join(packages, dir, "package.json"), "utf8")) as { version: string };
  const module = (await import(join(packages, dir, "src/index.ts"))) as { default?: Partial<Shipped> & { kind?: string } };
  const plugin = module.default;
  if (plugin === undefined || typeof plugin.name !== "string" || typeof plugin.version !== "string" || plugin.kind === undefined) {
    return undefined;
  }
  return {
    name: plugin.name,
    version: plugin.version,
    packageVersion: manifest.version,
    requires: plugin.requires,
    settings: plugin.settings,
    projectSettings: plugin.projectSettings,
  };
}

/** The settable rows of a settings schema that have no title, by their path. */
function untitled(schema: unknown): string[] {
  const missing: string[] = [];
  const walk = (node: Readonly<Record<string, unknown>>, path: string): void => {
    if (!isRecord(node.properties)) return;
    for (const [name, child] of Object.entries(node.properties)) {
      if (!isRecord(child)) continue;
      const here = path === "" ? name : `${path}.${name}`;
      // A group is walked into; every other property is a row a client shows.
      if (isRecord(child.properties) && child.editable !== true) {
        walk(child, here);
        continue;
      }
      if (typeof child.title !== "string" || child.title.trim() === "") missing.push(here);
    }
  };
  if (isRecord(schema)) walk(schema, "");
  return missing;
}

/** The title of every property a schema titles, by its path; local `$ref`s are followed. */
function titles(schema: unknown): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const resolve = (node: unknown): unknown => {
    let current = node;
    while (isRecord(current) && typeof current.$ref === "string" && current.$ref.startsWith("#/")) {
      let target: unknown = schema;
      for (const part of current.$ref.slice(2).split("/")) {
        target = isRecord(target) ? target[part] : undefined;
      }
      current = target;
    }
    return current;
  };
  const walk = (node: unknown, path: string): void => {
    const current = resolve(node);
    if (!isRecord(current) || !isRecord(current.properties)) return;
    for (const [name, child] of Object.entries(current.properties)) {
      const here = path === "" ? name : `${path}.${name}`;
      const target = resolve(child);
      if (!isRecord(target)) continue;
      if (typeof target.title === "string" && target.title.trim() !== "") found.set(here, target.title);
      walk(target, here);
    }
  };
  walk(schema, "");
  return found;
}

const shipped = (await Promise.all(pluginDirs().map(load))).filter((plugin): plugin is Shipped => plugin !== undefined);

function pluginNamed(name: string): Shipped {
  const found = shipped.find((plugin) => plugin.name === name);
  if (found === undefined) throw new Error(`no shipped plugin named ${name}`);
  return found;
}

function pluginSettings(plugin: Shipped): unknown {
  if (plugin.settings === undefined) throw new Error(`plugin ${plugin.name} declares no settings`);
  return plugin.settings;
}

function projectFileSchema(plugin: Shipped, name: string): unknown {
  const file = (plugin.projectSettings?.files ?? []).find((entry) => entry.name === name);
  if (file === undefined) throw new Error(`plugin ${plugin.name} declares no ${name} project file`);
  return file.schema;
}

describe("plugin versions", () => {
  test("every plugin package is found", () => {
    expect(shipped.map((plugin) => plugin.name)).toEqual(expect.arrayContaining(["bot", "chat", "dev", "pool", "shell"]));
  });

  for (const plugin of shipped) {
    test(`${plugin.name} reports the version of the package that ships it`, () => {
      expect(plugin.version).toBe(plugin.packageVersion);
    });
  }

  test("every setting a client shows has a short title", () => {
    for (const plugin of shipped) {
      if (plugin.settings !== undefined) {
        const schema = normalizeActionArgs(plugin.settings, `${plugin.name}: settings`);
        expect(untitled(schema), `${plugin.name}.settings`).toEqual([]);
      }
      for (const file of plugin.projectSettings?.files ?? []) {
        const schema = normalizeActionArgs(file.schema, `${plugin.name}.${file.name ?? "project"}: settings`);
        expect(untitled(schema), `${plugin.name}.${file.name ?? "project"}`).toEqual([]);
      }
    }
  });

  test("a plugin's settings have distinct titles", () => {
    for (const plugin of shipped) {
      const seen = new Map<string, string>();
      const duplicates: string[] = [];
      const schemas: { readonly name: string; readonly schema: unknown }[] = [];
      if (plugin.settings !== undefined) schemas.push({ name: `${plugin.name}.settings`, schema: plugin.settings });
      for (const file of plugin.projectSettings?.files ?? []) {
        schemas.push({ name: `${plugin.name}.${file.name ?? "project"}`, schema: file.schema });
      }
      for (const { name, schema } of schemas) {
        for (const [path, title] of titles(schema)) {
          const previous = seen.get(title);
          if (previous === undefined) seen.set(title, `${name}.${path}`);
          else duplicates.push(`"${title}" is at ${previous} and ${name}.${path}`);
        }
      }
      expect(duplicates, plugin.name).toEqual([]);
    }
  });

  test("the schema files a package ships carry the titles its plugin declares", () => {
    const dev = pluginNamed("dev");
    const cases: readonly {
      readonly file: string;
      readonly schema: unknown;
      // The read-only list of repository flows is derived, not part of dev.json.
      readonly skip: readonly string[];
    }[] = [
      { file: join(packages, "dev", "dev.schema.json"), schema: projectFileSchema(dev, "dev"), skip: ["flowList"] },
      { file: join(packages, "review-grading", "review.schema.json"), schema: projectFileSchema(dev, "review"), skip: [] },
      { file: join(packages, "bot", "bot.schema.json"), schema: pluginSettings(pluginNamed("bot")), skip: [] },
      { file: join(packages, "memory", "memory.schema.json"), schema: pluginSettings(pluginNamed("memory")), skip: [] },
      { file: join(packages, "telegram", "telegram.schema.json"), schema: pluginSettings(pluginNamed("telegram")), skip: [] },
    ];
    for (const item of cases) {
      const declared = titles(item.schema);
      const inFile = titles(JSON.parse(readFileSync(item.file, "utf8")) as unknown);
      const wrong: string[] = [];
      for (const [path, title] of declared) {
        if (item.skip.includes(path)) continue;
        const found = inFile.get(path);
        if (found !== title) wrong.push(`${path}: expected "${title}", found ${found === undefined ? "none" : `"${found}"`}`);
      }
      expect(wrong, basename(item.file)).toEqual([]);
    }
  });

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

  test("no requirement accepts a future incompatible version of the plugin it names", () => {
    const versions = new Map(shipped.map((plugin) => [plugin.name, plugin.packageVersion]));
    for (const plugin of shipped) {
      for (const [dependency, range] of Object.entries(plugin.requires?.plugins ?? {})) {
        const version = versions.get(dependency);
        if (version === undefined) continue;
        const [major = 0, minor = 0] = version.split(".").map(Number);
        const next = major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
        expect(satisfiesRange(next, range), `${plugin.name} requires ${dependency} ${range}, which accepts ${next}`).toBe(false);
      }
    }
  });
});
