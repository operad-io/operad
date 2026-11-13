/**
 * The ADRs are snapshots of decisions in force, not plans. An ADR names no
 * backlog path, no task id, no date and no "next task" wording, and the index
 * in `docs/adr/README.md` lists every ADR file and no missing one.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const adrDir = join(root, "docs", "adr");

const FORBIDDEN: readonly { readonly why: string; readonly pattern: RegExp }[] = [
  { why: "a docs/backlog path", pattern: /docs\/backlog/ },
  { why: "a task id", pattern: /\b(?:T-\d{4}|TK\d{4})\b/ },
  { why: "a date", pattern: /\b\d{4}-\d{2}-\d{2}\b/ },
  { why: 'the phrase "next task"', pattern: /next task/i },
  { why: 'the phrase "later task"', pattern: /later task/i },
  { why: 'the phrase "this task"', pattern: /this task/i },
  { why: 'the phrase "previous task"', pattern: /previous task/i },
];

/** `file:line: why` for each line of an ADR's text that breaks a rule. */
export function snapshotViolations(file: string, text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(line)) found.push(`${file}:${index + 1}: contains ${rule.why}`);
    }
  });
  return found;
}

/** The ADR files linked from the index table of the README text. */
export function indexedFiles(readme: string): string[] {
  const names: string[] = [];
  for (const match of readme.matchAll(/^\|\s*\[\d{4}\]\(([^)]+)\)/gm)) {
    if (match[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/** `file: why` for each mismatch between the index and the ADR files. */
export function indexProblems(readme: string, files: readonly string[]): string[] {
  const indexed = indexedFiles(readme);
  const problems: string[] = [];
  for (const file of files) {
    if (!indexed.includes(file)) problems.push(`${file}: missing from the README index`);
  }
  for (const name of indexed) {
    if (!files.includes(name)) problems.push(`${name}: named by the README index but the file is missing`);
  }
  return problems;
}

function adrFiles(): string[] {
  if (!existsSync(adrDir)) return [];
  return readdirSync(adrDir)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort();
}

describe("the ADRs are snapshots, not plans", () => {
  test("no ADR names a backlog path, a task id, a date or a plan phrase", () => {
    const problems = adrFiles().flatMap((name) =>
      snapshotViolations(`docs/adr/${name}`, readFileSync(join(adrDir, name), "utf8")),
    );
    expect(problems).toEqual([]);
  });

  test("the README index lists every ADR and only files that exist", () => {
    const readme = readFileSync(join(adrDir, "README.md"), "utf8");
    expect(indexProblems(readme, adrFiles())).toEqual([]);
  });

  test("a violation names the file and the line", () => {
    const text = "# ADR 0001: X\n\nsee docs/backlog/a.md\nfixed in T-0123 on 2026-11-13\nin the next task\n";
    expect(snapshotViolations("docs/adr/0001-x.md", text)).toEqual([
      "docs/adr/0001-x.md:3: contains a docs/backlog path",
      "docs/adr/0001-x.md:4: contains a task id",
      "docs/adr/0001-x.md:4: contains a date",
      'docs/adr/0001-x.md:5: contains the phrase "next task"',
    ]);
    expect(snapshotViolations("a.md", "TK0001 and later task, this task, previous task")).toHaveLength(4);
  });

  test("an ADR missing from the index, and an index entry without a file, are reported", () => {
    const readme = "| Number | Title |\n|---|---|\n| [0001](0001-a.md) | A |\n| [0002](0002-b.md) | B |\n";
    expect(indexProblems(readme, ["0001-a.md", "0003-c.md"])).toEqual([
      "0003-c.md: missing from the README index",
      "0002-b.md: named by the README index but the file is missing",
    ]);
  });
});
