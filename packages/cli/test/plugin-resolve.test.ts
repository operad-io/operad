import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALL_AFTER_START,
  INSTALL_ON_ENABLE,
  OPTIONAL_PLUGINS,
  PLUGIN_NEEDS,
  defaultPluginModule,
  defaultPluginsFor,
  distributionConfig,
  standInPlugins,
} from "../src/defaults.ts";

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(`${cliDir}/package.json`, "utf8")) as {
  dependencies: Record<string, string>;
};

// The plugins `operad init` installs and the ones `operad plugin enable` offers,
// as the CLI declares them.
const offered = [...defaultPluginsFor([]), ...OPTIONAL_PLUGINS];

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
  // Every shipped plugin; `claude` joins only a home whose machine has it.
  const shipped = [...new Set([...OPTIONAL_PLUGINS, "chat", "radian"])].filter((name) => name !== "claude");
  const fixed = ["chat", "bot", "memory", "cron", "shell", "pool", "dev", "telegram", "terminal"];

  test("a fresh home turns every shipped plugin on, and lists the lead actions explicitly", () => {
    const config = distributionConfig("/h");
    expect(config.plugins.map((entry) => entry.name)).toEqual([...fixed, "pi", "codex", "radian"]);
    expect(config.plugins.map((entry) => entry.name ?? "").sort()).toEqual([...shipped].sort());
    expect(config.plugins.every((entry) => entry.enabled)).toBe(true);
    expect(config.mcp.actions).toEqual(["chat:close"]);
    expect(config.mcp.confirmActions).toEqual(["chat:close"]);
  });

  test("no start waits only for packages that are installed on enable, and each has a stand-in", () => {
    for (const name of INSTALL_AFTER_START) {
      expect(INSTALL_ON_ENABLE).toContain(name);
      expect(existsSync(standInPlugins()[defaultPluginModule(name)] ?? "")).toBe(true);
    }
    expect(INSTALL_AFTER_START).toEqual(["terminal"]);
  });

  test("a fresh home puts the agents it finds first among the harnesses", () => {
    expect(defaultPluginsFor(["claude", "pi"])).toEqual([...fixed, "claude", "pi", "codex", "radian"]);
    expect(defaultPluginsFor(["radian"])).toEqual([...fixed, "radian", "pi", "codex"]);
  });

  test("every plugin a plugin of a fresh home needs is on and listed before it", () => {
    const names = defaultPluginsFor([]);
    for (const [name, needed] of Object.entries(PLUGIN_NEEDS)) {
      expect(names).toContain(name);
      for (const other of needed) {
        expect(names).toContain(other);
        expect(names.indexOf(other)).toBeLessThan(names.indexOf(name));
      }
    }
  });
});

test("the claude guide operad carries is the package's own", () => {
  const carried = standInPlugins()["@operad-io/harness-claude"] ?? "";
  const own = join(import.meta.dir, "../../harness/claude/skills/setup/SKILL.md");
  expect(readFileSync(carried, "utf8")).toBe(readFileSync(own, "utf8"));
});
