import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addPackage,
  ensureInstalledPackage,
  INSTALL_WAITING_LINE,
  installedPackageFile,
  loadPlugin,
  pluginProjectManifestPath,
  pluginProjectPath,
  removePackage,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

// The installs here are local tarballs. A cache this file made empty and a
// registry that cannot answer keep them from depending on the machine's cache
// or on the network; a local install that tried either would fail here.
const previousCache = process.env.BUN_INSTALL_CACHE_DIR;
const previousRegistry = process.env.BUN_CONFIG_REGISTRY;

beforeAll(async () => {
  process.env.BUN_INSTALL_CACHE_DIR = await tempRoot("operad-bun-cache-");
  process.env.BUN_CONFIG_REGISTRY = "http://127.0.0.1:9/";
});

afterAll(async () => {
  if (previousCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
  else process.env.BUN_INSTALL_CACHE_DIR = previousCache;
  if (previousRegistry === undefined) delete process.env.BUN_CONFIG_REGISTRY;
  else process.env.BUN_CONFIG_REGISTRY = previousRegistry;
  await cleanupTempRoots();
});

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

  test("a failed upgrade is tried again, though the project already names the new version", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/plugin-fixture");
    let runs = 0;
    const upgrade = (exitCode: number): Promise<string | undefined> =>
      ensureInstalledPackage({
        home: fixture.home,
        specifier: fixture.specifier,
        version: "0.0.2",
        run: () => {
          runs += 1;
          // Writes the new version over the old one, in the same home.
          if (exitCode === 0) installFixture(root, fixture.specifier, "0.0.2");
          return { exitCode, stdout: "", stderr: "" };
        },
      });
    await expect(upgrade(1)).rejects.toThrow("failed with exit code 1");
    await upgrade(0);
    expect(runs).toBe(2);
  });

  test("an install that leaves another version behind fails", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/plugin-fixture");
    await expect(
      ensureInstalledPackage({
        home: fixture.home,
        specifier: fixture.specifier,
        version: "0.0.2",
        run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("it is not version 0.0.2");
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

  test("the install reports each line the command prints while it runs", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "@operad-io/plugin-fixture");
    const lines: string[] = [];
    await ensureInstalledPackage({
      home: fixture.home,
      specifier: fixture.specifier,
      version: fixture.version,
      onProgress: (line) => lines.push(line),
      run: (_cwd, _args, onProgress) => {
        onProgress?.("Resolving dependencies");
        onProgress?.("Resolved, downloaded and extracted [3]");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(lines).toEqual(["Resolving dependencies", "Resolved, downloaded and extracted [3]"]);
  });

  test("a network failure says the package could not be downloaded and to retry", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await expect(
      ensureInstalledPackage({
        home,
        specifier: "@operad-io/plugin-fixture",
        version: "0.0.1",
        run: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "error: getaddrinfo ENOTFOUND registry.npmjs.org\n",
        }),
      }),
    ).rejects.toThrow(/could not be downloaded, so check the network and run the command again/);
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
    env: process.env,
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

  test("the install uses the cache the process names when it runs", async () => {
    const root = await tempRoot();
    const tarball = packFixture(root, {
      name: "@operad-io/cache-fixture",
      version: "1.0.0",
      declaration: "export default {};",
    });
    const cache = await tempRoot("operad-bun-named-cache-");
    const named = process.env.BUN_INSTALL_CACHE_DIR;
    process.env.BUN_INSTALL_CACHE_DIR = cache;
    try {
      await addPackage({ home: join(root, "home"), specifier: `file:${tarball}` });
    } finally {
      // Assigning undefined would leave the string "undefined".
      if (named === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
      else process.env.BUN_INSTALL_CACHE_DIR = named;
    }

    expect(readdirSync(cache)).not.toEqual([]);
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

  test("removing a package takes the dependency and its files out again", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const tarball = packFixture(root, {
      name: "@operad-io/remove-fixture",
      version: "1.0.0",
      declaration: 'export default { operadPlugin: 1, name: "removed", kind: "domain", version: "1.0.0" };',
    });
    const added = await addPackage({ home, specifier: `file:${tarball}` });
    expect(existsSync(added.file)).toBe(true);

    await removePackage({ home, name: added.name });

    expect(existsSync(added.file)).toBe(false);
    expect(installedPackageFile(home, added.name)).toBeUndefined();
    const manifest = JSON.parse(readFileSync(pluginProjectManifestPath(home), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.[added.name]).toBeUndefined();
  });

  test("putting back a dependency the project already named does not remove it", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const project = pluginProjectPath(home);
    mkdirSync(project, { recursive: true });
    writeFileSync(
      pluginProjectManifestPath(home),
      JSON.stringify({
        name: "operad-plugins",
        private: true,
        type: "module",
        dependencies: { "kept-fixture": "1.0.0" },
      }),
    );
    const calls: (readonly string[])[] = [];

    await removePackage({
      home,
      name: "kept-fixture",
      previous: "1.0.0",
      run: (_cwd, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(calls).toEqual([["install", "--ignore-scripts", "--no-summary"]]);
    const manifest = JSON.parse(readFileSync(pluginProjectManifestPath(home), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ "kept-fixture": "1.0.0" });
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
      env: process.env,
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

const ok = { exitCode: 0, stdout: "", stderr: "" };

function projectDependencies(home: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(pluginProjectManifestPath(home), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return manifest.dependencies ?? {};
}

/** Writes a package into the home's project, as an install would. */
function writePackage(home: string, name: string, extra: object = {}): void {
  const directory = join(pluginProjectPath(home), "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", exports: { ".": "./index.ts" }, ...extra }),
  );
  writeFileSync(join(directory, "index.ts"), "export default {};\n");
}

describe("an install that did not finish", () => {
  test("a package without one of its dependencies is not installed, and is installed again", async () => {
    const root = await tempRoot();
    const fixture = installFixture(root, "part-done");
    writePackage(fixture.home, "part-done", {
      version: "0.0.1",
      dependencies: { "operad-test-needed": "1.0.0", "operad-test-optional": "1.0.0" },
      optionalDependencies: { "operad-test-optional": "1.0.0" },
    });
    writeFileSync(pluginProjectManifestPath(fixture.home), JSON.stringify({ dependencies: { "part-done": "0.0.1" } }));
    expect(installedPackageFile(fixture.home, "part-done")).toBeUndefined();

    let runs = 0;
    const file = await ensureInstalledPackage({
      home: fixture.home,
      specifier: "part-done",
      version: "0.0.1",
      run: () => {
        runs += 1;
        writePackage(fixture.home, "operad-test-needed");
        return ok;
      },
    });
    expect(runs).toBe(1);
    expect(file).toBe(fixture.file);
  });

  test("a failed install that is to be forgotten leaves the project naming what it named", async () => {
    const home = join(await tempRoot(), "home");
    mkdirSync(pluginProjectPath(home), { recursive: true });
    writeFileSync(pluginProjectManifestPath(home), JSON.stringify({ dependencies: { kept: "1.0.0", old: "1.0.0" } }));
    const fail = () => ({ exitCode: 1, stdout: "", stderr: "no" });
    for (const specifier of ["fresh", "old"]) {
      await expect(
        ensureInstalledPackage({ home, specifier, version: "2.0.0", run: fail, forgetOnFailure: true }),
      ).rejects.toThrow("exit code 1");
    }
    expect(projectDependencies(home)).toEqual({ kept: "1.0.0", old: "1.0.0" });

    await expect(ensureInstalledPackage({ home, specifier: "tried", version: "2.0.0", run: fail })).rejects.toThrow();
    expect(projectDependencies(home).tried).toBe("2.0.0");
  });
});

describe("two installs in one home", () => {
  test("the second waits for the first, says so, and keeps both dependencies", async () => {
    const home = join(await tempRoot(), "home");
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      began = resolve;
    });
    const first = ensureInstalledPackage({
      home,
      specifier: "first",
      version: "1.0.0",
      run: async () => {
        order.push("first starts");
        began();
        await gate;
        writePackage(home, "first");
        order.push("first ends");
        return ok;
      },
    });
    await running;
    const second = ensureInstalledPackage({
      home,
      specifier: "second",
      version: "1.0.0",
      onProgress: (line) => {
        if (line !== INSTALL_WAITING_LINE) return;
        order.push("second waits");
        release();
      },
      run: () => {
        order.push("second starts");
        writePackage(home, "second");
        return ok;
      },
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first starts", "second waits", "first ends", "second starts"]);
    expect(projectDependencies(home)).toEqual({ first: "1.0.0", second: "1.0.0" });
  });

  test("a stop ends the wait", async () => {
    const home = join(await tempRoot(), "home");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      began = resolve;
    });
    const first = ensureInstalledPackage({
      home,
      specifier: "first",
      version: "1.0.0",
      run: async () => {
        began();
        await gate;
        writePackage(home, "first");
        return ok;
      },
    });
    await running;
    const stop = new AbortController();
    let ran = false;
    await expect(
      ensureInstalledPackage({
        home,
        specifier: "second",
        version: "1.0.0",
        signal: stop.signal,
        onProgress: () => stop.abort(new Error("serve is stopping")),
        run: () => {
          ran = true;
          return ok;
        },
      }),
    ).rejects.toThrow("serve is stopping");
    release();
    await first;
    expect(ran).toBe(false);
  });
});
