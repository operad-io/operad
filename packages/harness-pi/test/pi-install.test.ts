import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PluginRegistry, MemoryPluginStore } from "@operad-io/engine";
import { createPiHarnessPlugin } from "../src/index.ts";
import {
  PI_FLOOR,
  PI_PACKAGE,
  PiInstallError,
  compareVersions,
  entryOf,
  findPi,
  loadPi,
} from "../src/pi-install.ts";
import { cleanupTempRoots, tempRoot } from "@operad-io/harness-process/test-support";

afterAll(cleanupTempRoots);

type ExportsShape = "conditions" | "string" | "dot-string";

interface Fixture {
  readonly prefix: string;
  /** The `pi` command as a user's PATH names it. */
  readonly bin: string;
  readonly dir: string;
}

/** A pi package under `packageRoot`, with a bin link built by `link`. */
function installPi(
  root: string,
  layout: "bun" | "npm",
  options: { version?: string; name?: string; shape?: ExportsShape; chain?: number } = {},
): Fixture {
  const packageRoot =
    layout === "bun"
      ? join(root, ".bun", "install", "global", "node_modules")
      : join(root, "npm", "lib", "node_modules");
  const dir = join(packageRoot, "@earendil-works", "pi-coding-agent");
  mkdirSync(join(dir, "dist", "bundle"), { recursive: true });
  const shape = options.shape ?? "conditions";
  const exportsField =
    shape === "conditions"
      ? { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" } }
      : shape === "dot-string"
        ? { ".": "./dist/index.js" }
        : "./dist/index.js";
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: options.name ?? PI_PACKAGE,
      version: options.version ?? "1.5.0",
      exports: exportsField,
      bin: { pi: "dist/bundle/cli.js" },
    }),
  );
  writeFileSync(join(dir, "dist", "index.js"), 'export const marker = "fixture-pi";\n');
  writeFileSync(join(dir, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
  chmodSync(join(dir, "dist", "bundle", "cli.js"), 0o755); // an installer makes the bin executable

  const binDir = layout === "bun" ? join(root, ".bun", "bin") : join(root, "npm", "bin");
  mkdirSync(binDir, { recursive: true });
  const target = join(dir, "dist", "bundle", "cli.js");
  let link = join(binDir, "pi");
  // A chain of links: pi -> pi-1 -> pi-2 -> the real file.
  const hops = options.chain ?? 0;
  let next = target;
  for (let hop = hops; hop >= 1; hop -= 1) {
    const hopPath = join(binDir, `pi-${hop}`);
    symlinkSync(next, hopPath);
    next = hopPath;
  }
  symlinkSync(next, link);
  return { prefix: root, bin: binDir, dir };
}

async function fresh(): Promise<string> {
  return tempRoot();
}

describe("findPi", () => {
  test("finds a bun global install and an npm global install", async () => {
    const root = await fresh();
    const bun = installPi(join(root, "a"), "bun");
    const npm = installPi(join(root, "b"), "npm");
    const fromBun = findPi("pi", { path: bun.bin });
    expect(fromBun.dir).toContain(join(".bun", "install", "global", "node_modules"));
    expect(fromBun.version).toBe("1.5.0");
    const fromNpm = findPi("pi", { path: npm.bin });
    expect(fromNpm.dir).toContain(join("npm", "lib", "node_modules"));
    expect(fromNpm.entry.endsWith(join("dist", "index.js"))).toBe(true);
  });

  test("follows a chain of symlinks to the package", async () => {
    const root = await fresh();
    const pi = installPi(root, "npm", { chain: 3 });
    const found = findPi("pi", { path: pi.bin });
    expect(found.dir.endsWith(join("@earendil-works", "pi-coding-agent"))).toBe(true);
  });

  test("a wrapper script is refused, naming its path and the command setting", async () => {
    const root = await fresh();
    const pi = installPi(root, "npm");
    const wrapperDir = join(root, "wrapper");
    mkdirSync(wrapperDir, { recursive: true });
    const wrapper = join(wrapperDir, "pi");
    writeFileSync(wrapper, `#!/bin/sh\nexec bun ${join(pi.dir, "dist", "bundle", "cli.js")} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const error = (() => {
      try {
        findPi("pi", { path: wrapperDir });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(PiInstallError);
    const message = (error as Error).message;
    expect(message).toContain(wrapper);
    expect(message).toContain("command");
    // Pointing the setting at the package's bin works.
    expect(findPi(join(pi.dir, "dist", "bundle", "cli.js")).version).toBe("1.5.0");
  });

  test("no pi on PATH names pi and the floor", async () => {
    const root = await fresh();
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(() => findPi("pi", { path: empty })).toThrow(new RegExp(`${PI_FLOOR.replace(/\./g, "\\.")}`));
    expect(() => findPi("pi", { path: empty })).toThrow(/pi command/);
  });

  test("a package.json with another name all the way up is refused", async () => {
    const root = await fresh();
    const pi = installPi(root, "npm", { name: "not-pi" });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "also-not-pi" }));
    expect(() => findPi("pi", { path: pi.bin })).toThrow(/not inside a @earendil-works\/pi-coding-agent package/);
  });

  test("exports[\".\"] as a conditions object, as a string, and as a bare string", async () => {
    const root = await fresh();
    for (const shape of ["conditions", "dot-string", "string"] as const) {
      const pi = installPi(join(root, shape), "bun", { shape });
      const found = findPi("pi", { path: pi.bin });
      expect(found.entry.endsWith(join("dist", "index.js"))).toBe(true);
      expect(((await loadPi(found)) as unknown as { marker: string }).marker).toBe("fixture-pi");
    }
    expect(entryOf({ ".": { import: { default: "./x.js" } } })).toBe("./x.js");
    expect(entryOf({ ".": { types: "./x.d.ts" } })).toBeUndefined();
    expect(entryOf(undefined)).toBeUndefined();
  });

  test("an exports entry that is not a file in the package is refused", async () => {
    const root = await fresh();
    const pi = installPi(root, "npm");
    const manifest = join(pi.dir, "package.json");
    for (const entry of ["./dist/missing.js", "../../../outside.js"]) {
      writeFileSync(
        manifest,
        JSON.stringify({ name: PI_PACKAGE, version: "1.5.0", exports: { ".": { import: entry } } }),
      );
      writeFileSync(join(root, "npm", "lib", "node_modules", "outside.js"), "export {};\n");
      expect(() => findPi("pi", { path: pi.bin })).toThrow(/not a file in the package/);
    }
  });

  test("a version below the floor is refused naming both versions", async () => {
    const root = await fresh();
    const pi = installPi(root, "npm", { version: "1.4.9" });
    expect(() => findPi("pi", { path: pi.bin })).toThrow(/1\.4\.9/);
    expect(() => findPi("pi", { path: pi.bin })).toThrow(/1\.5\.0/);
  });

  test("a prerelease of the floor is below it; a prerelease above it is accepted", async () => {
    const root = await fresh();
    const below = installPi(join(root, "below"), "npm", { version: "1.5.0-beta.1" });
    expect(() => findPi("pi", { path: below.bin })).toThrow(/1\.5\.0-beta\.1/);
    const above = installPi(join(root, "above"), "npm", { version: "1.6.0-beta.1" });
    expect(findPi("pi", { path: above.bin }).version).toBe("1.6.0-beta.1");
  });

  test("version order: numbers by value, a prerelease under its release", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.5.0", "1.5.0")).toBe(0);
    expect(compareVersions("1.5.0-rc.1", "1.5.0")).toBeLessThan(0);
    expect(compareVersions("1.5.0-rc.2", "1.5.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("1.5.0-alpha", "1.5.0-1")).toBeGreaterThan(0);
  });

  test("a command given as a path is used as it is", async () => {
    const root = await fresh();
    const pi = installPi(root, "bun");
    expect(findPi(join(pi.bin, "pi"), { path: "" }).version).toBe("1.5.0");
    expect(() => findPi(join(root, "nowhere", "pi"), { path: "" })).toThrow(PiInstallError);
  });
});

describe("harness-pi check", () => {
  async function checkWith(command: string | undefined, path?: string) {
    const root = await fresh();
    const registry = new PluginRegistry([createPiHarnessPlugin()], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      settings: { "harness-pi": command === undefined ? {} : { command } },
    });
    const previous = process.env.PATH;
    if (path !== undefined) process.env.PATH = path;
    try {
      const checks = await registry.checks();
      return checks.find((item) => item.plugin === "harness-pi");
    } finally {
      process.env.PATH = previous;
    }
  }

  test("reports the pi version it found", async () => {
    const root = await fresh();
    const pi = installPi(root, "bun", { version: "1.7.2" });
    const result = await checkWith(join(pi.bin, "pi"));
    expect(result?.ok).toBe(true);
    expect(JSON.stringify(result)).toContain("1.7.2");
  });

  test("refuses a pi below the floor with both versions", async () => {
    const root = await fresh();
    const pi = installPi(root, "npm", { version: "1.2.0" });
    const result = await checkWith(join(pi.bin, "pi"));
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("1.2.0");
    expect(JSON.stringify(result)).toContain("1.5.0");
  });

  test("refuses when there is no pi on PATH", async () => {
    const root = await fresh();
    const empty = join(root, "empty");
    mkdirSync(empty);
    const result = await checkWith(undefined, empty);
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("pi command");
    expect(dirname(empty)).toBe(root);
  });
});
