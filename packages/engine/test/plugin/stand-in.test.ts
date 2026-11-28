// A stand-in loads in place of a package the distribution has not installed yet.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadPluginRegistry,
  sharedStandInPlugins,
  shareStandInPlugins,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const ENGINE = join(import.meta.dir, "../../src/index.ts");
const MODULE = "@operad-io/not-installed-anywhere";

/** A plugin file named `later` whose check answers `note`. */
function pluginFile(path: string, note: string): string {
  writeFileSync(
    join(path),
    [
      `import { definePlugin } from ${JSON.stringify(ENGINE)};`,
      `export default definePlugin({`,
      `  name: "later", kind: "domain", version: "0.0.0",`,
      `  check: () => ${JSON.stringify(note)},`,
      `  guide: ${JSON.stringify(`${path}.md`)},`,
      `});`,
      "",
    ].join("\n"),
  );
  writeFileSync(`${path}.md`, `# ${note}\n`);
  return path;
}

async function load(
  entry: { readonly module: string; readonly enabled?: boolean },
  standIns: (root: string) => Readonly<Record<string, string>>,
  installed?: (home: string) => void,
) {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { later: entry } }));
  installed?.(home);
  const logs: string[] = [];
  const registry = await loadPluginRegistry({
    home,
    storeRoot: join(root, "store"),
    standIns: standIns(root),
    onLog: (message) => logs.push(message),
  });
  return { registry, logs };
}

const standing = (root: string) => ({ [MODULE]: pluginFile(join(root, "stand-in.ts"), "standing in") });

describe("the stand-in of a package that is not installed", () => {
  test("loads in its place, with its check and guide and no load problem", async () => {
    const { registry, logs } = await load({ module: MODULE }, standing);
    expect(logs).toEqual([]);
    expect(registry.names()).toEqual(["later"]);
    expect((await registry.checks()).map((check) => check.message)).toEqual(["standing in"]);
    expect((await registry.setupReader().get("later"))?.text).toContain("standing in");
  });

  test("gives its guide while the plugin is off", async () => {
    const { registry } = await load({ module: MODULE, enabled: false }, standing);
    expect((await registry.setupReader().get("later"))?.text).toContain("standing in");
  });

  test("a guide alone is the guide while the plugin is off", async () => {
    const { registry, logs } = await load({ module: MODULE, enabled: false }, (root) => {
      writeFileSync(join(root, "SKILL.md"), "# only a guide\n");
      return { [MODULE]: join(root, "SKILL.md") };
    });
    expect(logs).toEqual([]);
    expect(await registry.setupReader().list()).toEqual([{ plugin: "later", enabled: false }]);
    expect((await registry.setupReader().get("later"))?.text).toContain("only a guide");
  });

  test("a guide alone loads as no plugin, so one that is on is still reported", async () => {
    const { registry, logs } = await load({ module: MODULE }, (root) => {
      writeFileSync(join(root, "SKILL.md"), "# only a guide\n");
      return { [MODULE]: join(root, "SKILL.md") };
    });
    expect(registry.names()).toEqual([]);
    expect(logs.join("\n")).toContain("import failed");
    expect(logs.join("\n")).not.toContain("SKILL.md");
  });

  test("an installed package that is off gives its own guide from the home", async () => {
    const { registry } = await load({ module: MODULE, enabled: false }, standing, (home) => {
      const project = join(home, "plugins");
      const directory = join(project, "node_modules", MODULE);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(project, "package.json"), "{}");
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: MODULE, exports: "./index.ts" }));
      pluginFile(join(directory, "index.ts"), "the installed one");
    });
    expect((await registry.setupReader().get("later"))?.text).toContain("the installed one");
  });

  test("does not hide an installed package that fails to load", async () => {
    const { registry, logs } = await load({ module: MODULE }, standing, (home) => {
      const project = join(home, "plugins");
      const directory = join(project, "node_modules", MODULE);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(project, "package.json"), "{}");
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: MODULE, exports: "./index.ts" }));
      writeFileSync(join(directory, "index.ts"), "throw new Error('broken package');\n");
    });
    expect(registry.names()).toEqual([]);
    expect(logs.join("\n")).toContain("broken package");
  });

  test("does not replace a package that resolves", async () => {
    const { registry } = await load({ module: "@operad-io/engine" }, (root) => ({
      "@operad-io/engine": pluginFile(join(root, "stand-in.ts"), "standing in"),
    }));
    expect(registry.names()).toEqual([]);
  });

  test("travels to the processes a host starts", () => {
    const env: Record<string, string | undefined> = {};
    shareStandInPlugins({ [MODULE]: "/stand-in.ts" }, env);
    expect(sharedStandInPlugins(env)).toEqual({ [MODULE]: "/stand-in.ts" });
    expect(sharedStandInPlugins({})).toBeUndefined();
  });
});
