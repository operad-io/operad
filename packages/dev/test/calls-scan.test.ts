import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = join(import.meta.dir, "..", "..");

function sources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sources(path));
    else if (name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("declared calls", () => {
  test("every runStep(\"plugin/step\" in a package's source is in a calls list of that package", () => {
    const missing: string[] = [];
    let found = 0;
    for (const pkg of readdirSync(PACKAGES)) {
      const src = join(PACKAGES, pkg, "src");
      if (!statSync(join(PACKAGES, pkg)).isDirectory()) continue;
      let files: string[];
      try {
        files = sources(src);
      } catch {
        continue;
      }
      const texts = files.map((file) => readFileSync(file, "utf8"));
      const declared = new Set<string>();
      for (const text of texts) {
        for (const list of text.matchAll(/\bcalls:\s*\[([^\]]*)\]/g)) {
          for (const name of (list[1] ?? "").matchAll(/"([^"]+)"/g)) {
            if (name[1] !== undefined) declared.add(name[1]);
          }
        }
      }
      for (const [index, text] of texts.entries()) {
        for (const call of text.matchAll(/\brunStep\(\s*"([^"]+)"/g)) {
          const use = call[1];
          if (use === undefined) continue;
          found += 1;
          if (!declared.has(use)) missing.push(`${pkg}: ${files[index]}: ${use}`);
        }
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
