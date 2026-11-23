import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { main, type CliIo } from "../src/main.ts";

const shellPlugin = fileURLToPath(new URL("../../shell/src/index.ts", import.meta.url));
const manual = fileURLToPath(new URL("../../../docs/user/home-flows.md", import.meta.url));

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** The first ts code block of the page: the example file, byte for byte. */
function exampleFile(): string {
  const text = readFileSync(manual, "utf8");
  const open = text.indexOf("```ts\n");
  const close = text.indexOf("```", open + 6);
  return text.slice(open + 6, close);
}

test("the example of the docs loads from a home outside the checkout, with no absolute import path", async () => {
  // The system temp directory has no node_modules above it: only the loader can make the import resolve.
  const home = await mkdtemp(join(tmpdir(), "operad-home-import-"));
  roots.push(home);
  await mkdir(join(home, "flows"), { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ plugins: { shell: { module: shellPlugin } } }));
  const example = exampleFile();
  expect(example).toContain('from "@operad-io/engine"');
  await writeFile(join(home, "flows", "nightly.flow.ts"), example);

  let out = "";
  let err = "";
  const io: CliIo = {
    write: (text) => {
      out += text;
    },
    error: (text) => {
      err += text;
    },
  };
  expect(await main(["flows"], { home, io })).toBe(0);
  expect(err).toBe("");
  expect(out).toContain("home:nightly");
});
