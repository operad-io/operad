import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const roots: string[] = [];
afterAll(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

interface Manifest {
  readonly name: string;
  readonly private?: boolean;
}

function manifestOf(directory: string): Manifest {
  return JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8")) as Manifest;
}

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

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function run(command: readonly string[], cwd: string, env: Record<string, string | undefined> = {}): Ran {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

/** Packs every package `bun publish` would publish, name to tarball. */
function packAll(directory: string): ReadonlyMap<string, string> {
  mkdirSync(directory, { recursive: true });
  const tarballs = new Map<string, string>();
  for (const packageDirectory of packageDirectories()) {
    const manifest = manifestOf(packageDirectory);
    if (manifest.private === true) continue;
    const ran = run(
      ["bun", "pm", "pack", "--destination", directory, "--quiet"],
      join(root, "packages", packageDirectory),
    );
    expect({ package: packageDirectory, code: ran.code, err: ran.err }).toEqual({
      package: packageDirectory,
      code: 0,
      err: "",
    });
    const file = ran.out.trim();
    expect({ package: packageDirectory, exists: existsSync(file) }).toEqual({ package: packageDirectory, exists: true });
    const listing = run(["tar", "-tzf", file], directory);
    expect({ package: packageDirectory, code: listing.code }).toEqual({ package: packageDirectory, code: 0 });
    expect({ package: packageDirectory, tests: listing.out.split("\n").filter((entry) => /\/test\//.test(entry)) }).toEqual({
      package: packageDirectory,
      tests: [],
    });
    expect({ package: packageDirectory, mutations: listing.out.includes("MUTATIONS.md") }).toEqual({
      package: packageDirectory,
      mutations: false,
    });
    expect({ package: packageDirectory, licence: listing.out.split("\n").includes("package/LICENSE") }).toEqual({
      package: packageDirectory,
      licence: true,
    });
    tarballs.set(manifest.name, file);
  }
  return tarballs;
}

function overridesOf(tarballs: ReadonlyMap<string, string>, omit: readonly string[] = []): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [name, file] of tarballs) {
    if (!omit.includes(name)) overrides[name] = `file:${file}`;
  }
  return overrides;
}

/** Installs the CLI from the tarballs into a prefix of its own. */
function cliPrefix(scratchRoot: string, tarballs: ReadonlyMap<string, string>): string {
  const prefix = join(scratchRoot, "prefix");
  mkdirSync(prefix, { recursive: true });
  const cli = tarballs.get("@operad-io/cli");
  expect(cli).toBeDefined();
  writeFileSync(
    join(prefix, "package.json"),
    JSON.stringify({
      name: "operad-publish-test",
      private: true,
      dependencies: { "@operad-io/cli": `file:${cli ?? ""}` },
      overrides: overridesOf(tarballs, ["@operad-io/cli"]),
    }),
  );
  const installed = run(["bun", "install", "--omit=optional", "--no-summary"], prefix);
  expect({ code: installed.code, err: installed.err.includes("error:") }).toEqual({ code: 0, err: false });
  return join(prefix, "node_modules", ".bin", "operad");
}

/** A claude command that only answers the two probes `plugin check` runs. */
function fakeClaude(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "claude");
  writeFileSync(
    path,
    `#!/bin/sh\ncase "$1" in\n  --version) printf '%s\\n' '2.1.319 (Claude Code)';;\n  auth) printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}';;\n  *) exit 9;;\nesac\n`,
  );
  chmodSync(path, 0o755);
  return directory;
}

const online = await (async (): Promise<boolean> => {
  try {
    const response = await fetch("https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk", {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
})();

describe("publishing and installing the packages", () => {
  test("the packed CLI installs into a prefix and runs help and init", async () => {
    const scratchRoot = scratch("operad-publish-cli-");
    const tarballs = packAll(join(scratchRoot, "tarballs"));
    const binary = cliPrefix(scratchRoot, tarballs);
    expect(existsSync(binary)).toBe(true);

    const home = join(scratchRoot, "home");
    const path = `${fakeClaude(join(scratchRoot, "bin"))}${delimiter}${process.env.PATH ?? ""}`;
    const env = { OPERAD_HOME: home, PATH: path };

    const help = run([binary, "--help"], scratchRoot, env);
    expect({ code: help.code, err: help.err }).toEqual({ code: 0, err: "" });
    expect(help.out).toContain("usage: operad");

    const init = run([binary, "init"], scratchRoot, env);
    expect({ code: init.code, err: init.err }).toEqual({ code: 0, err: "" });
    expect(init.out).toContain("created");
    expect(init.out).toContain("shell: ready");
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins: Record<string, { enabled: boolean }>;
    };
    expect(config.plugins.shell?.enabled).toBe(true);

    const missing = run([binary, "plugin", "check", "claude"], scratchRoot, env);
    expect({ code: missing.code, err: missing.err }).toEqual({ code: 1, err: "" });
    expect(missing.out).toBe("claude: not installed; run `operad plugin enable claude` to install it\n");
  }, 120_000);

  test.skipIf(!online)(
    "enabling claude from the packed tarballs installs the SDK without a platform package",
    async () => {
      const scratchRoot = scratch("operad-publish-claude-");
      const tarballs = packAll(join(scratchRoot, "tarballs"));
      const binary = cliPrefix(scratchRoot, tarballs);
      const home = join(scratchRoot, "home");
      const claudePackage = tarballs.get("@operad-io/harness-claude");
      expect(claudePackage).toBeDefined();
      const project = join(home, "plugins");
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({
          name: "operad-plugins",
          private: true,
          type: "module",
          dependencies: { "@operad-io/harness-claude": `file:${claudePackage ?? ""}` },
          overrides: overridesOf(tarballs, ["@operad-io/harness-claude"]),
        }),
      );

      const enabled = run([binary, "plugin", "enable", "claude"], scratchRoot, { OPERAD_HOME: home });
      expect({ code: enabled.code, err: enabled.err }).toEqual({ code: 0, err: "" });
      expect(enabled.out).toContain("claude: enabled");

      const sdk = join(project, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
      expect(existsSync(sdk)).toBe(true);
      const anthropic = readdirSync(join(project, "node_modules", "@anthropic-ai"));
      expect(anthropic.filter((name) => name.startsWith("claude-agent-sdk-"))).toEqual([]);

      const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
        plugins: Record<string, { enabled: boolean }>;
      };
      expect(config.plugins.claude?.enabled).toBe(true);

      const path = `${fakeClaude(join(scratchRoot, "bin"))}${delimiter}${process.env.PATH ?? ""}`;
      const check = run([binary, "plugin", "check", "claude"], scratchRoot, { OPERAD_HOME: home, PATH: path });
      expect({ code: check.code, err: check.err }).toEqual({ code: 0, err: "" });
      expect(check.out).toContain("claude: ok");
    },
    180_000,
  );
});
