import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SELF = join("packages", "harness", "process", "test", "stdio-guard.test.ts");

const EXPLANATION = [
  "Bun closes every extra pipe (stdio index 3 and up) of a child process twice:",
  "once when the stream ends and once when the child object is collected. In",
  "between, a SQLite database can take the descriptor number, and macOS kills",
  "the process with EXC_GUARD (exit 137). Use at most three stdio entries and",
  "do not read stdio[3] or higher; send extra output to a file instead.",
  "See commit bf3a73e and packages/harness/process/test/heavy/descriptor-owner.test.ts.",
].join("\n");

export interface Violation {
  readonly line: number;
  readonly what: string;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** The number of top-level entries in the array literal opening at `open`. */
function entries(text: string, open: number): number {
  let depth = 0;
  let count = 0;
  let sawValue = false;
  let quote: string | undefined;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quote !== undefined) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      sawValue = true;
    } else if (c === "[" || c === "(" || c === "{") {
      depth += 1;
      if (depth > 1) sawValue = true;
    } else if (c === "]" || c === ")" || c === "}") {
      depth -= 1;
      if (depth === 0) return sawValue ? count + 1 : count;
    } else if (c === "," && depth === 1) {
      count += 1;
      sawValue = false;
    } else if (!/\s/.test(c)) {
      sawValue = true;
    }
  }
  return count;
}

/** A spawn with more than three stdio entries, or a read of stdio[3] or higher. */
export function findViolations(text: string): Violation[] {
  const found: Violation[] = [];
  for (const match of text.matchAll(/\bstdio\s*:\s*\[/g)) {
    const open = match.index + match[0].length - 1;
    const count = entries(text, open);
    if (count > 3) {
      found.push({
        line: lineOf(text, match.index),
        what: `spawn with ${count} stdio entries`,
      });
    }
  }
  for (const match of text.matchAll(/\bstdio\s*\[\s*(\d+)\s*\]/g)) {
    if (Number(match[1]) >= 3) {
      found.push({
        line: lineOf(text, match.index),
        what: `reads stdio[${match[1]}]`,
      });
    }
  }
  return found;
}

function sources(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sources(path));
    else if (name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("child process stdio", () => {
  test("no source spawns with more than three stdio entries or reads stdio[3] or higher", () => {
    const problems: string[] = [];
    const packageDirs = readdirSync(join(ROOT, "packages")).flatMap((name) =>
      name === "harness" ? readdirSync(join(ROOT, "packages", name)).map((child) => `${name}/${child}`) : [name],
    );
    for (const package_ of packageDirs) {
      for (const part of ["src", "test"]) {
        const directory = join(ROOT, "packages", package_, part);
        let isDirectory = false;
        try {
          isDirectory = statSync(directory).isDirectory();
        } catch {
          continue;
        }
        if (!isDirectory) continue;
        for (const file of sources(directory)) {
          const relative = file.slice(ROOT.length + 1);
          if (relative === SELF) continue;
          for (const v of findViolations(readFileSync(file, "utf8"))) {
            problems.push(`${relative}:${v.line}: ${v.what}`);
          }
        }
      }
    }
    expect(problems.length === 0 ? "" : `${problems.join("\n")}\n\n${EXPLANATION}`).toBe("");
  });

  test("the scanner finds the shapes it exists for", () => {
    const four = 'spawn("sh", [], {\n  stdio: ["pipe", "pipe", "pipe", "pipe"],\n});';
    expect(findViolations(four)).toEqual([{ line: 2, what: "spawn with 4 stdio entries" }]);
    expect(findViolations("const x = child.stdio[3];")).toEqual([
      { line: 1, what: "reads stdio[3]" },
    ]);
    expect(findViolations('{ stdio: ["ignore", "pipe", "pipe"] }')).toEqual([]);
    expect(findViolations("child.stdio[1]")).toEqual([]);
    expect(findViolations('{ stdio: ["a", ["b", "c"], "d", ] }')).toEqual([]);
  });
});
