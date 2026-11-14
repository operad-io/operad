/**
 * The boundary of ADR 0034 D5: the dev
 * plugin's source knows nothing of this repository's conventions, and the
 * engine's source knows no plugin that ships with operad. Like the platform-rule
 * test, it reads the sources.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

function treeOf(name: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of sourceFiles(join(ROOT, "packages", name, "src"))) {
    files.set(relative(ROOT, path), readFileSync(path, "utf8"));
  }
  return files;
}

/** What the dev plugin's source may not say: the way this repository builds and tests itself. */
const DEV_FORBIDDEN: readonly RegExp[] = [
  /\bbun /,
  /\bbun\.lock/,
  /\bscripts\//,
  /\bCLAUDE\.md/,
  /\bpackages\//,
];

const PLUGINS = "shell|radian|pi|claude|codex|chat|dev|pool|bot";

/** The name of a shipped plugin as a whole string literal, or as the start of an action name in one. */
const ENGINE_FORBIDDEN: readonly RegExp[] = [
  new RegExp(`(["'\`])(?:${PLUGINS})\\1`),
  new RegExp(`["'\`](?:${PLUGINS}):[A-Za-z]`),
  // A plugin's package name, or one of its steps (`dev/verify`), inside a string.
  new RegExp(`["'\`][^"'\`\\n]*@operad-io/(?:${PLUGINS})\\b`),
  new RegExp(`["'\`](?:${PLUGINS})/[a-z_]+["'\`]`),
];

/** Comments explain; only code can depend. Line comments start at a space or the line start, so `https://` stays. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

export function devViolations(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    for (const pattern of DEV_FORBIDDEN) if (pattern.test(text)) found.push(`${file}: ${pattern.source}`);
  }
  return found;
}

export function engineViolations(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    const code = withoutComments(text);
    for (const pattern of ENGINE_FORBIDDEN) if (pattern.test(code)) found.push(`${file}: ${pattern.source}`);
  }
  return found;
}

describe("the kernel boundary", () => {
  test("the dev plugin's source has no bun, bun.lock, scripts/, CLAUDE.md or packages/", () => {
    const files = treeOf("dev");
    expect(files.size).toBeGreaterThan(20);
    expect(devViolations(files)).toEqual([]);
  });

  test("the engine's source has no shipped plugin's name or action name", () => {
    const files = treeOf("engine");
    expect(files.size).toBeGreaterThan(20);
    expect(engineViolations(files)).toEqual([]);
  });

  test("the scans find each forbidden word and leave the allowed ones", () => {
    const sample = (code: string): ReadonlyMap<string, string> => new Map([["a.ts", code]]);
    for (const text of ["run('bun test')", "bun.lock", "a/scripts/x", "read CLAUDE.md", "packages/dev"]) {
      expect(devViolations(sample(text))).toHaveLength(1);
    }
    expect(devViolations(sample("bundle, bunch, the scripts directory"))).toEqual([]);
    for (const text of ['const a = "shell";', "const a = 'dev';", 'run("dev:plan")', "x = `pool`"]) {
      expect(engineViolations(sample(text))).toHaveLength(1);
    }
    for (const text of ['m = "@operad-io/shell";', 'step("dev/verify")']) {
      expect(engineViolations(sample(text))).toHaveLength(1);
    }
    expect(engineViolations(sample('x = "@operad-io/engine"; y = "a/b"; z = "pi/2"'))).toEqual([]);
    expect(engineViolations(sample('// the type is "chat"\n/* "dev" */ const a = "device";'))).toEqual([]);
    expect(engineViolations(sample('const url = "https://pi.example";'))).toEqual([]);
  });
});
