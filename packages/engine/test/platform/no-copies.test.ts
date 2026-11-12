import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PLATFORM = join("packages", "engine", "src", "platform") + sep;

/** What only the platform module may write, and why. */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly use: string }[] = [
  { pattern: /\blinkSync\(/, use: "linkExclusive or withLockFile (file-lock.ts)" },
  { pattern: /\bprocess\.kill\(\s*-/, use: "killProcessGroup or runLine (process-group.ts)" },
  { pattern: /\bfs\.watch\(/, use: "watchDirectory or waitForChange (watch.ts)" },
  {
    // `import { watch } from "node:fs"` followed by a bare `watch(` call.
    pattern: /import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*["'](?:node:)?fs["']/,
    use: "watchDirectory or waitForChange (watch.ts)",
  },
];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** Every `src` tree in the workspace: the code that ships. */
function sourceTrees(): string[] {
  const packages = join(ROOT, "packages");
  const dirs = readdirSync(packages).flatMap((name) => {
    const path = join(packages, name);
    // A group directory (packages/harness/) holds packages one level down.
    return name === "harness" ? readdirSync(path).map((child) => join(path, child)) : [path];
  });
  return dirs
    .map((dir) => join(dir, "src"))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

export function violations(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    if (file.startsWith(PLATFORM)) continue;
    for (const { pattern, use } of FORBIDDEN) {
      if (pattern.test(text)) found.push(`${file}: ${pattern.source} (use ${use})`);
    }
  }
  return found;
}

describe("the platform module is the only copy", () => {
  test("no package writes its own process group, lock link or file watch", () => {
    const files = new Map<string, string>();
    for (const tree of sourceTrees()) {
      for (const path of sourceFiles(tree)) {
        files.set(relative(ROOT, path), readFileSync(path, "utf8"));
      }
    }
    expect(files.size).toBeGreaterThan(20);
    expect(violations(files)).toEqual([]);
  });

  test("the scan finds each forbidden call outside platform/", () => {
    const sample = (code: string): ReadonlyMap<string, string> =>
      new Map([[join("packages", "x", "src", "a.ts"), code]]);
    expect(violations(sample("linkSync(a, b);"))).toHaveLength(1);
    expect(violations(sample("process.kill(-pgid, 0);"))).toHaveLength(1);
    expect(violations(sample("fs.watch(dir, cb);"))).toHaveLength(1);
    expect(violations(sample('import { watch } from "node:fs";'))).toHaveLength(1);
    expect(violations(sample("process.kill(pid, 0);"))).toEqual([]);
    expect(
      violations(
        new Map([[join("packages", "engine", "src", "platform", "a.ts"), "linkSync(a, b);"]]),
      ),
    ).toEqual([]);
  });
});
