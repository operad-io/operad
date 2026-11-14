/**
 * Every MUTATIONS.md is append-only: its version at the check base must still
 * be the first lines of the file, in the same order. A merge of two branches
 * that each appended rows keeps both after those lines, so it passes too.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const roots: string[] = [];
afterAll(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The lines of a file; a final newline does not add an empty last line. */
export function lines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

export interface MovedLine {
  /** The line number in the base file, starting at 1. */
  readonly line: number;
  readonly text: string;
}

/** The first base line that `current` no longer has in the same place. */
export function firstMovedLine(base: string, current: string): MovedLine | undefined {
  const before = lines(base);
  const after = lines(current);
  for (let index = 0; index < before.length; index += 1) {
    if (after[index] !== before[index]) return { line: index + 1, text: before[index] ?? "" };
  }
  return undefined;
}

function isMutationFile(path: string): boolean {
  return path === "MUTATIONS.md" || (path.startsWith("packages/") && path.endsWith("/MUTATIONS.md"));
}

function packageMutationFiles(dir: string, prefix: string, found: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    const relative = `${prefix}/${name}`;
    if (statSync(path).isDirectory()) packageMutationFiles(path, relative, found);
    else if (isMutationFile(relative)) found.push(relative);
  }
}

/** The MUTATIONS.md paths in the worktree: the root one and every one under packages/. */
export function currentMutationFiles(repository: string): string[] {
  const found: string[] = [];
  if (existsSync(join(repository, "MUTATIONS.md"))) found.push("MUTATIONS.md");
  packageMutationFiles(join(repository, "packages"), "packages", found);
  return found.sort();
}

/** `file: line N ...` for every MUTATIONS.md whose base lines are not its first lines. */
export function mutationProblems(repository: string, base: string): string[] {
  const fromBase = git(repository, "ls-tree", "-r", "--name-only", base)
    .split("\n")
    .filter((path) => path.length > 0 && isMutationFile(path));
  const current = currentMutationFiles(repository);
  const files = [...new Set([...fromBase, ...current])].sort();
  const problems: string[] = [];
  for (const file of files) {
    const baseText = fromBase.includes(file) ? git(repository, "show", `${base}:${file}`) : "";
    if (!existsSync(join(repository, file))) {
      const first = lines(baseText)[0];
      problems.push(`${file}: the file is missing; its first line was ${JSON.stringify(first ?? "")}`);
      continue;
    }
    const moved = firstMovedLine(baseText, readFileSync(join(repository, file), "utf8"));
    if (moved !== undefined) {
      problems.push(`${file}: line ${moved.line} is missing, changed or moved: ${JSON.stringify(moved.text)}`);
    }
  }
  return problems;
}

/** The commit a check compares with: OPERAD_CHECK_BASE, or the merge base of HEAD and origin/main. */
export function checkBase(
  repository: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const override = env.OPERAD_CHECK_BASE;
  if (override !== undefined && override !== "") return override;
  try {
    return git(repository, "merge-base", "HEAD", "origin/main").trim();
  } catch {
    return undefined;
  }
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const BASE = [
  "# Mutation records",
  "",
  "| id | file | mutation | failing test |",
  "|---|---|---|---|",
  "| T-0001-M1 | a.ts | base | `test > base` |",
  "",
].join("\n");

function repository(): { root: string; base: string } {
  const path = mkdtempSync(join(tmpdir(), "mutations-append-only-"));
  roots.push(path);
  git(path, "init", "-q", "-b", "main");
  write(join(path, ".gitattributes"), "MUTATIONS.md merge=union\n**/MUTATIONS.md merge=union\n");
  write(join(path, "MUTATIONS.md"), BASE);
  write(join(path, "packages", "a", "MUTATIONS.md"), BASE);
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "base");
  return { root: path, base: git(path, "rev-parse", "HEAD").trim() };
}

const base = checkBase(root, process.env);
const realRepositoryTest = base === undefined ? test.skip : test;

describe("MUTATIONS.md files are append-only", () => {
  realRepositoryTest("every file still starts with the lines of its version at the check base", () => {
    if (base === undefined) return;
    expect(mutationProblems(root, base)).toEqual([]);
  });

  test("the check base is unset when OPERAD_CHECK_BASE is unset and origin/main is absent", () => {
    const { root: path } = repository();
    expect(checkBase(path, {})).toBeUndefined();
  });

  test("a deleted row fails and names the file and the first missing line", () => {
    const { root: path, base } = repository();
    write(join(path, "MUTATIONS.md"), BASE.replace("| T-0001-M1 | a.ts | base | `test > base` |\n", ""));
    expect(mutationProblems(path, base)).toEqual([
      'MUTATIONS.md: line 5 is missing, changed or moved: "| T-0001-M1 | a.ts | base | `test > base` |"',
    ]);
  });

  test("a deleted file fails and names its first base line", () => {
    const { root: path, base: commit } = repository();
    rmSync(join(path, "MUTATIONS.md"));
    expect(mutationProblems(path, commit)).toEqual([
      'MUTATIONS.md: the file is missing; its first line was "# Mutation records"',
    ]);
  });

  test("an edited row fails and names the file and the first changed line", () => {
    const { root: path, base } = repository();
    write(
      join(path, "MUTATIONS.md"),
      BASE.replace("| T-0001-M1 | a.ts | base | `test > base` |", "| T-0001-M1 | a.ts | edited | `test > base` |"),
    );
    expect(mutationProblems(path, base)).toEqual([
      'MUTATIONS.md: line 5 is missing, changed or moved: "| T-0001-M1 | a.ts | base | `test > base` |"',
    ]);
  });

  test("a row inserted in the middle fails and names the file and the moved line", () => {
    const { root: path, base } = repository();
    const row = "| T-0002-M1 | b.ts | inserted | `test > inserted` |\n";
    write(join(path, "MUTATIONS.md"), BASE.replace("| T-0001-M1 |", `${row}| T-0001-M1 |`));
    expect(mutationProblems(path, base)).toEqual([
      'MUTATIONS.md: line 5 is missing, changed or moved: "| T-0001-M1 | a.ts | base | `test > base` |"',
    ]);
  });

  test("rows appended at the end pass", () => {
    const { root: path, base } = repository();
    write(join(path, "MUTATIONS.md"), `${BASE}| T-0002-M1 | b.ts | appended | \`test > appended\` |\n`);
    write(join(path, "packages", "a", "MUTATIONS.md"), `${BASE}| T-0002-M2 | b.ts | appended | \`test > a\` |\n`);
    expect(mutationProblems(path, base)).toEqual([]);
  });

  test("a union merge of two branches that each appended passes and keeps both rows", () => {
    const { root: path, base } = repository();
    const taskRow = "| T-0002-M1 | b.ts | task | `test > task` |\n";
    const mainRow = "| T-0003-M1 | c.ts | main | `test > main` |\n";
    git(path, "checkout", "-q", "-b", "task");
    write(join(path, "MUTATIONS.md"), `${BASE}${taskRow}`);
    git(path, "commit", "-q", "-am", "task appends");
    git(path, "checkout", "-q", "main");
    write(join(path, "MUTATIONS.md"), `${BASE}${mainRow}`);
    git(path, "commit", "-q", "-am", "main appends");
    git(path, "merge", "--no-ff", "-q", "--no-edit", "task");
    const merged = readFileSync(join(path, "MUTATIONS.md"), "utf8");
    expect(merged).toContain(taskRow);
    expect(merged).toContain(mainRow);
    expect(merged).not.toContain("<<<<<<<");
    expect(mutationProblems(path, base)).toEqual([]);
  });

  test("a new MUTATIONS.md is allowed", () => {
    const { root: path, base } = repository();
    write(join(path, "packages", "b", "MUTATIONS.md"), "| T-0002-M1 | b.ts | new | `test > new` |\n");
    expect(mutationProblems(path, base)).toEqual([]);
  });
});
