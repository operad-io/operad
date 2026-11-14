import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addPackage,
  ensureInstalledPackage,
  installedPackageFile,
  loadPlugin,
  pluginProjectManifestPath,
  pluginProjectPath,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

interface InstalledFixture {
  readonly home: string;
  readonly specifier: string;
  readonly version: string;
  readonly file: string;
}

/** Writes the package a fake `bun install` would have put in the project. */
function installFixture(root: string, specifier: string, version = "0.0.1"): InstalledFixture {
  const home = join(root, "home");
  const project = pluginProjectPath(home);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    pluginProjectManifestPath(home),
    JSON.stringify({ name: "operad-plugins", private: true, type: "module" }),
  );
  const module = join(project, "node_modules", specifier);
  mkdirSync(module, { recursive: true });
  writeFileSync(
    join(module, "package.json"),
    JSON.stringify({ name: specifier, version, exports: { ".": "./index.ts" } }),
  );
  const file = join(module, "index.ts");
  writeFileSync(file, `export default { name: "fixture", kind: "domain", version: "${version}" };\n`);
  return { home, specifier, version, file };
}

describe("ensuring a package is installed in the home", () => {
  test("writes the project, skips optional dependencies and returns the package file", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/plugin-fixture");
    const calls: { cwd: string; args: readonly string[] }[] = [];
    const file = await ensureInstalledPackage({
      home: fixture.home,
      specifier: fixture.specifier,
      version: fixture.version,
      omitOptional: true,
      run: (cwd, args) => {
        calls.push({ cwd, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(file).toBe(fixture.file);
    expect(calls).toEqual([
      { cwd: pluginProjectPath(fixture.home), args: ["install", "--omit=optional", "--no-summary"] },
    ]);
    const manifest = JSON.parse(
      readFileSync(pluginProjectManifestPath(fixture.home), "utf8"),
    ) as { dependencies: Record<string, string>; private: boolean };
    expect(manifest.dependencies[fixture.specifier]).toBe(fixture.version);
    expect(manifest.private).toBe(true);
  });

  test("an install that needs its optional packages keeps them on", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/plugin-fixture");
    const calls: (readonly string[])[] = [];
    await ensureInstalledPackage({
      home: fixture.home,
      specifier: fixture.specifier,
      version: fixture.version,
      run: (_cwd, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual([["install", "--no-summary"]]);
  });

  test("an installed package at the wanted version is not installed again", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/plugin-fixture");
    let runs = 0;
    const run = (): { exitCode: number; stdout: string; stderr: string } => {
      runs += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await ensureInstalledPackage({
      home: fixture.home,
      specifier: fixture.specifier,
      version: fixture.version,
      run,
    });
    const again = await ensureInstalledPackage({
      home: fixture.home,
      specifier: fixture.specifier,
      version: fixture.version,
      run,
    });
    expect(again).toBe(fixture.file);
    expect(runs).toBe(1);
  });

  test("a tarball dependency a person pinned is kept", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/plugin-fixture");
    const project = pluginProjectPath(fixture.home);
    mkdirSync(project, { recursive: true });
    const tarball = "file:/tmp/plugin-fixture-0.0.1.tgz";
    writeFileSync(
      pluginProjectManifestPath(fixture.home),
      JSON.stringify({ name: "operad-plugins", private: true, dependencies: { [fixture.specifier]: tarball } }),
    );
    let runs = 0;
    const file = await ensureInstalledPackage({
      home: fixture.home,
      specifier: fixture.specifier,
      version: fixture.version,
      run: () => {
        runs += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(file).toBe(fixture.file);
    expect(runs).toBe(0);
  });

  test("a failed install names the command and the output", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await expect(
      ensureInstalledPackage({
        home,
        specifier: "@operad-io/plugin-fixture",
        version: "0.0.1",
        omitOptional: true,
        run: () => ({ exitCode: 7, stdout: "download failed\n", stderr: "" }),
      }),
    ).rejects.toThrow(/bun install --omit=optional --no-summary.*exit code 7.*download failed/s);
  });

  test("the loader falls back to the package in the home", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/installed-fixture");
    const installed = installedPackageFile(fixture.home, fixture.specifier);
    expect(installed).toBe(fixture.file);
    const loaded = (await loadPlugin(fixture.specifier, fixture.home, installed)) as {
      name?: unknown;
    };
    expect(loaded.name).toBe("fixture");
    expect(existsSync(fixture.file)).toBe(true);
  });
});


/** Packs a package from a directory into a tarball a test can install without a registry. */
function packFixture(
  root: string,
  options: {
    readonly name: string;
    readonly version: string;
    readonly declaration: string;
    readonly postinstall?: string | undefined;
  },
): string {
  const directory = join(root, "fixture-package");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: options.name,
      version: options.version,
      type: "module",
      exports: { ".": "./index.ts" },
      ...(options.postinstall === undefined
        ? {}
        : { scripts: { postinstall: options.postinstall } }),
    }),
  );
  writeFileSync(join(directory, "index.ts"), `${options.declaration}\n`);
  const destination = join(root, "packs");
  mkdirSync(destination, { recursive: true });
  const packed = Bun.spawnSync({
    cmd: ["bun", "pm", "pack", "--destination", destination, "--quiet"],
    cwd: directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) {
    throw new Error(`bun pm pack failed: ${packed.stderr.toString()}`);
  }
  return packed.stdout.toString().trim();
}

describe("adding a package to the home project", () => {
  test("installs a local tarball and runs none of its install script", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const tarball = packFixture(root, {
      name: "@operad-io/add-fixture",
      version: "1.2.3",
      declaration: 'export default { operadPlugin: 1, name: "added-fixture", kind: "domain", version: "2.0.0" };',
      postinstall: "echo ran > postinstall-ran",
    });

    const added = await addPackage({ home, specifier: `file:${tarball}` });

    expect(added).toMatchObject({
      name: "@operad-io/add-fixture",
      version: "1.2.3",
      hasInstallScript: true,
    });
    expect(existsSync(added.file)).toBe(true);
    expect(
      existsSync(
        join(pluginProjectPath(home), "node_modules", "@operad-io/add-fixture", "postinstall-ran"),
      ),
    ).toBe(false);
    const manifest = JSON.parse(readFileSync(pluginProjectManifestPath(home), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@operad-io/add-fixture"]).toContain("file:");
  });

  test("asks Bun for the exact version, or the latest, with scripts off", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/add-command-fixture", "3.1.4");
    const calls: { cwd: string; args: readonly string[] }[] = [];
    const run = (cwd: string, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } => {
      calls.push({ cwd, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const exact = await addPackage({
      home: fixture.home,
      specifier: fixture.specifier,
      version: fixture.version,
      run,
    });
    const latest = await addPackage({ home: fixture.home, specifier: fixture.specifier, run });

    expect(exact.version).toBe(fixture.version);
    expect(latest.version).toBe(fixture.version);
    expect(calls).toEqual([
      {
        cwd: pluginProjectPath(fixture.home),
        args: [
          "add",
          `${fixture.specifier}@${fixture.version}`,
          "--exact",
          "--ignore-scripts",
          "--no-summary",
        ],
      },
      {
        cwd: pluginProjectPath(fixture.home),
        args: ["add", fixture.specifier, "--exact", "--ignore-scripts", "--no-summary"],
      },
    ]);
  });

  test("a package whose entry needs its install script says so", async () => {
    const root = await tempRoot();
    const directory = join(root, "fixture-package");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "@operad-io/needs-script",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./built/index.js" },
        scripts: { postinstall: "mkdir -p built && echo 'export default {}' > built/index.js" },
      }),
    );
    const destination = join(root, "packs");
    mkdirSync(destination, { recursive: true });
    const packed = Bun.spawnSync({
      cmd: ["bun", "pm", "pack", "--destination", destination, "--quiet"],
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(packed.exitCode).toBe(0);
    const tarball = packed.stdout.toString().trim();

    await expect(
      addPackage({ home: join(root, "home"), specifier: `file:${tarball}` }),
    ).rejects.toThrow(/install script.*needs one/s);
  });
});
