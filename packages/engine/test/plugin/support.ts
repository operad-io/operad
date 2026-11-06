import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin } from "../../src/index.ts";
import type { PluginDefinition, PluginShape } from "../../src/index.ts";

const roots: string[] = [];

/** A scratch directory under `.radian/`, removed by `cleanupTempRoots`. */
export async function tempRoot(): Promise<string> {
  const base = join(process.cwd(), ".radian", "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "plugin-test-"));
  roots.push(root);
  return root;
}

export async function cleanupTempRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}

/** A plugin definition with the boring fields filled in. */
export function def(
  overrides: Partial<PluginShape> & { readonly name: string },
): PluginDefinition {
  return definePlugin({
    kind: "domain",
    version: "0.0.1",
    ...overrides,
  });
}
