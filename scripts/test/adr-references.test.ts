/**
 * A decision cited outside `docs/backlog/` names the ADR that holds it, never
 * the number it once had in a backlog file. A backlog file is a plan and is
 * deleted; its numbers do not outlive it.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const self = "scripts/test/adr-references.test.ts";
const textFile = /\.(?:md|ts|tsx|js|mjs|cjs|json|sh|ya?ml|toml)$/;
const backlogFile = /(^|\/)docs\/backlog\//;

const CITATIONS: readonly RegExp[] = [
  /\bdecisions?\s+\d+/i,
  /决定\s*\d+/,
];

/** `file:line: why` for each line that cites a backlog decision by number. */
export function backlogDecisionCitations(file: string, text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (CITATIONS.some((pattern) => pattern.test(line))) {
      found.push(`${file}:${index + 1}: cites a backlog decision by number`);
    }
  });
  return found;
}

/** The tracked text files the rule applies to. */
function scannedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((file) => file.length > 0 && file !== self && !backlogFile.test(file) && textFile.test(file));
}

describe("a backlog decision is cited by its ADR", () => {
  test("no file outside docs/backlog cites a backlog decision by number", () => {
    const problems = scannedFiles().flatMap((file) =>
      backlogDecisionCitations(file, readFileSync(join(root, file), "utf8")),
    );
    expect(problems).toEqual([]);
  });

  test("a citation is reported with the file and the line", () => {
    expect(backlogDecisionCitations("a.ts", "one\n// operad.md decision 13\ntwo\n决定 4\n")).toEqual([
      "a.ts:2: cites a backlog decision by number",
      "a.ts:4: cites a backlog decision by number",
    ]);
    expect(backlogDecisionCitations("a.md", "ADR 0002 D1 to D4 and ADR 0025 D3.")).toEqual([]);
  });
});
