import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SOURCE = join(ROOT, "packages", "tui", "src");

/** Packages the TUI must not import: it talks to operad only through `/v1`. */
const PLUGIN_IMPORT = /@operad-io\/(?:dev|shell|harness-[a-z-]+|source-cron|access-match)\b/;

/** A `<plugin>:<action>` name; the URL schemes and `node:` modules are not. */
const PLUGIN_ACTION = /\b(?!(?:node|https?|operad):)[a-z][a-z0-9-]*:[a-z][a-z0-9-]*\b/g;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

export function violations(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    if (PLUGIN_IMPORT.test(text)) found.push(`${file}: imports a plugin package`);
    for (const match of text.matchAll(PLUGIN_ACTION)) {
      found.push(`${file}: names the plugin action "${match[0]}"`);
    }
  }
  return found;
}

describe("the TUI boundary", () => {
  test("packages/tui/src never imports a plugin or names one of its actions", () => {
    const files = new Map<string, string>();
    for (const path of sourceFiles(SOURCE)) {
      files.set(relative(ROOT, path), readFileSync(path, "utf8"));
    }
    expect(files.size).toBeGreaterThan(0);
    expect(violations(files)).toEqual([]);
  });

  test("the scan finds a plugin import and an action name", () => {
    expect(
      violations(
        new Map([
          [
            "packages/tui/src/a.ts",
            'import { thing } from "@operad-io/dev";',
          ],
        ]),
      ),
    ).toHaveLength(1);
    expect(
      violations(
        new Map([["packages/tui/src/a.ts", 'const action = "dev:merge";']]),
      ),
    ).toHaveLength(1);
    expect(
      violations(
        new Map([
          [
            "packages/tui/src/a.ts",
            'import { readFile } from "node:fs/promises";\nconst url = "https:";',
          ],
        ]),
      ),
    ).toEqual([]);
  });
});
