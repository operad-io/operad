/**
 * The plugin docs cover what a plugin can import. Every value that
 * `@operad-io/engine`, `@operad-io/engine/platform` and `@operad-io/engine/testing`
 * export has an entry (a code span in the first cell of a table row) under
 * docs/plugins, unless `plugin-docs.allow.json` lists it with the reason it is
 * internal to the host. An allowed name that is documented now, that no longer
 * exists, or that a plugin package imports fails too, so the list only shrinks.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as main from "@operad-io/engine";
import * as platform from "@operad-io/engine/platform";
import * as testing from "@operad-io/engine/testing";

const root = resolve(import.meta.dir, "..", "..");
const pluginDocs = join(root, "docs", "plugins");

const ENTRIES: Readonly<Record<string, readonly string[]>> = {
  "@operad-io/engine": Object.keys(main),
  "@operad-io/engine/platform": Object.keys(platform),
  "@operad-io/engine/testing": Object.keys(testing),
};

/** Packages that are hosts of plugins, not plugins: they may use what a plugin does not. */
const HOSTS = new Set(["engine", "cli", "mcp", "tui"]);

const allow = JSON.parse(readFileSync(join(import.meta.dir, "plugin-docs.allow.json"), "utf8")) as {
  readonly exports: Readonly<Record<string, string>>;
};

function walk(dir: string, keep: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path, keep));
    else if (keep(path)) found.push(path);
  }
  return found;
}

/** The first cell of every table row of the page text, outside code fences. */
export function firstCells(text: string): string[] {
  const cells: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    if (fence || !line.startsWith("|")) continue;
    cells.push((line.slice(1).split("|")[0] ?? "").trim());
  }
  return cells;
}

/** True when a first cell names `name` as a code span. */
export function documents(cells: readonly string[], name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\`${escaped}(?![\\w$])`);
  return cells.some((cell) => pattern.test(cell));
}

function pluginPages(): string[] {
  return walk(pluginDocs, (path) => path.endsWith(".md")).sort();
}

function allCells(): string[] {
  return pluginPages().flatMap((path) => firstCells(readFileSync(path, "utf8")));
}

/** The names the source of every plugin package imports from the engine entry points. */
export function importedByPlugins(): Map<string, string> {
  const found = new Map<string, string>();
  const packages = join(root, "packages");
  const dirs: string[] = [];
  for (const name of readdirSync(packages)) {
    if (name === "harness") {
      for (const child of readdirSync(join(packages, name))) dirs.push(join(packages, name, child));
    } else if (!HOSTS.has(name)) {
      dirs.push(join(packages, name));
    }
  }
  for (const dir of dirs) {
    for (const file of walk(join(dir, "src"), (path) => path.endsWith(".ts"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(@operad-io\/engine(?:\/platform|\/testing)?)"/g)) {
        for (const raw of (match[1] ?? "").split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0]?.trim() ?? "";
          if (/^type\s/.test(name) || name === "" || /^[A-Z][A-Za-z]*$/.test(name) && !(name in main) && !(name in platform)) continue;
          found.set(`${match[2] ?? ""}:${name}`, relative(root, file));
        }
      }
    }
  }
  return found;
}

describe("the plugin docs", () => {
  test("every export a plugin can import has an entry under docs/plugins", () => {
    const cells = allCells();
    const problems: string[] = [];
    const all = new Set<string>();
    for (const [entry, names] of Object.entries(ENTRIES)) {
      for (const name of names) {
        const id = `${entry}:${name}`;
        all.add(id);
        const reason = allow.exports[id];
        const has = documents(cells, name);
        if (!has && reason === undefined) problems.push(`${id} has no entry under docs/plugins`);
      }
    }
    for (const [id, reason] of Object.entries(allow.exports)) {
      const name = id.slice(id.lastIndexOf(":") + 1);
      if (reason.trim() === "") problems.push(`allow list: ${id} has no reason`);
      else if (!all.has(id)) problems.push(`allow list: ${id} no longer exists; remove it`);
      else if (documents(cells, name)) problems.push(`allow list: ${id} is documented now; remove it`);
    }
    expect(problems).toEqual([]);
  });

  test("a name a plugin package imports is never on the allow list", () => {
    const used = importedByPlugins();
    expect(used.size).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const [id, file] of used) {
      if (allow.exports[id] !== undefined) problems.push(`${id} is imported by ${file} and cannot be allowed`);
    }
    expect(problems).toEqual([]);
  });

  test("the entry points export what the pages name", () => {
    for (const name of ["definePlugin", "defineFlow"]) expect(ENTRIES["@operad-io/engine"]).toContain(name);
    for (const name of ["runLine", "withLockFile", "watchDirectory", "enableWal"]) {
      expect(ENTRIES["@operad-io/engine/platform"]).toContain(name);
    }
    for (const name of ["runFlow", "answer", "emit", "testWorld"]) expect(ENTRIES["@operad-io/engine/testing"]).toContain(name);
  });

  test("the lookup finds a code span in a first cell and nothing else", () => {
    const cells = firstCells("| `runFlow(plugin, flow)` | x |\n|---|---|\n| `a`, `b` | y |\n\n```\n| `fenced` | z |\n```\nnot a row `plain`\n");
    expect(documents(cells, "runFlow")).toBe(true);
    expect(documents(cells, "b")).toBe(true);
    expect(documents(cells, "run")).toBe(false);
    expect(documents(cells, "fenced")).toBe(false);
    expect(documents(cells, "plain")).toBe(false);
  });

  test("every page is listed on the index", () => {
    // Links between the pages are checked by docs-coverage.test.ts.
    const index = readFileSync(join(pluginDocs, "index.md"), "utf8");
    for (const path of pluginPages()) {
      const name = path.slice(pluginDocs.length + 1);
      if (name !== "index.md") expect(index).toContain(`](${name})`);
    }
  });
});
