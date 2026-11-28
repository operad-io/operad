import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION } from "@operad-io/engine";
import { waitForChange } from "@operad-io/engine/platform";
import { freePort } from "@operad-io/engine/testing";

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

/** Where `run` writes a child's output: files, so a lost pipe read cannot hide it. */
const runOutput = scratch("operad-run-");
let runCount = 0;

/**
 * Runs a command with its output written to files rather than pipes. Bun 1.3.14
 * under load sometimes returns an empty pipe and exit 0 for a child that
 * printed (bun#46142); output on a file descriptor is never lost that way.
 */
function run(command: readonly string[], cwd: string, env: Record<string, string | undefined> = {}): Ran {
  runCount += 1;
  const prefix = join(runOutput, String(runCount));
  const stdout = `${prefix}.out`;
  const stderr = `${prefix}.err`;
  const out = openSync(stdout, "w");
  const err = openSync(stderr, "w");
  try {
    const result = Bun.spawnSync({
      cmd: [...command],
      cwd,
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: out,
      stderr: err,
    });
    return {
      code: result.exitCode ?? 1,
      out: readFileSync(stdout, "utf8"),
      err: readFileSync(stderr, "utf8"),
    };
  } finally {
    closeSync(out);
    closeSync(err);
  }
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

/** A local stand-in for the Claude Agent SDK, for tests that do not check the SDK install. */
function fakeSdkTarball(root: string): string {
  const directory = join(root, "fake-claude-agent-sdk");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@anthropic-ai/claude-agent-sdk",
      version: "0.3.319",
      type: "module",
      exports: { ".": "./index.js" },
    }),
  );
  writeFileSync(join(directory, "index.js"), "export default {};\n");
  const destination = join(root, "fake-claude-sdk-tarballs");
  mkdirSync(destination, { recursive: true });
  const packed = run(["bun", "pm", "pack", "--destination", destination, "--quiet"], directory);
  expect({ code: packed.code, err: packed.err }).toEqual({ code: 0, err: "" });
  return packed.out.trim();
}

/** A tarball of a third-party package as this checkout has it installed. */
function installedTarball(root: string, name: string, from: string): string {
  const directory = dirname(Bun.resolveSync(`${name}/package.json`, from));
  const destination = join(root, "third-party-tarballs", name);
  mkdirSync(destination, { recursive: true });
  const packed = run(["bun", "pm", "pack", "--ignore-scripts", "--destination", destination, "--quiet"], directory);
  expect({ name, code: packed.code, err: packed.err }).toEqual({ name, code: 0, err: "" });
  return packed.out.trim();
}

/** A small local package, packed. */
function localTarball(root: string, name: string, extra: Record<string, unknown> = {}): string {
  const directory = join(root, "local-packages", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", ...extra }));
  const packed = run(["bun", "pm", "pack", "--destination", directory, "--quiet"], directory);
  expect({ name, code: packed.code, err: packed.err }).toEqual({ name, code: 0, err: "" });
  return packed.out.trim();
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

/** A radian command: `init` only asks whether it is on PATH. */
function fakeRadian(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "radian");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return directory;
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
  test.skipIf(!online)("the packed CLI installs into a prefix and runs help and init", async () => {
    const scratchRoot = scratch("operad-publish-cli-");
    const tarballs = packAll(join(scratchRoot, "tarballs"));
    const binary = cliPrefix(scratchRoot, tarballs);
    expect(existsSync(binary)).toBe(true);

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
        overrides: {
          ...overridesOf(tarballs, ["@operad-io/harness-claude"]),
          "@anthropic-ai/claude-agent-sdk": `file:${fakeSdkTarball(scratchRoot)}`,
        },
      }),
    );
    const bin = join(scratchRoot, "bin");
    fakeClaude(bin);
    fakeRadian(bin);
    const path = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    const env = { OPERAD_HOME: home, PATH: path };

    const help = run([binary, "--help"], scratchRoot, env);
    expect({ code: help.code, err: help.err }).toEqual({ code: 0, err: "" });
    expect(help.out).toContain("usage: operad");

    const init = run([binary, "init"], scratchRoot, env);
    // A failed check names itself in init's output. Keep that output in the
    // failure, so a later flake says which probe answered nothing.
    if (init.code !== 0) throw new Error(`init exited ${init.code}:\n${init.out}${init.err}`);
    expect({ code: init.code, err: init.err }).toEqual({ code: 0, err: "" });
    expect(init.out).toContain("created");
    expect(init.out).toContain("radian: radian is available");
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins: Record<string, { enabled: boolean }>;
    };
    expect(config.plugins.chat?.enabled).toBe(true);
    expect(config.plugins.bot?.enabled).toBe(true);
    expect(config.plugins.memory?.enabled).toBe(true);
    expect(config.plugins.shell?.enabled).toBe(true);
    expect(config.plugins.dev?.enabled).toBe(true);
    expect(config.plugins.pool?.enabled).toBe(true);
    expect(config.plugins.claude?.enabled).toBe(true);

    const check = run([binary, "plugin", "check", "claude"], scratchRoot, env);
    expect({ code: check.code, err: check.err }).toEqual({ code: 0, err: "" });
    expect(check.out).toContain("claude: ok");
  }, 120_000);

  test.skipIf(!online)("init retries a claude install that failed after config.json was written", async () => {
    const scratchRoot = scratch("operad-publish-retry-");
    const tarballs = packAll(join(scratchRoot, "tarballs"));
    const binary = cliPrefix(scratchRoot, tarballs);
    const home = join(scratchRoot, "home");
    const claudePackage = tarballs.get("@operad-io/harness-claude");
    expect(claudePackage).toBeDefined();
    const project = join(home, "plugins");
    const sdk = fakeSdkTarball(scratchRoot);
    const manifest = (dependency: string): void => {
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({
          name: "operad-plugins",
          private: true,
          type: "module",
          dependencies: { "@operad-io/harness-claude": dependency },
          overrides: {
            ...overridesOf(tarballs, ["@operad-io/harness-claude"]),
            "@anthropic-ai/claude-agent-sdk": `file:${sdk}`,
          },
        }),
      );
    };
    manifest(`file:${join(scratchRoot, "missing.tgz")}`);
    const bin = join(scratchRoot, "bin");
    fakeClaude(bin);
    const path = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    const env = { OPERAD_HOME: home, PATH: path };

    const first = run([binary, "init"], scratchRoot, env);
    expect({ code: first.code, err: first.err.includes("missing.tgz") }).toEqual({ code: 1, err: true });
    expect(first.out).toContain("created");
    expect(existsSync(join(home, "config.json"))).toBe(true);

    manifest(`file:${claudePackage ?? ""}`);
    const second = run([binary, "init"], scratchRoot, env);
    expect({ code: second.code, err: second.err }).toEqual({ code: 0, err: "" });
    expect(second.out).toContain("using");

    const check = run([binary, "plugin", "check", "claude"], scratchRoot, env);
    expect({ code: check.code, err: check.err }).toEqual({ code: 0, err: "" });
    expect(check.out).toContain("claude: ok");
  }, 120_000);

  test("init leaves a claude entry that names its own module without installing the default package", async () => {
    const scratchRoot = scratch("operad-publish-own-module-");
    const tarballs = packAll(join(scratchRoot, "tarballs"));
    const binary = cliPrefix(scratchRoot, tarballs);
    const home = join(scratchRoot, "home");
    const bin = join(scratchRoot, "bin");
    fakeRadian(bin);
    // No claude on PATH, so the first init enables radian and installs nothing.
    const env = { OPERAD_HOME: home, PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) };

    const first = run([binary, "init"], scratchRoot, env);
    expect(first.code).toBe(0);
    const path = join(home, "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      plugins: Record<string, { enabled: boolean; module?: string }>;
    };
    writeFileSync(
      path,
      JSON.stringify({
        ...config,
        plugins: { ...config.plugins, claude: { enabled: true, module: join(scratchRoot, "own-claude.ts") } },
      }),
    );
    const second = run([binary, "init"], scratchRoot, env);
    expect(second.code).toBe(0);
    // An install of the default package would have added it to the home's project.
    const manifest = join(home, "plugins", "package.json");
    const text = existsSync(manifest) ? readFileSync(manifest, "utf8") : "";
    expect(text).not.toContain("@operad-io/harness-claude");
  }, 120_000);

  test("enabling terminal from the packed tarballs installs its package, which then loads", () => {
    const scratchRoot = scratch("operad-publish-terminal-");
    const tarballs = packAll(join(scratchRoot, "tarballs"));
    const binary = cliPrefix(scratchRoot, tarballs);
    const home = join(scratchRoot, "home");
    const terminalPackage = tarballs.get("@operad-io/terminal");
    expect(terminalPackage).toBeDefined();
    const project = join(home, "plugins");
    mkdirSync(project, { recursive: true });
    const source = join(root, "packages", "terminal");
    const addon = dirname(Bun.resolveSync("@xterm/addon-serialize/package.json", source));
    // A package already in the home's project that names an optional one, as the claude SDK does.
    const optional = localTarball(scratchRoot, "optional-binary");
    const host = localTarball(scratchRoot, "optional-host", {
      optionalDependencies: { "optional-binary": `file:${optional}` },
    });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        name: "operad-plugins",
        private: true,
        type: "module",
        dependencies: {
          "@operad-io/terminal": `file:${terminalPackage ?? ""}`,
          "optional-host": `file:${host}`,
        },
        overrides: {
          ...overridesOf(tarballs, ["@operad-io/terminal"]),
          "@xterm/headless": `file:${installedTarball(scratchRoot, "@xterm/headless", source)}`,
          "@xterm/addon-serialize": `file:${installedTarball(scratchRoot, "@xterm/addon-serialize", source)}`,
          "@xterm/xterm": `file:${installedTarball(scratchRoot, "@xterm/xterm", addon)}`,
        },
      }),
    );
    // Everything is a local tarball: an empty cache and a registry that cannot
    // answer keep the test off the machine's cache and the network.
    const env = {
      OPERAD_HOME: home,
      BUN_INSTALL_CACHE_DIR: join(scratchRoot, "bun-cache"),
      BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/",
    };

    const enabled = run([binary, "plugin", "enable", "terminal"], scratchRoot, env);
    expect({ code: enabled.code, err: enabled.err }).toEqual({ code: 0, err: "" });
    expect(enabled.out).toContain("terminal: enabled");
    for (const name of ["@operad-io/terminal", "@xterm/headless", "@xterm/addon-serialize"]) {
      expect({ name, installed: existsSync(join(project, "node_modules", name, "package.json")) }).toEqual({
        name,
        installed: true,
      });
    }

    expect(existsSync(join(project, "node_modules", "optional-host"))).toBe(true);
    expect(existsSync(join(project, "node_modules", "optional-binary"))).toBe(false);

    const check = run([binary, "plugin", "check", "terminal"], scratchRoot, env);
    expect({ code: check.code, err: check.err }).toEqual({ code: 0, err: "" });
    expect(check.out).toContain("terminal: ok");
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

// A `serve` process; `until` ends when what it printed satisfies the question.
function startServe(binary: string, cwd: string, env: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [binary, "serve"],
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  return {
    child,
    errors,
    // `serve stop`, without blocking: a serve this process started stays alive to
    // another until this process has taken its exit.
    async stop(): Promise<number[]> {
      const stop = Bun.spawn({
        cmd: [binary, "serve", "stop"],
        cwd,
        env: { ...process.env, ...env },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      return [await stop.exited, await child.exited];
    },
    async until(found: (out: string) => boolean): Promise<string> {
      while (!found(seen)) {
        const read = await reader.read();
        if (read.done) throw new Error(`serve ended first: ${seen}${await errors}`);
        seen += decoder.decode(read.value, { stream: true });
      }
      return seen;
    },
  };
}

const times = (text: string, part: string): number => text.split(part).length - 1;

// A new home of the packed CLI whose plugin project can be told where `terminal` comes from.
async function newTerminalHome(prefix: string) {
  const scratchRoot = scratch(prefix);
  const tarballs = packAll(join(scratchRoot, "tarballs"));
  const binary = cliPrefix(scratchRoot, tarballs);
  const home = join(scratchRoot, "home");
  const project = join(home, "plugins");
  mkdirSync(project, { recursive: true });
  const source = join(root, "packages", "terminal");
  const addon = dirname(Bun.resolveSync("@xterm/addon-serialize/package.json", source));
  const overrides = {
    ...overridesOf(tarballs, ["@operad-io/terminal"]),
    "@xterm/headless": `file:${installedTarball(scratchRoot, "@xterm/headless", source)}`,
    "@xterm/addon-serialize": `file:${installedTarball(scratchRoot, "@xterm/addon-serialize", source)}`,
    "@xterm/xterm": `file:${installedTarball(scratchRoot, "@xterm/xterm", addon)}`,
  };
  const name = (dependency: string): void => {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        name: "operad-plugins",
        private: true,
        type: "module",
        dependencies: { "@operad-io/terminal": dependency },
        overrides,
      }),
    );
  };
  const bin = join(scratchRoot, "bin");
  fakeRadian(bin);
  const env = {
    OPERAD_HOME: home,
    HOME: scratchRoot,
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    BUN_INSTALL_CACHE_DIR: join(scratchRoot, "bun-cache"),
    // Cannot answer: everything but what a test serves is a local tarball.
    BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/",
  };
  const port = await freePort();
  // Runs `init` and gives the home's `serve` a port of its own.
  const init = (extra: Record<string, string> = {}): Ran => {
    const ran = run([binary, "init"], scratchRoot, { ...env, ...extra });
    const path = join(home, "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as { http: { port: number } };
    config.http.port = port;
    writeFileSync(path, JSON.stringify(config));
    return ran;
  };
  return { scratchRoot, tarballs, binary, home, name, env, init };
}

describe("terminal in a new home of the packed CLI", () => {
  test("no start fails with a download that does, and the next start installs and loads it", async () => {
    const made = await newTerminalHome("operad-publish-new-terminal-");
    const { binary, scratchRoot, env, home } = made;
    made.name(`file:${join(scratchRoot, "missing.tgz")}`);

    const init = made.init();
    expect({ code: init.code, err: init.err }).toEqual({ code: 0, err: "" });
    expect(init.out).toContain("terminal: not set up: the terminal package is not installed");

    const log = join(home, "store", "logs", "terminal", "install.log");
    const first = startServe(binary, scratchRoot, env);
    try {
      await first.until((out) => out.includes("serving "));
      while (!existsSync(log) || !readFileSync(log, "utf8").includes("\n")) {
        await waitForChange(dirname(log), "install.log", 100);
      }
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("not set up: ");
      expect(lines[0]).toContain("missing.tgz");
      const pending = run([binary, "pending"], scratchRoot, env);
      expect({ out: pending.out, err: pending.err }).toEqual({ out: "nothing is waiting\n", err: "" });
      const guide = run([binary, "bot", "setup", "default", "terminal"], scratchRoot, env);
      expect({ code: guide.code, err: guide.err }).toEqual({ code: 0, err: "" });
      expect(guide.out).toContain("- install: the terminal package is not installed");
      expect(await first.stop()).toEqual([0, 0]);
      expect(await first.errors).toBe("");
    } finally {
      first.child.kill("SIGKILL");
    }

    made.name(`file:${made.tarballs.get("@operad-io/terminal") ?? ""}`);
    const second = startServe(binary, scratchRoot, env);
    try {
      const out = await second.until((text) => times(text, "serving ") === 2);
      expect(out).toContain("reloading: installed terminal");
      const check = run([binary, "plugin", "check", "terminal"], scratchRoot, env);
      expect({ code: check.code, err: check.err }).toEqual({ code: 0, err: "" });
      const again = run([binary, "init"], scratchRoot, env);
      // The package itself is loaded: the stand-in no longer says it is not set up.
      expect({ code: again.code, standIn: again.out.includes("terminal: not set up") }).toEqual({ code: 0, standIn: false });
      expect(run([binary, "bot", "setup", "default", "terminal"], scratchRoot, env).err).toContain("has no setup guide");
      expect(await second.stop()).toEqual([0, 0]);
      expect(await second.errors).toBe("");
    } finally {
      second.child.kill("SIGKILL");
    }
  }, 180_000);

  test("init does not wait for the download, and a stop of serve ends it", async () => {
    const made = await newTerminalHome("operad-publish-slow-terminal-");
    const { binary, scratchRoot } = made;
    let asked = (): void => undefined;
    let dropped = (): void => undefined;
    const requested = new Promise<void>((resolve) => (asked = resolve));
    const abandoned = new Promise<void>((resolve) => (dropped = resolve));
    // A registry that takes the request and never answers it.
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => {
        request.signal.addEventListener("abort", () => dropped());
        asked();
        return new Promise<Response>(() => undefined);
      },
    });
    const env = { ...made.env, BUN_CONFIG_REGISTRY: `http://127.0.0.1:${String(registry.port)}/` };
    made.name(ENGINE_VERSION);
    try {
      // `init` blocks this process, so the registry cannot answer it: it returns only if it asks for nothing.
      const init = made.init({ BUN_CONFIG_REGISTRY: env.BUN_CONFIG_REGISTRY });
      expect({ code: init.code, err: init.err }).toEqual({ code: 0, err: "" });
      const serve = startServe(binary, scratchRoot, env);
      try {
        await serve.until((out) => out.includes("serving "));
        await requested;
        expect(await serve.stop()).toEqual([0, 0]);
        await abandoned;
        expect(await serve.errors).toBe("");
        expect(existsSync(join(made.home, "store", "logs", "terminal", "install.log"))).toBe(false);
      } finally {
        serve.child.kill("SIGKILL");
      }
    } finally {
      await registry.stop(true);
    }
  }, 180_000);
});
