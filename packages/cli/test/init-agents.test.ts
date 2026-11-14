import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

function executable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A fake `claude` that passes the harness check without a real agent. */
function fakeClaude(bin: string): void {
  executable(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2.1.319 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      '  printf \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\\n\'',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
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

async function initWith(
  root: string,
  bins: readonly string[],
): Promise<{
  readonly code: number;
  readonly output: Output;
  readonly plugins: readonly string[];
}> {
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of bins) {
    if (name === "claude") fakeClaude(bin);
    else if (name === "pi") fakePi(root, bin);
    else if (name === "radian") fakeRadian(bin);
  }
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    const output = capture();
    const code = await main(["init"], { home, io: output.io });
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins: Record<string, { enabled: boolean }>;
    };
    return { code, output, plugins: Object.keys(config.plugins) };
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

describe("`operad init` finds the agent on PATH", () => {
  test("only claude is enabled, and its package is not a CLI dependency", async () => {
    const root = await tempRoot();
    const { code, output, plugins } = await initWith(root, ["claude"]);
    expect(code).toBe(0);
    expect(plugins).toEqual(["shell", "claude", "chat", "pool", "dev"]);
    expect(output.text()).toContain("claude: claude 2.1.319");
    expect(output.text()).not.toContain("radian:");
    expect(output.text()).not.toContain("pi:");
  });

  test("only pi is enabled", async () => {
    const root = await tempRoot();
    const { code, output, plugins } = await initWith(root, ["pi"]);
    expect(code).toBe(0);
    expect(plugins).toEqual(["shell", "pi", "chat", "pool", "dev"]);
    expect(output.text()).toContain("pi: pi 1.5.0");
    expect(output.text()).not.toContain("radian:");
    expect(output.text()).not.toContain("claude:");
  });

  test("only radian is enabled", async () => {
    const root = await tempRoot();
    const { code, output, plugins } = await initWith(root, ["radian"]);
    expect(code).toBe(0);
    expect(plugins).toEqual(["shell", "radian", "chat", "pool", "dev"]);
    expect(output.text()).toContain("radian: radian is available");
    expect(output.text()).not.toContain("claude:");
    expect(output.text()).not.toContain("pi:");
  });

  test("no agent keeps radian and fails, naming the three agents and how to install one", async () => {
    const root = await tempRoot();
    const { code, output, plugins } = await initWith(root, []);
    expect(code).toBe(1);
    expect(plugins).toEqual(["shell", "radian", "chat", "pool", "dev"]);
    expect(output.text()).toContain("no agent found on PATH");
    expect(output.text()).toContain("claude (https://code.claude.com)");
    expect(output.text()).toContain("pi (bun add -g @earendil-works/pi-coding-agent)");
    expect(output.text()).toContain("radian");
    expect(output.text()).toContain("radian: radian was not found on PATH");
  });
});
