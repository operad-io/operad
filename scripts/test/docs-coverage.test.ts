/**
 * The user docs cover what the code accepts. A schema property, an `OPERAD_*`
 * variable read by the code, a CLI command or option, and a link between pages
 * each fail here, with the item and the page it belongs on, until the page has
 * it. `docs-coverage.allow.json` lists the items that have no row yet or that
 * are internal only, each with a one-line reason; an entry whose item is now
 * documented (or no longer exists) fails too, so the list only shrinks.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main, type CliIo } from "../../packages/cli/src/main.ts";

const root = resolve(import.meta.dir, "..", "..");
const userDir = join(root, "docs", "user");

interface Allow {
  readonly schemaKeys: Readonly<Record<string, string>>;
  readonly envVars: Readonly<Record<string, string>>;
  readonly cliEntries: Readonly<Record<string, string>>;
}
const allow = JSON.parse(readFileSync(join(import.meta.dir, "docs-coverage.allow.json"), "utf8")) as Allow;

// ── files ──────────────────────────────────────────────────────────────────

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

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const userPages = (): string[] => walk(userDir, (path) => path.endsWith(".md")).sort();
const page = (name: string): string => join(userDir, name);

// ── table rows ─────────────────────────────────────────────────────────────

/** The first cell of every table row on one page under docs/user. */
function firstCells(name: string): string[] {
  const cells: string[] = [];
  for (const path of [page(name)]) {
    let fence = false;
    for (const line of read(path).split("\n")) {
      if (line.startsWith("```")) fence = !fence;
      if (fence || !line.startsWith("|")) continue;
      const cell = line.slice(1).split("|")[0] ?? "";
      cells.push(cell.trim());
    }
  }
  return cells;
}

/** True when a table row's first cell names `key` as a code span. */
function hasRow(cells: readonly string[], keys: readonly string[]): boolean {
  return cells.some((cell) => keys.some((key) => cell.includes(`\`${key}\``)));
}

// ── schema properties ──────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every dotted property path of a JSON Schema; array items add no segment. */
export function schemaPaths(schema: Json): string[] {
  const found = new Set<string>();
  const resolveRef = (ref: string): Json | undefined => {
    let at: unknown = schema;
    for (const part of ref.replace(/^#\/?/, "").split("/").filter((p) => p.length > 0)) {
      at = isJson(at) ? at[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    }
    return isJson(at) ? at : undefined;
  };
  const visit = (node: unknown, path: string, refs: readonly string[]): void => {
    if (!isJson(node)) return;
    if (typeof node.$ref === "string") {
      if (refs.includes(node.$ref)) return;
      visit(resolveRef(node.$ref), path, [...refs, node.$ref]);
    }
    for (const word of ["oneOf", "anyOf", "allOf"]) {
      const list = node[word];
      if (Array.isArray(list)) for (const branch of list) visit(branch, path, refs);
    }
    if (isJson(node.items)) visit(node.items, path, refs);
    if (Array.isArray(node.prefixItems)) for (const item of node.prefixItems) visit(item, path, refs);
    const join = (name: string): string => (path === "" ? name : `${path}.${name}`);
    if (isJson(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        if (name === "$schema") continue;
        found.add(join(name));
        visit(child, join(name), refs);
      }
    }
    if (isJson(node.patternProperties)) {
      for (const child of Object.values(node.patternProperties)) {
        found.add(join("<name>"));
        visit(child, join("<name>"), refs);
      }
    }
    if (isJson(node.additionalProperties)) {
      found.add(join("<name>"));
      visit(node.additionalProperties, join("<name>"), refs);
    }
  };
  visit(schema, "", []);
  return [...found].sort();
}

interface SchemaItem {
  /** The allow-list key: where the schema is, then the path. */
  readonly id: string;
  /** The ways a table row may spell the key. */
  readonly spellings: readonly string[];
  /** The page the key belongs on. */
  readonly page: string;
}

/** Keys of config.json whose section has a page of its own. */
const CONFIG_SECTION_PAGES: Readonly<Record<string, string>> = {
  http: "http.md",
  mcp: "mcp.md",
  notify: "notifications.md",
};

const FILE_PAGES: Readonly<Record<string, string>> = {
  "config.schema.json": "config.md",
  "triggers.schema.json": "config.md",
  "keys.schema.json": "tui.md",
  "theme.schema.json": "tui.md",
  "tui.schema.json": "tui.md",
  "dev.schema.json": "dev.md",
  "review.schema.json": "dev.md",
  "bot.schema.json": "config.md",
  "access-user.schema.json": "access.md",
  "telegram.schema.json": "telegram.md",
};

/** Plugin settings are sections of config.json, so their keys are on config.md, unless the plugin has a page. */
const PLUGIN_PAGES: Readonly<Record<string, string>> = { telegram: "telegram.md" };

function schemaFiles(): string[] {
  return [
    ...walk(join(root, "packages"), (path) => path.endsWith(".schema.json") && !path.includes("/test/")),
  ].sort();
}

function packageEntries(): string[] {
  const entries: string[] = [];
  for (const base of [join(root, "packages"), join(root, "packages", "harness")]) {
    for (const name of readdirSync(base)) {
      const entry = join(base, name, "src", "index.ts");
      if (existsSync(entry)) entries.push(entry);
    }
  }
  return entries.sort();
}

async function schemaItems(): Promise<SchemaItem[]> {
  const items = new Map<string, SchemaItem>();
  for (const file of schemaFiles()) {
    const name = basename(file);
    const stem = name.replace(/\.schema\.json$/, "");
    for (const path of schemaPaths(JSON.parse(read(file)) as Json)) {
      const id = `${name} ${path}`;
      items.set(id, { id, spellings: [path, `${stem}.${path}`], page: (name === "config.schema.json" ? CONFIG_SECTION_PAGES[path.split(".")[0] ?? ""] : undefined) ?? FILE_PAGES[name] ?? "config.md" });
    }
  }
  for (const entry of packageEntries()) {
    const loaded = (await import(pathToFileURL(entry).href)) as { default?: unknown };
    const plugin = loaded.default;
    if (!isJson(plugin) || typeof plugin.name !== "string" || !isJson(plugin.settings)) continue;
    for (const path of schemaPaths(plugin.settings)) {
      const id = `plugin ${plugin.name} ${path}`;
      items.set(id, {
        id,
        spellings: [`${plugin.name}.${path}`, `plugins.${plugin.name}.settings.${path}`],
        page: PLUGIN_PAGES[plugin.name] ?? "config.md",
      });
    }
  }
  return [...items.values()];
}

// ── environment variables ──────────────────────────────────────────────────

/** The `OPERAD_*` variables the code reads or hands to a command it starts. */
export function envVariables(): string[] {
  const files = [
    ...walk(join(root, "packages"), (path) => /\/src\/.*\.(ts|sh)$/.test(path)),
    ...walk(join(root, "scripts"), (path) => /\.(ts|sh)$/.test(path)),
  ];
  const name = "(OPERAD_[A-Z0-9]+(?:_[A-Z0-9]+)*)";
  const patterns = [
    new RegExp(`process\\.env\\.${name}`, "g"),
    new RegExp(`\\benv\\.${name}`, "g"),
    new RegExp(`["']${name}["']`, "g"),
    new RegExp(`\\b${name}\\s*:`, "g"),
    new RegExp(`\\b${name}=`, "g"),
    new RegExp(`^# ${name}\\b`, "gm"),
  ];
  const shell = [new RegExp(`\\$\\{?${name}`, "g")];
  const found = new Set<string>();
  for (const file of files) {
    const text = read(file);
    for (const pattern of file.endsWith(".sh") ? [...patterns, ...shell] : patterns) {
      for (const match of text.matchAll(pattern)) found.add(match[1] ?? "");
    }
  }
  found.delete("");
  return [...found].sort();
}

// ── CLI ────────────────────────────────────────────────────────────────────

/** The commands and options of the table `operad help` prints. */
async function cliEntries(): Promise<{ commands: string[]; options: string[] }> {
  let text = "";
  const io: CliIo = { write: (chunk) => void (text += chunk), error: () => {} };
  await main(["help"], { io, home: join(root, ".docs-coverage-no-home") });
  const commands = new Set<string>();
  const options = new Set<string>();
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) options.add(match[0]);
    if (!/^ {2}\S/.test(line)) continue;
    const head = line.trim().split(/\s{2,}/)[0] ?? "";
    const words: string[] = [];
    for (const word of head.split(/\s+/)) {
      if (/^[<\[-]/.test(word)) break;
      words.push(word);
    }
    // The command is the words before the first argument; a description
    // follows a gap of two spaces, or an argument.
    const command = words.join(" ");
    if (command !== "") commands.add(command);
  }
  // A loaded plugin adds `<plugin> <verb>` commands and the options their usage text names.
  for (const entry of packageEntries()) {
    const loaded = (await import(pathToFileURL(entry).href)) as { default?: unknown };
    const plugin = loaded.default;
    if (!isJson(plugin) || typeof plugin.name !== "string" || !Array.isArray(plugin.commands)) continue;
    for (const command of plugin.commands) {
      if (!isJson(command) || typeof command.name !== "string") continue;
      commands.add(`${plugin.name} ${command.name}`);
      const usage = typeof command.args === "string" ? command.args : "";
      for (const match of usage.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) options.add(match[0]);
    }
  }
  return { commands: [...commands].sort(), options: [...options].sort() };
}

function cliDocumented(text: string, entry: string): boolean {
  if (entry.startsWith("--")) {
    return new RegExp(`\`[^\`]*${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z-])[^\`]*\``).test(text);
  }
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\`(?:operad )?${escaped}(?=[ \`])`).test(text);
}

// ── links ──────────────────────────────────────────────────────────────────

function slugs(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^(```|````)/.test(line)) fence = !fence;
    const heading = fence ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null || heading === undefined) continue;
    const base = (heading[1] ?? "")
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${count}`);
  }
  return out;
}

/** Every broken link between the docs pages, as a line that names the page. */
export function brokenLinks(files: readonly string[]): string[] {
  const broken: string[] = [];
  for (const file of files) {
    let fence = false;
    const lines = read(file).split("\n");
    lines.forEach((raw, index) => {
      if (/^(```|````)/.test(raw)) fence = !fence;
      if (fence) return;
      const line = raw.replace(/`[^`]*`/g, "");
      for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = match[1] ?? "";
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const [pathPart = "", anchor] = target.split("#");
        const destination = pathPart === "" ? file : resolve(dirname(file), pathPart);
        const where = `${relative(root, file)}:${index + 1}`;
        if (!existsSync(destination)) {
          broken.push(`${where}: link to ${target} names a file that does not exist`);
        } else if (anchor !== undefined && anchor !== "" && destination.endsWith(".md")) {
          if (!slugs(read(destination)).has(anchor)) {
            broken.push(`${where}: link to ${target} names a heading that does not exist`);
          }
        }
      }
    });
  }
  return broken;
}

function docsPages(): string[] {
  return [
    ...walk(userDir, (path) => path.endsWith(".md")),
    ...walk(join(root, "docs", "plugins"), (path) => path.endsWith(".md")),
  ].sort();
}

// ── examples ───────────────────────────────────────────────────────────────

/** Each `<!-- schema: <file> -->` comment and the JSON block under it, by schema file. */
function schemaExamples(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /<!-- schema: ([^\s]+) -->\s*\n```json\n([\s\S]*?)\n```/g;
  for (const path of userPages()) {
    for (const match of read(path).matchAll(pattern)) {
      const name = match[1] ?? "";
      const text = match[2] ?? "";
      found.set(name, [...(found.get(name) ?? []), text]);
    }
  }
  return found;
}

function resolveRef(root: Json, ref: string): Json | undefined {
  let at: unknown = root;
  for (const part of ref.replace(/^#\/?/, "").split("/").filter((p) => p.length > 0)) {
    at = isJson(at) ? at[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  }
  return isJson(at) ? at : undefined;
}

function fitsType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isJson(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

/** The JSON Schema subset the config schemas use; an empty list means the value fits. */
function schemaErrors(schema: Json, value: unknown, at = "value", root: Json = schema): string[] {
  const errors: string[] = [];
  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref);
    if (target !== undefined) errors.push(...schemaErrors(target, value, at, root));
    return errors;
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.filter(isJson);
    const fitting = branches.filter((branch) => schemaErrors(branch, value, at, root).length === 0);
    if (fitting.length !== 1) errors.push(`${at}: must fit exactly one of the allowed forms, ${fitting.length} fit`);
    return errors;
  }
  const type = schema.type;
  const types = typeof type === "string" ? [type] : Array.isArray(type) ? type.filter((item): item is string => typeof item === "string") : [];
  if (types.length > 0 && !types.some((item) => fitsType(item, value))) {
    errors.push(`${at}: must be ${types.join(" or ")}`);
    return errors;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${at}: must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: must be at most ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${at}: must be more than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(`${at}: must be less than ${schema.exclusiveMaximum}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${at}: must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${at}: must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: must match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at}: must have at least ${schema.minItems} items`);
    if (isJson(schema.items)) value.forEach((item, index) => errors.push(...schemaErrors(schema.items as Json, item, `${at}[${index}]`, root)));
  }
  if (isJson(value)) {
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
      errors.push(`${at}: must have at least ${schema.minProperties} fields`);
    }
    const properties = isJson(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === "string" && value[name] === undefined) errors.push(`${at}.${name}: is required`);
    }
    for (const [name, item] of Object.entries(value)) {
      const property = isJson(properties[name]) ? properties[name] : undefined;
      if (property !== undefined) {
        errors.push(...schemaErrors(property, item, `${at}.${name}`, root));
        continue;
      }
      if (isJson(schema.patternProperties)) {
        const match = Object.entries(schema.patternProperties).find(([pattern]) => new RegExp(pattern).test(name));
        if (match !== undefined && isJson(match[1])) {
          errors.push(...schemaErrors(match[1], item, `${at}.${name}`, root));
          continue;
        }
      }
      if (schema.additionalProperties === false) errors.push(`${at}.${name}: is not a field`);
      else if (isJson(schema.additionalProperties)) {
        errors.push(...schemaErrors(schema.additionalProperties, item, `${at}.${name}`, root));
      }
    }
    if (isJson(schema.propertyNames)) {
      for (const name of Object.keys(value)) errors.push(...schemaErrors(schema.propertyNames, name, `${at} key "${name}"`, root));
    }
  }
  return errors;
}

// ── the tests ──────────────────────────────────────────────────────────────

/** The items of one kind that lack a row and are not allowed, and the allowed ones that now have one. */
function check(kind: string, missing: ReadonlyMap<string, string>, allowed: Readonly<Record<string, string>>, all: ReadonlySet<string>): void {
  const problems: string[] = [];
  for (const [item, where] of missing) {
    if (allowed[item] === undefined) problems.push(`${kind} ${item} has no entry on ${where}`);
  }
  for (const [item, reason] of Object.entries(allowed)) {
    if (reason.trim() === "") problems.push(`allow list: ${kind} ${item} has no reason`);
    if (!all.has(item)) problems.push(`allow list: ${kind} ${item} no longer exists; remove it`);
    else if (!missing.has(item)) problems.push(`allow list: ${kind} ${item} is documented now; remove it`);
  }
  expect(problems).toEqual([]);
}

describe("the user docs", () => {
  test("every page of the structure exists", () => {
    for (const name of [
      "index", "quickstart", "config", "dev", "access", "cli", "tui", "app", "http", "mcp",
      "chats-and-bots", "telegram", "notifications", "checks", "environment", "troubleshooting",
    ]) {
      expect(existsSync(page(`${name}.md`))).toBe(true);
    }
    expect(existsSync(join(root, "docs", "plugins", "index.md"))).toBe(true);
    const index = read(page("index.md"));
    for (const path of userPages()) {
      const name = basename(path);
      if (name !== "index.md") expect(index).toContain(`](${name})`);
    }
  });

  test("every schema property has a table row on its page", async () => {
    const items = await schemaItems();
    const missing = new Map<string, string>();
    for (const item of items) {
      if (!hasRow(firstCells(item.page), item.spellings)) missing.set(item.id, `docs/user/${item.page}`);
    }
    check("schema key", missing, allow.schemaKeys, new Set(items.map((item) => item.id)));
  });

  test("every OPERAD_ variable the code reads has a row on the environment page", () => {
    const cells = firstCells("environment.md");
    const variables = envVariables();
    const missing = new Map<string, string>();
    for (const variable of variables) {
      if (!hasRow(cells, [variable])) {
        missing.set(variable, "docs/user/environment.md");
      }
    }
    check("environment variable", missing, allow.envVars, new Set(variables));
  });

  test("every CLI command and option the help table lists has an entry on the cli page", async () => {
    const text = read(page("cli.md"));
    const { commands, options } = await cliEntries();
    const missing = new Map<string, string>();
    for (const entry of [...commands, ...options]) {
      if (!cliDocumented(text, entry)) missing.set(entry, "docs/user/cli.md");
    }
    expect(commands.length).toBeGreaterThan(10);
    expect(options).toContain("--timeout");
    check("CLI entry", missing, allow.cliEntries, new Set([...commands, ...options]));
  });

  test("no link between docs pages is broken", () => {
    expect(brokenLinks(docsPages())).toEqual([]);
  });

  test("the link check finds a missing file and a missing heading", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-links-"));
    try {
      writeFileSync(join(dir, "a.md"), "# A\n\n[ok](b.md#one-two) [gone](c.md) [head](b.md#nope) [here](#a)\n\n```\n[code](d.md)\n```\n");
      writeFileSync(join(dir, "b.md"), "# B\n\n## One `two`\n");
      expect(brokenLinks([join(dir, "a.md")]).map((line) => line.replace(/^.*?:/, ""))).toEqual([
        "3: link to c.md names a file that does not exist",
        "3: link to b.md#nope names a heading that does not exist",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every config file's example on the pages fits its schema", () => {
    const examples = schemaExamples();
    const expected = [
      "access-user.schema.json",
      "config.schema.json",
      "dev.schema.json",
      "keys.schema.json",
      "review.schema.json",
      "theme.schema.json",
      "triggers.schema.json",
      "tui.schema.json",
    ];
    expect([...examples.keys()].filter((name) => !expected.includes(name))).toEqual([]);
    for (const name of expected) {
      const found = examples.get(name) ?? [];
      // Exactly one example; dev.json has a second, for a repository that is not JavaScript.
      const countFits = name === "dev.schema.json" ? found.length >= 1 : found.length === 1;
      expect({ name, countFits, count: found.length }).toEqual({ name, countFits: true, count: found.length });
      const file = schemaFiles().find((path) => basename(path) === name);
      if (file === undefined) throw new Error(`no schema file named ${name}`);
      const schema = JSON.parse(read(file)) as Json;
      for (const text of found) {
        const value: unknown = JSON.parse(text);
        expect({ name, errors: schemaErrors(schema, value) }).toEqual({ name, errors: [] });
      }
    }
  });

  test(".operad/flaky.md is the text of CLAUDE.md's Flaky tests section", () => {
    const claude = read(join(root, "CLAUDE.md"));
    const start = claude.indexOf("## Flaky tests\n\n") + "## Flaky tests\n\n".length;
    const end = claude.indexOf("\n## ", start);
    expect(read(join(root, ".operad", "flaky.md"))).toBe(`${claude.slice(start, end).trimEnd()}\n`);
  });

  test("a page under docs/user uses only the user's words", () => {
    // A user sees flow, pending and history; these are the kernel's internal names.
    const internal = /\b(graph|node|fact|effect|decide|evolve|runner|backend)(s|d)?\b/gi;
    // `store.backend` is a key the user writes in config.json, and "takes effect"
    // is the plain English of the column that says when a setting applies.
    const keys = /`backend`|"backend"|store\.backend|\b(takes?|taking|in|into|no) effect\b/gi;
    const found: string[] = [];
    for (const path of userPages()) {
      read(path).split("\n").forEach((line, index) => {
        const words = line.replace(keys, "").match(internal);
        if (words !== null) found.push(`${relative(root, path)}:${index + 1}: ${words.join(", ")}`);
      });
    }
    expect(found).toEqual([]);
  });
});
