import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (url: string): string => readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");

/** The first two TypeScript blocks of the page: the plugin and its test. */
function blocks(): string[] {
  const page = read("../../../../docs/plugin-authoring.md");
  return [...page.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

test("the plugin in docs/plugin-authoring.md is the one the suite checks", () => {
  const [plugin] = blocks();
  expect(read("../fixtures/example-plugin/index.ts")).toBe(plugin ?? "");
});

test("the test in docs/plugin-authoring.md is the one the suite runs", () => {
  const test = blocks()[1]?.trimEnd();
  expect(test).toBeDefined();
  expect(read("../fixtures/example-plugin/plugin.test.ts")).toContain(test ?? "");
});
