import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_ON_ENABLE, OPTIONAL_PLUGINS, defaultPluginModule, defaultPluginsFor } from "../src/defaults.ts";
import { UNINSTALLED_DESCRIPTIONS, pluginDescription } from "../src/plugin-description.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

function manifest(directory: string, value: object): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(value));
}

describe("plugin descriptions", () => {
  test("every shipped plugin's package says in one line what it gives", async () => {
    const home = await tempRoot();
    const names = new Set([...OPTIONAL_PLUGINS, ...defaultPluginsFor(["radian"])]);
    for (const name of names) {
      const description = pluginDescription(defaultPluginModule(name), home);
      expect({ name, described: description !== undefined && !description.startsWith("operad:") }).toEqual({
        name,
        described: true,
      });
    }
  });

  test("a plugin installed on enable is described before its package is there, in the package's words", async () => {
    const home = await tempRoot();
    // A CLI directory from which no package resolves, as in a published install
    // that has not installed the plugin. The empty node_modules stops Bun from
    // asking a registry.
    const bare = await tempRoot();
    mkdirSync(join(bare, "node_modules"), { recursive: true });
    for (const name of INSTALL_ON_ENABLE) {
      const module = defaultPluginModule(name);
      const shipped = pluginDescription(module, home);
      expect(shipped).toBeDefined();
      expect(UNINSTALLED_DESCRIPTIONS[module]).toBe(shipped);
      expect(pluginDescription(module, home, bare)).toBe(shipped);
    }
  });

  test("a package in the home's plugin project gives its description on one line", async () => {
    const home = await tempRoot();
    manifest(join(home, "plugins"), { name: "operad-plugins" });
    const directory = join(home, "plugins", "node_modules", "added-fixture");
    manifest(directory, { name: "added-fixture", description: "  adds\n  things " });
    writeFileSync(join(directory, "index.js"), "export default {};\n");
    expect(pluginDescription("added-fixture", home)).toBe("adds things");
  });

  test("a path plugin takes the package.json beside it or above its src, and no other", async () => {
    const home = await tempRoot();
    manifest(home, { description: "the home's, not a plugin's" });
    manifest(join(home, "beside"), { description: "beside the file" });
    manifest(join(home, "packaged"), { description: "above src" });
    mkdirSync(join(home, "packaged", "src"), { recursive: true });
    expect(pluginDescription("./beside/index.ts", home)).toBe("beside the file");
    expect(pluginDescription("./packaged/src/index.ts", home)).toBe("above src");
    expect(pluginDescription("./loose/index.ts", home)).toBeUndefined();
  });
});
