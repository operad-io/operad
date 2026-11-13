import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const cli = join(root, "packages", "cli");

interface Manifest {
  readonly name: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly license?: string;
  readonly files?: readonly string[];
  readonly repository?: { readonly type?: string; readonly url?: string; readonly directory?: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function manifestOf(directory: string): Manifest {
  return JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8")) as Manifest;
}

/** Every package under packages/, grouped directory or not. */
function packageDirectories(): string[] {
  const found: string[] = [];
  for (const name of new Bun.Glob("packages/*/package.json").scanSync({ cwd: root })) {
    found.push(dirname(name).slice("packages/".length));
  }
  for (const name of new Bun.Glob("packages/*/*/package.json").scanSync({ cwd: root })) {
    found.push(dirname(name).slice("packages/".length));
  }
  return found.sort();
}

const publishable = packageDirectories().filter((directory) => manifestOf(directory).private !== true);

/** The one version every public package carries; change it here and in the manifests for a release. */
const RELEASE_VERSION = "0.1.0";

/** The runtime package closure of one manifest. */
function closure(start: Manifest): Set<string> {
  const byName = new Map(packageDirectories().map((directory) => [manifestOf(directory).name, manifestOf(directory)]));
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const manifest = queue.shift();
    if (manifest === undefined) continue;
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      const found = byName.get(dependency);
      if (found !== undefined) queue.push(found);
    }
  }
  return seen;
}

describe("the packages a publish needs", () => {
  test("every publishable package has one version, the repository fields and the licence", () => {
    expect(publishable.length).toBeGreaterThan(10);
    for (const directory of publishable) {
      const manifest = manifestOf(directory);
      expect({ directory, version: manifest.version }).toEqual({ directory, version: RELEASE_VERSION });
      expect({ directory, private: manifest.private }).toEqual({ directory, private: undefined });
      expect({ directory, description: typeof manifest.description }).toEqual({ directory, description: "string" });
      expect({ directory, license: manifest.license }).toEqual({ directory, license: "MIT" });
      expect({ directory, repository: manifest.repository }).toEqual({
        directory,
        repository: {
          type: "git",
          url: "git+https://github.com/operad-io/operad.git",
          directory: `packages/${directory}`,
        },
      });
      expect({ directory, files: Array.isArray(manifest.files) }).toEqual({ directory, files: true });
      expect(manifest.files ?? []).not.toContain("test");
      expect(manifest.files ?? []).not.toContain("MUTATIONS.md");
      expect({ directory, licenseFile: existsSync(join(root, "packages", directory, "LICENSE")) }).toEqual({
        directory,
        licenseFile: true,
      });
    }
  });

  test("every public package has the same version", () => {
    const versions = new Map(publishable.map((directory) => [directory, manifestOf(directory).version]));
    const distinct = new Set(versions.values());
    expect(distinct.size, `versions differ: ${JSON.stringify(Object.fromEntries(versions))}`).toBe(1);
  });

  test("only what the CLI does not need at runtime stays private", () => {
    const privatePackages = packageDirectories().filter((directory) => manifestOf(directory).private === true);
    expect(privatePackages).toEqual(["source-cron"]);
    // Nothing published imports it, and no command reads it.
    const users = publishable.filter((directory) => manifestOf(directory).dependencies?.["@operad-io/source-cron"] !== undefined);
    expect(users).toEqual([]);
  });

  test("the CLI depends on no package whose runtime code imports a third-party package", () => {
    const names = closure(manifestOf("cli"));
    const thirdParty: string[] = [];
    for (const directory of packageDirectories()) {
      const manifest = manifestOf(directory);
      if (!names.has(manifest.name)) continue;
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (!dependency.startsWith("@operad-io/")) thirdParty.push(`${manifest.name} -> ${dependency}`);
      }
    }
    expect(thirdParty).toEqual([]);
    expect(manifestOf("cli").dependencies?.["@operad-io/harness-claude"]).toBeUndefined();
    expect(manifestOf("cli").dependencies?.["@operad-io/tui"]).toBeUndefined();
  });

  test("pi and radian have no third-party runtime dependency", () => {
    for (const directory of ["harness/pi", "harness/radian"]) {
      const manifest = manifestOf(directory);
      const thirdParty = Object.keys(manifest.dependencies ?? {}).filter((name) => !name.startsWith("@operad-io/"));
      expect({ directory, thirdParty }).toEqual({ directory, thirdParty: [] });
    }
  });

  test("the CLI tarball's files list leaves tests and fixtures out", () => {
    const files = manifestOf("cli").files ?? [];
    expect(files).toEqual(["bin", "src", "LICENSE"]);
    expect(existsSync(join(cli, "test"))).toBe(true);
  });
});
