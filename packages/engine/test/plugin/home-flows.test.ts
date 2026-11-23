import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeRoots, loadPluginRegistry } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const ENGINE = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../fixtures/plugins/home-steps.ts", import.meta.url));

function flowSource(use: string, name = "ignored"): string {
  return `import { defineFlow } from ${JSON.stringify(ENGINE)};
export default defineFlow({
  name: ${JSON.stringify(name)},
  entry: "one",
  steps: [
    { id: "one", kind: "plugin", params: { use: ${JSON.stringify(use)}, params: {} }, replay: "safe", next: { ok: "end_done" } },
    { id: "end_done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});
`;
}

async function homeWith(files: Record<string, string>): Promise<{ home: string; storeRoot: string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  await mkdir(join(home, "flows"), { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ plugins: { "home-steps": { module: PLUGIN } } }),
  );
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(home, "flows", name), text);
  }
  return { home, storeRoot: join(root, "store") };
}

test("a flow file of the home loads as home:<file> and can call a plugin's step", async () => {
  const { home, storeRoot } = await homeWith({ "tidy.flow.ts": flowSource("home-steps/touch") });
  const registry = await loadPluginRegistry({ home, storeRoot, onLog: () => undefined });
  const listed = registry.flows().find((entry) => entry.flow.name === "home:tidy");
  expect(listed?.plugin).toBe("home");
  expect(registry.flow("home:tidy")?.flow.entry).toBe("one");
  expect(registry.startProblem("home:tidy")).toBeUndefined();
});

test("a bad file is refused with its name and the other files still load", async () => {
  const { home, storeRoot } = await homeWith({
    "good.flow.ts": flowSource("home-steps/touch"),
    "unknown-step.flow.ts": flowSource("home-steps/missing"),
    "broken.flow.ts": "export default ;",
    "bare.flow.ts": "export const x = 1;",
    "bad name.flow.ts": flowSource("home-steps/touch"),
  });
  const lines: string[] = [];
  const registry = await loadPluginRegistry({ home, storeRoot, onLog: (line) => lines.push(line) });
  expect(registry.flows().map((entry) => entry.flow.name)).toEqual(["home:good"]);
  const refused = registry.homeFlowProblems().map((item) => item.file).sort();
  expect(refused).toEqual(["bad name.flow.ts", "bare.flow.ts", "broken.flow.ts", "unknown-step.flow.ts"]);
  for (const item of registry.homeFlowProblems()) expect(item.message).toContain(item.file);
  expect(lines.length).toBe(4);
});

test("the reason for a refused file goes to the home flow channel when one is given", async () => {
  const { home, storeRoot } = await homeWith({ "broken.flow.ts": "export default ;" });
  const general: string[] = [];
  const flowLines: string[] = [];
  await loadPluginRegistry({
    home,
    storeRoot,
    onLog: (line) => general.push(line),
    onHomeFlowProblem: (line) => flowLines.push(line),
  });
  expect(general).toEqual([]);
  expect(flowLines.length).toBe(1);
});

test("a read again after a change takes up the new files and drops the removed ones", async () => {
  const { home, storeRoot } = await homeWith({ "a.flow.ts": flowSource("home-steps/touch") });
  const registry = await loadPluginRegistry({ home, storeRoot, onLog: () => undefined });
  // The same file read again is not a name clash with itself.
  expect(await registry.loadHomeFlows()).toEqual([]);
  expect(registry.flows().map((entry) => entry.flow.name)).toEqual(["home:a"]);
  await writeFile(join(home, "flows", "b.flow.ts"), flowSource("home-steps/touch"));
  await rm(join(home, "flows", "a.flow.ts"));
  await registry.loadHomeFlows();
  expect(registry.flows().map((entry) => entry.flow.name)).toEqual(["home:b"]);
});

test("a home without a flows directory has no home flows", async () => {
  const root = await tempRoot();
  const registry = await loadPluginRegistry({
    home: join(root, "home"),
    storeRoot: join(root, "store"),
    onLog: () => undefined,
  });
  expect(registry.flows()).toEqual([]);
  expect(registry.homeFlowProblems()).toEqual([]);
});

test("the flows directory is code a process watches", () => {
  const roots = codeRoots({ home: "/h", plugins: [] });
  expect(roots.some((root) => root.path === "/h/flows" && root.label === "home flows")).toBe(true);
});
