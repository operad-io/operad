import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type InstallRunner,
} from "@operad-io/engine";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

interface Output {
  readonly io: CliIo;
  text(): string;
  errors(): string;
}

function capture(): Output {
  let out = "";
  let err = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
    },
    text: () => out,
    errors: () => err,
  };
}

interface FixturePackage {
  readonly version: string;
  readonly declaration: string;
  readonly scripts?: Readonly<Record<string, string>> | undefined;
}

/** A `bun add` that writes the package a local registry would have put there. */
function fakeInstall(
  packages: ReadonlyMap<string, FixturePackage>,
  calls: { cwd: string; args: readonly string[] }[] = [],
): InstallRunner {
  return (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === "install") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const manifestPath = join(cwd, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    if (args[0] === "remove") {
      const name = args[1] ?? "";
      if (manifest.dependencies !== undefined) {
        delete manifest.dependencies[name];
        if (Object.keys(manifest.dependencies).length === 0) delete manifest.dependencies;
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      rmSync(join(cwd, "node_modules", name), { recursive: true, force: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const target = args[1] ?? "";
    const at = target.startsWith("@") ? target.indexOf("@", 1) : target.indexOf("@");
    const name = at > 0 ? target.slice(0, at) : target;
    const asked = at > 0 ? target.slice(at + 1) : undefined;
    const fixture = packages.get(name);
    if (fixture === undefined) {
      return { exitCode: 1, stdout: "", stderr: `404 ${name} is not found` };
    }
    const version = asked ?? fixture.version;
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [name]: version };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const directory = join(cwd, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        version,
        type: "module",
        exports: { ".": "./index.ts" },
        ...(fixture.scripts === undefined ? {} : { scripts: fixture.scripts }),
      }),
    );
    writeFileSync(join(directory, "index.ts"), `${fixture.declaration}\n`);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

async function makeHome(plugins: Record<string, unknown> = {}): Promise<{
  readonly root: string;
  readonly home: string;
}> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins,
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  return { root, home };
}

function configOf(home: string): {
  plugins: Record<string, { module: string; enabled: boolean }>;
} {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    plugins: Record<string, { module: string; enabled: boolean }>;
  };
}

const addedDeclaration =
  'export default { operadPlugin: 1, name: "added", kind: "domain", version: "2.0.0" };';

function declarationFor(name: string): string {
  return `export default { operadPlugin: 1, name: ${JSON.stringify(name)}, kind: "domain", version: "1.0.0" };`;
}

describe("plugin add", () => {
  test("installs an npm package, prints it, and leaves it off until enable", async () => {
    const { home } = await makeHome();
    const calls: { cwd: string; args: readonly string[] }[] = [];
    const run = fakeInstall(
      new Map([["fixture-plugin", { version: "1.2.3", declaration: addedDeclaration }]]),
      calls,
    );

    const output = capture();
    expect(
      await main(["plugin", "add", "fixture-plugin@1.2.3"], {
        home,
        io: output.io,
        pluginInstall: run,
      }),
    ).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "add",
      "fixture-plugin@1.2.3",
      "--exact",
      "--ignore-scripts",
      "--no-summary",
    ]);
    expect(output.text()).toContain("installed fixture-plugin@1.2.3 (plugin added 2.0.0)");
    expect(output.text()).toContain("operad plugin enable added");
    expect(configOf(home).plugins.added).toEqual({ module: "fixture-plugin", enabled: false });

    const listed = capture();
    expect(await main(["plugin", "list"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toContain("added  -  disabled");

    const enabled = capture();
    expect(await main(["plugin", "enable", "added"], { home, io: enabled.io })).toBe(0);
    expect(enabled.text()).toContain("added: enabled");
    expect(configOf(home).plugins.added?.enabled).toBe(true);
  });

  test("a package with no version asks for the latest", async () => {
    const { home } = await makeHome();
    const run = fakeInstall(
      new Map([["latest-plugin", { version: "9.9.9", declaration: addedDeclaration }]]),
    );
    const output = capture();
    expect(await main(["plugin", "add", "latest-plugin"], { home, io: output.io, pluginInstall: run })).toBe(0);
    expect(output.text()).toContain("installed latest-plugin@9.9.9");
  });

  test("refuses a name npm does not allow", async () => {
    const { home } = await makeHome();
    const calls: { cwd: string; args: readonly string[] }[] = [];
    const run = fakeInstall(new Map(), calls);
    const before = readFileSync(join(home, "config.json"), "utf8");

    for (const spec of ["Not A Name", "@scope", "node_modules"]) {
      const output = capture();
      expect(await main(["plugin", "add", spec], { home, io: output.io, pluginInstall: run })).toBe(2);
      expect(output.errors()).toContain("not a valid npm package name");
    }
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  });

  test("refuses a version that is not exact", async () => {
    const { home } = await makeHome();
    const calls: { cwd: string; args: readonly string[] }[] = [];
    const run = fakeInstall(new Map(), calls);
    const before = readFileSync(join(home, "config.json"), "utf8");

    const output = capture();
    expect(
      await main(["plugin", "add", "fixture-plugin@^1.2.3"], {
        home,
        io: output.io,
        pluginInstall: run,
      }),
    ).toBe(2);
    expect(output.errors()).toContain("not an exact version");
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  });

  test("accepts a legacy npm name with capitals or a leading dot or underscore", async () => {
    const { home } = await makeHome();
    const run = fakeInstall(
      new Map([
        ["Legacy.Plugin", { version: "1.0.0", declaration: declarationFor("legacy-capitals") }],
        ["_legacy", { version: "1.0.0", declaration: declarationFor("legacy-underscore") }],
        [".legacy", { version: "1.0.0", declaration: declarationFor("legacy-dot") }],
      ]),
    );
    for (const spec of ["Legacy.Plugin", "_legacy", ".legacy"]) {
      const output = capture();
      expect(await main(["plugin", "add", spec], { home, io: output.io, pluginInstall: run })).toBe(0);
    }
    expect(configOf(home).plugins).toMatchObject({
      "legacy-capitals": { module: "Legacy.Plugin", enabled: false },
      "legacy-underscore": { module: "_legacy", enabled: false },
      "legacy-dot": { module: ".legacy", enabled: false },
    });
  });

  test("refuses a package that is not an operad plugin", async () => {
    const { home } = await makeHome();
    const before = readFileSync(join(home, "config.json"), "utf8");
    const run = fakeInstall(
      new Map([
        [
          "plain-package",
          {
            version: "1.0.0",
            declaration: 'export default { name: "plain", kind: "domain", version: "1.0.0" };',
          },
        ],
      ]),
    );
    const output = capture();
    expect(await main(["plugin", "add", "plain-package"], { home, io: output.io, pluginInstall: run })).toBe(1);
    expect(output.errors()).toContain("not an operad plugin");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  });

  test("a refused package does not stay in the home project", async () => {
    const { home } = await makeHome();
    const before = readFileSync(join(home, "config.json"), "utf8");
    const calls: { cwd: string; args: readonly string[] }[] = [];
    const run = fakeInstall(
      new Map([
        [
          "plain-package",
          {
            version: "1.0.0",
            declaration: 'export default { name: "plain", kind: "domain", version: "1.0.0" };',
          },
        ],
      ]),
      calls,
    );
    const output = capture();
    expect(await main(["plugin", "add", "plain-package"], { home, io: output.io, pluginInstall: run })).toBe(1);
    expect(calls.map((call) => call.args[0])).toEqual(["add", "remove"]);
    expect(calls[1]?.args).toEqual(["remove", "plain-package", "--ignore-scripts", "--no-summary"]);
    expect(existsSync(join(home, "plugins", "node_modules", "plain-package"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(home, "plugins", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["plain-package"]).toBeUndefined();
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  });

  test("a refused add leaves a package the project already had", async () => {
    const { home } = await makeHome({ existing: { module: "kept-package", enabled: true } });
    const project = join(home, "plugins");
    const kept = join(project, "node_modules", "kept-package");
    mkdirSync(kept, { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        name: "operad-plugins",
        private: true,
        type: "module",
        dependencies: { "kept-package": "1.0.0" },
      }),
    );
    writeFileSync(
      join(kept, "package.json"),
      JSON.stringify({ name: "kept-package", version: "1.0.0", type: "module", exports: { ".": "./index.ts" } }),
    );
    writeFileSync(join(kept, "index.ts"), `${declarationFor("existing")}\n`);

    const calls: { cwd: string; args: readonly string[] }[] = [];
    const run = fakeInstall(
      new Map([["kept-package", { version: "2.0.0", declaration: declarationFor("existing") }]]),
      calls,
    );
    const output = capture();
    expect(await main(["plugin", "add", "kept-package"], { home, io: output.io, pluginInstall: run })).toBe(1);
    expect(output.errors()).toContain('plugin "existing": already configured');

    expect(calls.map((call) => call.args[0])).toEqual(["add", "install"]);
    expect(calls[1]?.args).toEqual(["install", "--ignore-scripts", "--no-summary"]);
    const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["kept-package"]).toBe("1.0.0");
    expect(existsSync(kept)).toBe(true);
  });

  test("refuses a plugin declaration the check rejects", async () => {
    const { home } = await makeHome();
    const before = readFileSync(join(home, "config.json"), "utf8");
    const run = fakeInstall(
      new Map([
        [
          "bad-kind-package",
          {
            version: "1.0.0",
            declaration:
              'export default { operadPlugin: 1, name: "bad-kind", kind: "not-a-kind", version: "1.0.0" };',
          },
        ],
      ]),
    );
    const output = capture();
    expect(await main(["plugin", "add", "bad-kind-package"], { home, io: output.io, pluginInstall: run })).toBe(1);
    expect(output.errors()).toContain("kind");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  });

  test("refuses a declared name that a configured plugin already uses", async () => {
    const { home } = await makeHome({ added: { module: "@operad-io/shell", enabled: false } });
    const before = readFileSync(join(home, "config.json"), "utf8");
    const run = fakeInstall(
      new Map([
        [
          "clashing-package",
          { version: "1.0.0", declaration: addedDeclaration },
        ],
      ]),
    );
    const output = capture();
    expect(await main(["plugin", "add", "clashing-package"], { home, io: output.io, pluginInstall: run })).toBe(1);
    expect(output.errors()).toContain('plugin "added": already configured');
    expect(output.errors()).toContain("clashes");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  });

  test("a package whose declaration needs its install script says so", async () => {
    const { home } = await makeHome();
    const run = fakeInstall(
      new Map([
        [
          "needs-script",
          {
            version: "1.0.0",
            declaration: 'export default { name: "needs-script", kind: "domain", version: "1.0.0" };',
            scripts: { postinstall: "bun run build" },
          },
        ],
      ]),
    );
    const output = capture();
    expect(await main(["plugin", "add", "needs-script"], { home, io: output.io, pluginInstall: run })).toBe(1);
    expect(output.errors()).toContain("not an operad plugin");
    expect(output.errors()).toContain("install script");
    expect(output.errors()).toContain("runs none of the package scripts");
  });
});
