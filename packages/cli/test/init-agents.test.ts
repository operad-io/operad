import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CliIo } from "../src/main.ts";
import type { InstallRunner } from "@operad-io/engine";
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

function executable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// The plugins of every new home, before its harnesses.
const FIXED = ["chat", "bot", "memory", "cron", "shell", "pool", "dev", "telegram", "terminal"];

/** A fake `claude` that passes the harness check without a real agent. */
function fakeClaude(
  bin: string,
  emptyFirst?: string,
  answers: { readonly version?: string | undefined; readonly loggedIn?: boolean | undefined } = {},
): void {
  const { version = "2.1.319", loggedIn = true } = answers;
  const lines = ["#!/bin/sh"];
  if (emptyFirst !== undefined) {
    lines.push(
      `count=$(cat '${emptyFirst}' 2>/dev/null || echo 0)`,
      "count=$((count + 1))",
      `printf '%s' "$count" > '${emptyFirst}'`,
      'if [ "$count" -eq 1 ]; then exit 0; fi',
    );
  }
  lines.push(
    `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi`,
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
    `  printf '{"loggedIn":${loggedIn},"authMethod":"claude.ai","subscriptionType":"max"}\\n'`,
    // The real command exits 1 when nobody is logged in.
    `  exit ${loggedIn ? 0 : 1}`,
    "fi",
    "exit 1",
    "",
  );
  executable(join(bin, "claude"), lines.join("\n"));
}

/** A fake pi install: the check reads the package beside the command, it never runs it. */
function fakePi(root: string, bin: string): void {
  const dir = join(root, "pi", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(dir, "dist", "bundle"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.5.0",
      exports: { ".": "./dist/index.js" },
      bin: { pi: "dist/bundle/cli.js" },
    }),
  );
  writeFileSync(join(dir, "dist", "index.js"), "export const marker = \"fake pi\";\n");
  executable(join(dir, "dist", "bundle", "cli.js"), "#!/bin/sh\nexit 1\n");
  Bun.spawnSync(["ln", "-s", join(dir, "dist", "bundle", "cli.js"), join(bin, "pi")]);
}

function fakeRadian(bin: string): void {
  executable(join(bin, "radian"), "#!/bin/sh\nexit 0\n");
}

/** Packs a local pi package, so an install never reaches a registry. */
function packPiFixture(root: string): string {
  const directory = join(root, "pi-fixture");
  mkdirSync(join(directory, "dist", "bundle"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.7.0",
      exports: { ".": { import: "./dist/index.js" } },
      bin: { pi: "dist/bundle/cli.js" },
    }),
  );
  writeFileSync(join(directory, "dist", "index.js"), "export const marker = \"fixture-pi\";\n");
  executable(join(directory, "dist", "bundle", "cli.js"), "#!/bin/sh\nexit 1\n");
  const destination = join(root, "tarballs");
  mkdirSync(destination, { recursive: true });
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--destination", destination, "--quiet"], {
    cwd: directory,
  });
  return packed.stdout.toString().trim();
}

/** A home plugin project that names the local pi tarball. */
function namePiTarball(home: string, tarball: string): void {
  mkdirSync(join(home, "plugins"), { recursive: true });
  writeFileSync(
    join(home, "plugins", "package.json"),
    JSON.stringify({
      name: "operad-plugins",
      private: true,
      type: "module",
      dependencies: { "@earendil-works/pi-coding-agent": `file:${tarball}` },
    }),
  );
}

async function initWith(
  root: string,
  bins: readonly string[],
  options: {
    readonly emptyFirstProbe?: string | undefined;
    readonly piTarball?: string | undefined;
    readonly config?: string | undefined;
    readonly installRun?: InstallRunner | undefined;
  } = {},
): Promise<{
  readonly code: number;
  readonly output: Output;
  readonly plugins: readonly string[];
}> {
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of bins) {
    if (name === "claude") fakeClaude(bin, options.emptyFirstProbe);
    else if (name === "pi") fakePi(root, bin);
    else if (name === "radian") fakeRadian(bin);
  }
  if (options.piTarball !== undefined) namePiTarball(home, options.piTarball);
  if (options.config !== undefined) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), options.config);
  }
  const previous = process.env.PATH;
  const previousCache = process.env.BUN_INSTALL_CACHE_DIR;
  const previousRegistry = process.env.BUN_CONFIG_REGISTRY;
  process.env.PATH = bin;
  // The pi install is a local tarball; an empty cache and a registry that
  // cannot answer keep the test off both the machine's cache and the network.
  process.env.BUN_INSTALL_CACHE_DIR = mkdtempSync(join(root, "bun-cache-"));
  process.env.BUN_CONFIG_REGISTRY = "http://127.0.0.1:9/";
  try {
    const output = capture();
    const code = await main(["init"], {
      home,
      io: output.io,
      ...(options.installRun === undefined ? {} : { pluginInstall: options.installRun }),
    });
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins: Record<string, { enabled: boolean }>;
    };
    return { code, output, plugins: Object.keys(config.plugins) };
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    if (previousCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previousCache;
    if (previousRegistry === undefined) delete process.env.BUN_CONFIG_REGISTRY;
    else process.env.BUN_CONFIG_REGISTRY = previousRegistry;
  }
}

describe("`operad init` finds the agent on PATH", () => {
  test("a fresh home loads cron from its package, so routines is a known command", async () => {
    const root = await tempRoot();
    const { code } = await initWith(root, ["radian"]);
    expect(code).toBe(0);
    const home = join(root, "home");
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins: Record<string, { module: string; enabled: boolean }>;
    };
    expect(config.plugins.cron).toEqual({ module: "@operad-io/source-cron", enabled: true });
    const out = capture();
    expect(await main(["routines", "list"], { home, io: out.io })).toBe(0);
    expect(out.errors()).toBe("");
    expect(out.text()).not.toContain("unknown command");
  });

  test("only claude is enabled, and its package is not a CLI dependency", async () => {
    const root = await tempRoot();
    const { code, output, plugins } = await initWith(root, ["claude"]);
    expect(code).toBe(0);
    expect(plugins).toEqual([...FIXED, "claude", "pi", "codex", "radian"]);
    expect(output.text()).toContain("claude: claude 2.1.319");
    for (const name of ["pi", "codex", "radian"]) expect(output.text()).toContain(`${name}: not set up: `);
  });

  test("an empty first probe answer is asked again, so claude still passes", async () => {
    const root = await tempRoot();
    const calls = join(root, "probe-calls");
    const { code, output } = await initWith(root, ["claude"], { emptyFirstProbe: calls });
    expect(code).toBe(0);
    expect(output.text()).toContain("claude: claude 2.1.319");
    expect(Number(readFileSync(calls, "utf8"))).toBeGreaterThanOrEqual(2);
  });

  test("only pi is enabled", async () => {
    const root = await tempRoot();
    const { code, output, plugins } = await initWith(root, ["pi"]);
    expect(code).toBe(0);
    expect(plugins).toEqual([...FIXED, "pi", "codex", "radian"]);
    expect(output.text()).toContain("pi: pi 1.5.0");
    for (const name of ["codex", "radian"]) expect(output.text()).toContain(`${name}: not set up: `);
    expect(output.text()).not.toContain("claude:");
  });

  test("with radian, claude and pi on PATH, radian is not the first agent", async () => {
    const root = await tempRoot();
    const { code, plugins } = await initWith(root, ["radian", "claude", "pi"]);
    expect(code).toBe(0);
    expect(plugins).toEqual([...FIXED, "claude", "pi", "radian", "codex"]);
  });

  test("only radian is enabled", async () => {
    const root = await tempRoot();
    const { code, output, plugins } = await initWith(root, ["radian"]);
    expect(code).toBe(0);
    expect(plugins).toEqual([...FIXED, "radian", "pi", "codex"]);
    expect(output.text()).toContain("radian: radian is available");
    expect(output.text()).toContain("pi: not set up: ");
    expect(output.text()).not.toContain("claude:");
  });

  test("with no agent, init installs its own pi and passes", async () => {
    const root = await tempRoot();
    const { code, output, plugins } = await initWith(root, [], { piTarball: packPiFixture(root) });
    expect(code).toBe(0);
    expect(plugins).toEqual([...FIXED, "pi", "codex", "radian"]);
    expect(output.text()).toContain("telegram: not set up: ");
    expect(output.text()).toContain("no agent found on PATH: installing operad's own pi");
    expect(output.text()).toContain("pi: pi 1.7.0");
    expect(output.errors()).toBe("");
  });

  test("a pi entry written without a module still gets the install", async () => {
    const root = await tempRoot();
    const { code, output } = await initWith(root, [], {
      piTarball: packPiFixture(root),
      config: JSON.stringify({ plugins: { pi: { enabled: true } } }),
    });
    // The install runs, but an entry with no module names none that can be
    // imported, so the plugin does not load and init says so.
    expect(code).toBe(1);
    expect(output.errors()).toContain('plugin "pi": import failed');
    expect(output.text()).toContain("pi: Saved lockfile");
  });

  test("a failed pi install says the download failed, and init again installs it", async () => {
    const root = await tempRoot();
    const tarball = packPiFixture(root);
    const first = await initWith(root, [], {
      piTarball: tarball,
      installRun: () => ({
        exitCode: 1,
        stdout: "",
        stderr: "error: getaddrinfo ENOTFOUND registry.npmjs.org\n",
      }),
    });
    expect(first.code).toBe(1);
    expect(first.output.errors()).toContain("could not be downloaded");
    expect(first.output.errors()).toContain("run the command again");

    const second = await initWith(root, [], { piTarball: tarball });
    expect(second.code).toBe(0);
    expect(second.output.text()).toContain("pi: pi 1.7.0");
  });

  test("a home with operad's pi at an older pin is moved to the new one", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const plugins = join(home, "plugins");
    const name = "@earendil-works/pi-coding-agent";
    const writePi = (version: string): void => {
      const dir = join(plugins, "node_modules", name);
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name, version, exports: { ".": "./dist/index.js" } }),
      );
      writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
    };
    writePi("1.6.0");
    writeFileSync(
      join(plugins, "package.json"),
      JSON.stringify({ name: "operad-plugins", private: true, dependencies: { [name]: "1.6.0" } }),
    );
    const calls: string[] = [];
    const { code, output } = await initWith(root, [], {
      installRun: (_cwd, args) => {
        calls.push(args.join(" "));
        writePi("1.7.0");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["install --no-summary"]);
    const manifest = JSON.parse(readFileSync(join(plugins, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies[name]).toBe("1.7.0");
    expect(output.text()).toContain("pi: pi 1.7.0");
  });

  test("a bare operad leaves an older copy for serve to move", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const plugins = join(home, "plugins");
    const name = "@earendil-works/pi-coding-agent";
    const dir = join(plugins, "node_modules", name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "1.6.0", exports: { ".": "./dist/index.js" } }),
    );
    writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
    writeFileSync(
      join(plugins, "package.json"),
      JSON.stringify({ name: "operad-plugins", private: true, dependencies: { [name]: "1.6.0" } }),
    );
    mkdirSync(join(root, "bin"), { recursive: true });
    const calls: string[] = [];
    const previous = process.env.PATH;
    process.env.PATH = join(root, "bin");
    try {
      const output = capture();
      const code = await main([], {
        home,
        io: output.io,
        tui: async () => 0,
        pluginInstall: (_cwd, args) => {
          calls.push(args.join(" "));
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      });
      expect(output.errors()).toBe("");
      expect(code).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  test("a new home with another agent installs no pi", async () => {
    const root = await tempRoot();
    const calls: string[] = [];
    const { code } = await initWith(root, ["radian"], {
      installRun: (_cwd, args) => {
        calls.push(args.join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(0);
    expect(calls.join("\n")).not.toContain("pi-coding-agent");
  });

  test("a new home with pi on PATH uses it and installs no pi of its own", async () => {
    const root = await tempRoot();
    const calls: string[] = [];
    const { code, output } = await initWith(root, ["pi"], {
      installRun: (_cwd, args) => {
        calls.push(args.join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(0);
    expect(calls.join("\n")).not.toContain("pi-coding-agent");
  });

  test("a home with a config.json keeps its plugins and switches on upgrade", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    fakeRadian(bin);
    const before = `${JSON.stringify(
      {
        plugins: {
          shell: { module: "@operad-io/shell", enabled: true },
          radian: { module: "@operad-io/harness-radian", enabled: true },
          chat: { module: "@operad-io/chat", enabled: true },
          pool: { module: "@operad-io/pool", enabled: true },
          dev: { module: "@operad-io/dev", enabled: true },
          memory: { module: "@operad-io/memory", enabled: false },
        },
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
        mcp: { actions: ["dev:rework", "chat:close"], confirmActions: ["chat:close"] },
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(home, "config.json"), before);

    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const output = capture();
      expect(await main(["init"], { home, io: output.io })).toBe(0);
      expect(output.text()).toContain(`using ${join(home, "config.json")}`);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }

    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
    const config = JSON.parse(before) as {
      plugins: Record<string, { enabled: boolean }>;
      mcp: { actions: string[] };
    };
    expect(Object.keys(config.plugins)).toEqual(["shell", "radian", "chat", "pool", "dev", "memory"]);
    expect(config.plugins.shell?.enabled).toBe(true);
    expect(config.plugins.memory?.enabled).toBe(false);
    expect(config.mcp.actions).toEqual(["dev:rework", "chat:close"]);
  });
});

/** Runs one command on the test's home, with only its `bin` on PATH. */
async function runIn(root: string, command: string): Promise<{ readonly code: number; readonly output: Output }> {
  const previous = process.env.PATH;
  process.env.PATH = join(root, "bin");
  try {
    const output = capture();
    const code = await main([command], { home: join(root, "home"), io: output.io });
    return { code, output };
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

/** A claude on the test's PATH that answers as given; `initWith(root, [])` keeps it. */
function claudeThat(root: string, answers: Parameters<typeof fakeClaude>[2]): void {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  fakeClaude(bin, undefined, answers);
}

describe("`operad init` with an agent that needs the person", () => {
  const cases = [
    {
      title: "that is not signed in",
      answers: { loggedIn: false },
      says: "claude is not logged in; run `claude auth login`, then check again",
      next: "claude auth login",
    },
    {
      title: "older than the floor",
      answers: { version: "2.1.318" },
      says: "is older than the floor 2.1.319; update claude (`claude update`)",
      next: "claude update",
    },
  ];

  for (const { title, answers, says, next } of cases) {
    test(`a claude ${title} is not set up, init passes, and doctor lists a problem`, async () => {
      const root = await tempRoot();
      claudeThat(root, answers);
      const { code, output } = await initWith(root, []);
      expect(output.errors()).toBe("");
      expect(code).toBe(0);
      const line = output.text().split("\n").find((text) => text.startsWith("claude: "));
      expect(line).toStartWith("claude: not set up: ");
      expect(line).toContain(says);
      const config = JSON.parse(readFileSync(join(root, "home", "config.json"), "utf8")) as {
        plugins: Record<string, { enabled: boolean }>;
      };
      expect(config.plugins.claude?.enabled).toBe(true);

      const doctor = await runIn(root, "doctor");
      expect(doctor.code).toBe(1);
      const agent = doctor.output.text().split("\n").find((text) => text.includes("agent claude"));
      expect(agent).toStartWith("problem  agent claude cannot be used: ");
      expect(agent).toContain(says);
      expect(agent).toEndWith(` -> ${next}`);
    });
  }
});

describe("`operad init` still fails on a real failure", () => {
  test("a claude whose version cannot be read fails the check", async () => {
    const root = await tempRoot();
    claudeThat(root, { version: "unknown" });
    const { code, output } = await initWith(root, []);
    expect(code).toBe(1);
    expect(output.text()).toContain("did not print a version this check can read");
    expect(output.text()).not.toContain("claude: not set up: ");
  });

  test("a config.json that is not valid", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), "{");
    const { code, output } = await runIn(root, "init");
    expect(code).not.toBe(0);
    expect(output.errors()).toContain("config.json");
  });

  for (const [title, others] of [
    ["beside plugins that load", { shell: { module: "@operad-io/shell" } }],
    ["as the only plugin", {}],
  ] as const) {
    test(`a plugin that cannot load, ${title}`, async () => {
      const root = await tempRoot();
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const broken = join(root, "broken.ts");
      writeFileSync(broken, "export default (\n");
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ plugins: { ...others, broken: { module: broken } } }),
      );
      const { code, output } = await runIn(root, "init");
      expect(code).toBe(1);
      expect(output.errors()).toContain("import failed");
    });
  }

  test("a plugin that is off and cannot load is no failure", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ plugins: { broken: { module: join(root, "absent.ts"), enabled: false } } }),
    );
    expect((await runIn(root, "init")).code).toBe(0);
  });
});
