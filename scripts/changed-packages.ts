/**
 * Which workspace packages a task's check tests: every package with a changed
 * file, and every package whose files refer to one of those, directly or
 * through others. A package refers to another when its code imports it
 * (`@operad-io/<name>`, or a relative path into `packages/<name>/`). Code that
 * imports changed code is changed code too, transitively; a package whose
 * tests (and not its code) load changed code has its tests run, and that goes
 * no further.
 *
 * A changed file outside `packages/` (root manifests, the lockfile, tsconfig,
 * scripts, docs that tests read, `.operad/`) selects every package.
 *
 * Run as a script it prints one line: `all`, `none`, or the package
 * directory names separated by spaces.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type Selection =
  | { readonly kind: "all"; readonly reason: string }
  | { readonly kind: "some"; readonly packages: readonly string[] };

/** The package directory names under `packages/` that have a package.json. */
export function workspacePackages(root: string): string[] {
  const dir = join(root, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "package.json")))
    .sort();
}

function packageName(root: string, dir: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) as {
    name?: unknown;
  };
  return typeof manifest.name === "string" ? manifest.name : undefined;
}

function sourceFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(path);
  }
}

const SPECIFIER = /(?:\bfrom|\bimport\s*\(|\bimport|\brequire\s*\(|\bnew URL\s*\()\s*["']([^"']+)["']/g;

/** The other package directories that `files` load code from. */
function loads(
  root: string,
  self: string,
  files: readonly string[],
  byName: ReadonlyMap<string, string>,
): Set<string> {
  const refs = new Set<string>();
  const packagesDir = resolve(root, "packages");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[1] ?? "";
      let dir: string | undefined;
      if (spec.startsWith("@operad-io/")) {
        dir = byName.get(spec.split("/").slice(0, 2).join("/"));
      } else if (spec.startsWith(".")) {
        const target = relative(packagesDir, resolve(dirname(file), spec));
        if (!target.startsWith("..")) dir = target.split(sep)[0];
      }
      if (dir !== undefined && dir !== self) refs.add(dir);
    }
  }
  return refs;
}

/**
 * For each package directory, the packages its own code (everything outside
 * `test/`) loads, and the packages its tests load.
 */
export function references(root: string): {
  readonly code: Map<string, Set<string>>;
  readonly tests: Map<string, Set<string>>;
} {
  const dirs = workspacePackages(root);
  const byName = new Map<string, string>();
  for (const dir of dirs) {
    const name = packageName(root, dir);
    if (name !== undefined) byName.set(name, dir);
  }
  const code = new Map<string, Set<string>>();
  const tests = new Map<string, Set<string>>();
  for (const dir of dirs) {
    const all: string[] = [];
    sourceFiles(join(root, "packages", dir), all);
    const testDir = join(root, "packages", dir, "test") + sep;
    code.set(dir, loads(root, dir, all.filter((file) => !file.startsWith(testDir)), byName));
    tests.set(dir, loads(root, dir, all.filter((file) => file.startsWith(testDir)), byName));
  }
  return { code, tests };
}

/** The packages to test for these changed paths (relative to the root). */
export function selectPackages(root: string, changed: readonly string[]): Selection {
  const dirs = new Set(workspacePackages(root));
  const touched = new Set<string>();
  for (const path of changed) {
    const match = /^packages\/([^/]+)\//.exec(path);
    if (match === null || !dirs.has(match[1] ?? "")) {
      return { kind: "all", reason: path };
    }
    touched.add(match[1] ?? "");
  }
  const refs = references(root);
  // Code that changed, and code that loads changed code, transitively.
  const affected = new Set(touched);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [dir, uses] of refs.code) {
      if (affected.has(dir)) continue;
      if ([...uses].some((used) => affected.has(used))) {
        affected.add(dir);
        grew = true;
      }
    }
  }
  // Tests of affected code, and tests that load affected code themselves.
  const selected = new Set(affected);
  for (const [dir, uses] of refs.tests) {
    if ([...uses].some((used) => affected.has(used))) selected.add(dir);
  }
  return { kind: "some", packages: [...selected].sort() };
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * The paths changed since `base`: committed, staged, unstaged and untracked.
 * `base` defaults to the merge base of HEAD and `origin/main`.
 */
export function changedPaths(root: string, base?: string): string[] {
  const from = base ?? git(root, ["merge-base", "HEAD", "origin/main"]).trim();
  const lines = [
    ...git(root, ["diff", "--name-only", from]).split("\n"),
    ...git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ];
  return [...new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0))].sort();
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const base = process.env.OPERAD_CHECK_BASE;
  const changed = changedPaths(root, base === undefined || base === "" ? undefined : base);
  const selection = selectPackages(root, changed);
  if (selection.kind === "all") {
    process.stderr.write(`check-changed: ${relative(root, join(root, selection.reason))} is outside packages/, testing every package\n`);
    process.stdout.write("all\n");
  } else {
    process.stdout.write(`${selection.packages.length === 0 ? "none" : selection.packages.join(" ")}\n`);
  }
}
