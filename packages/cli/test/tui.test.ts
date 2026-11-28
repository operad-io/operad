import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTui, main, type CliIo, type TuiCommand, type TuiRunner } from "../src/main.ts";
import type { InstallRunner } from "@operad-io/engine";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A pi install that writes the package a local tarball would have put there. */
function fakePiInstall(): InstallRunner {
  return (cwd) => {
    const name = "@earendil-works/pi-coding-agent";
    const dir = join(cwd, "node_modules", name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "1.7.0", exports: { ".": "./dist/index.js" }, bin: { pi: "dist/cli.js" } }),
    );
    writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
    writeFileSync(join(dir, "dist", "cli.js"), "#!/bin/sh\nexit 1\n");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function capture(): {
  readonly io: CliIo;
  text(): string;
  errors(): string;
} {
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

describe("operad tui", () => {
  test("installs the terminal client into the home when the CLI has no copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "operad-tui-install-"));
    roots.push(root);
    const home = join(root, "home");
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    const calls: (readonly string[])[] = [];
    const runner = await loadTui(home, {
      from: empty,
      run: (_cwd, args) => {
        calls.push(args);
        const directory = join(home, "plugins", "node_modules", "@operad-io", "tui");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({ name: "@operad-io/tui", version: "0.0.1", exports: { ".": "./index.ts" } }),
        );
        writeFileSync(
          join(directory, "index.ts"),
          'export function runTui() { return Promise.resolve(0); }\nrunTui.testMarker = "home-tui";\n',
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual([["install", "--no-summary"]]);
    expect((runner as TuiRunner & { readonly testMarker?: string }).testMarker).toBe("home-tui");
  });

  test("passes the url and token to the terminal app", async () => {
    const output = capture();
    let seen: TuiCommand | undefined;
    const code = await main(
      // 9000 is an explicit, non-default port: --url names the address exactly.
      ["tui", "--url", "http://127.0.0.1:9000", "--token", "a-token"],
      {
        home: "/tmp/operad-tui-home",
        io: output.io,
        isTTY: true,
        tui: async (command) => {
          seen = command;
          command.onError?.("a stream dropped");
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(seen?.home).toBe("/tmp/operad-tui-home");
    expect(seen?.url).toBe("http://127.0.0.1:9000");
    expect(seen?.token).toBe("a-token");
    expect(output.errors()).toContain("operad: a stream dropped");
  });

  test("accepts the equals forms and rejects an unknown argument", async () => {
    const output = capture();
    let seen: TuiCommand | undefined;
    expect(
      await main(
        ["tui", "--url=http://host:1", "--token=t", "--url=http://host:2"],
        {
          home: "/tmp/home",
          io: output.io,
          isTTY: true,
          tui: async (command) => {
            seen = command;
            return 0;
          },
        },
      ),
    ).toBe(0);
    expect(seen?.url).toBe("http://host:2");
    expect(seen?.token).toBe("t");

    const bad = capture();
    expect(
      await main(["tui", "--port", "1"], {
        home: "/tmp/home",
        io: bad.io,
        isTTY: true,
        tui: async () => 0,
      }),
    ).toBe(2);
    expect(bad.errors()).toContain('tui: unknown argument "--port"');
  });

  test("needs a terminal unless a runner is injected", async () => {
    const output = capture();
    expect(
      await main(["tui"], {
        home: "/tmp/home",
        io: output.io,
        isTTY: false,
      }),
    ).toBe(2);
    expect(output.errors()).toContain("tui needs a terminal");
  });

  test("--no-start is passed on, and the app gets this process's entry and a way to print", async () => {
    const output = capture();
    const seen: TuiCommand[] = [];
    for (const argv of [["tui"], ["tui", "--no-start"]]) {
      expect(
        await main(argv, {
          home: "/tmp/home",
          io: output.io,
          isTTY: true,
          tui: async (command) => {
            seen.push(command);
            command.write?.("starting operad serve (log: /tmp/home/serve.log)");
            return 0;
          },
        }),
      ).toBe(0);
    }
    expect(seen[0]?.noStart).toBeUndefined();
    expect(seen[1]?.noStart).toBe(true);
    expect(seen[0]?.serveEntry?.endsWith("bin/operad.ts")).toBe(true);
    expect(output.text()).toContain("starting operad serve (log: /tmp/home/serve.log)");
  });

  test("--theme goes to the terminal app", async () => {
    const output = capture();
    const seen: TuiCommand[] = [];
    for (const argv of [["tui", "--theme", "terminal"], ["tui", "--theme=terminal"]]) {
      seen.length = 0;
      await main(argv, {
        home: "/tmp/operad-tui-home",
        io: output.io,
        isTTY: true,
        tui: async (command) => {
          seen.push(command);
          return 0;
        },
      });
      expect(seen[0]?.theme).toBe("terminal");
    }
  });
});

describe("operad with no command", () => {
  test("creates the home and opens the default bot's new chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "operad-bare-"));
    roots.push(root);
    const home = join(root, "home");
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    const previous = process.env.PATH;
    process.env.PATH = empty;
    const output = capture();
    const seen: TuiCommand[] = [];
    try {
      expect(
        await main([], {
          home,
          io: output.io,
          isTTY: true,
          pluginInstall: fakePiInstall(),
          tui: async (command) => {
            seen.push(command);
            return 0;
          },
        }),
      ).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
    expect(output.text()).not.toContain("usage: operad");
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins: Record<string, { enabled: boolean }>;
    };
    expect(config.plugins.chat?.enabled).toBe(true);
    expect(config.plugins.bot?.enabled).toBe(true);
    expect(config.plugins.pi?.enabled).toBe(true);
    expect(output.text()).toContain("no agent found on PATH: installing operad's own pi");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.home).toBe(home);
    expect(seen[0]?.startChat).toBe("bot:default");
    expect(seen[0]?.noStart).toBeUndefined();
  });

  test("help still prints the usage and creates no home", async () => {
    const root = mkdtempSync(join(tmpdir(), "operad-help-"));
    roots.push(root);
    const home = join(root, "home");
    const output = capture();
    expect(await main(["help"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("usage: operad");
    expect(() => readFileSync(join(home, "config.json"))).toThrow();
  });
});
