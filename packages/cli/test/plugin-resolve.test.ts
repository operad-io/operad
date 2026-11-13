import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_ON_ENABLE } from "@operad-io/engine";
import { DEFAULT_LEAD_ACTIONS, DEFAULT_PLUGINS, OPTIONAL_PLUGINS, defaultPluginModule, distributionConfig } from "../src/defaults.ts";

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(`${cliDir}/package.json`, "utf8")) as {
  dependencies: Record<string, string>;
};

// The plugins `operad init` installs and the ones `operad plugin enable` offers,
// as the CLI declares them.
const offered = [...DEFAULT_PLUGINS, ...OPTIONAL_PLUGINS];

describe("plugins the CLI offers", () => {
  for (const name of offered) {
    const module = defaultPluginModule(name);
    if (INSTALL_ON_ENABLE.includes(name)) {
      test(`${name} (${module}) is installed into the home instead of being a CLI dependency`, () => {
        expect(manifest.dependencies[module]).toBeUndefined();
      });
      continue;
    }
    test(`${name} (${module}) is a dependency of the CLI and resolves from it`, () => {
      expect(manifest.dependencies[module]).toBe("workspace:*");
      expect(() => Bun.resolveSync(module, cliDir)).not.toThrow();
    });
  }
});

describe("the distribution's defaults", () => {
  test("a fresh home's config lists the default plugins and the lead actions explicitly", () => {
    const config = distributionConfig("/h");
    expect(config.plugins.map((entry) => entry.name)).toEqual(DEFAULT_PLUGINS as string[]);
    expect(config.mcp.actions).toEqual([...DEFAULT_LEAD_ACTIONS]);
    expect(config.mcp.confirmActions).toEqual(["chat:close"]);
    expect(config.mcp.actions).toContain("chat:close");
  });
});
