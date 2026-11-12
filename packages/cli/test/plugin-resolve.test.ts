import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PLUGINS, OPTIONAL_PLUGINS, defaultPluginModule } from "@operad-io/engine";

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(`${cliDir}/package.json`, "utf8")) as {
  dependencies: Record<string, string>;
};

// The plugins `operad init` installs and the ones `operad plugin enable` offers,
// as the engine declares them.
const offered = [...DEFAULT_PLUGINS, ...OPTIONAL_PLUGINS];

describe("plugins the CLI offers", () => {
  for (const name of offered) {
    const module = defaultPluginModule(name);
    test(`${name} (${module}) is a dependency of the CLI and resolves from it`, () => {
      expect(manifest.dependencies[module]).toBe("workspace:*");
      expect(() => Bun.resolveSync(module, cliDir)).not.toThrow();
    });
  }
});
