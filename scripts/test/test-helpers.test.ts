import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as testing from "@operad-io/engine/testing";

const repo = join(import.meta.dir, "..", "..");

/** Every file under a `test` directory of a package or of scripts/. */
function testFiles(dir: string, inTest = false): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...testFiles(path, inTest || entry === "test"));
    else if (inTest && path.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** The names a file defines at its top level, as a function or a constant. */
export function topLevelNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/gm)) {
    names.push(match[1] ?? "");
  }
  return names;
}

describe("test helpers", () => {
  test("the testing package exports the helpers this test looks for", () => {
    expect(Object.keys(testing)).toContain("fakeClock");
  });

  test("a test helper named like one of @operad-io/engine/testing is defined only there", () => {
    const shared = new Set(Object.keys(testing));
    const clashes: string[] = [];
    const roots = [join(repo, "scripts")];
    for (const parent of ["packages"]) {
      for (const name of readdirSync(join(repo, parent))) {
        const dir = join(repo, parent, name);
        if (!statSync(dir).isDirectory()) continue;
        roots.push(dir);
      }
    }
    for (const root of roots) {
      for (const file of testFiles(root)) {
        if (file === import.meta.path) continue;
        for (const name of topLevelNames(readFileSync(file, "utf8"))) {
          if (shared.has(name)) clashes.push(`${relative(repo, file).split(sep).join("/")}: ${name}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  test("a definition at the top level of a file is found, a local one is not", () => {
    const source = "export async function runFlow() {}\nconst cleanup = 1;\nfunction f() {\n  const emit = 2;\n}\n";
    expect(topLevelNames(source)).toEqual(["runFlow", "cleanup", "f"]);
  });
});
