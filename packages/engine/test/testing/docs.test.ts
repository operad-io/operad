import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..");
const exampleDir = join(root, "packages", "engine", "test", "fixtures", "example-plugin");
const heavyDir = join(root, "packages", "engine", "test", "heavy", "example-plugin");

/** Every TypeScript block of the page: its file name and its text. */
function blocks(): { readonly file: string; readonly text: string }[] {
  const page = readFileSync(join(root, "docs", "plugin-authoring.md"), "utf8");
  return [...page.matchAll(/```ts\n\/\/ example-plugin\/(\S+)\n([\s\S]*?)```/g)].map(
    (match) => ({ file: match[1] ?? "", text: `// example-plugin/${match[1]}\n${match[2]}` }),
  );
}

test("every TypeScript block of docs/plugin-authoring.md names a file of the example", () => {
  const page = readFileSync(join(root, "docs", "plugin-authoring.md"), "utf8");
  const all = [...page.matchAll(/```ts\n/g)].length;
  expect(blocks()).toHaveLength(all);
  expect(all).toBeGreaterThan(4);
});

/** Where the example's file lives: its heavy test files are under test/heavy/. */
function exampleFile(file: string): string {
  return join(file.endsWith(".test.ts") ? heavyDir : exampleDir, file);
}

test("each block is the file the suite checks or runs, word for word", () => {
  for (const block of blocks()) {
    expect(readFileSync(exampleFile(block.file), "utf8")).toBe(block.text);
  }
});

test("the example directories hold the blocks and nothing the page leaves out", () => {
  const named = blocks().map((block) => block.file).sort();
  expect(readdirSync(exampleDir).sort()).toEqual(named.filter((file) => !file.endsWith(".test.ts")));
  expect(readdirSync(heavyDir).sort()).toEqual(named.filter((file) => file.endsWith(".test.ts")));
});
