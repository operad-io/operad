import { definePlugin } from "../../src/index.ts";
import type { PluginDefinition, PluginShape } from "../../src/index.ts";

export {
  alive,
  cleanupTempRoots,
  tempRoot,
  waitForFile,
  waitForGone,
  waitForPid,
  waitUntil,
} from "../../src/testing/index.ts";

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
