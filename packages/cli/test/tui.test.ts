import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTui, main, type CliIo, type TuiCommand, type TuiRunner } from "../src/main.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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
      ["tui", "--url", "http://127.0.0.1:7480", "--token", "a-token"],
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
    expect(seen?.url).toBe("http://127.0.0.1:7480");
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
    let seen: TuiCommand | undefined;
    for (const argv of [["tui", "--theme", "terminal"], ["tui", "--theme=terminal"]]) {
      seen = undefined;
      await main(argv, {
        home: "/tmp/operad-tui-home",
        io: output.io,
        isTTY: true,
        tui: async (command) => {
          seen = command;
          return 0;
        },
      });
      expect(seen?.theme).toBe("terminal");
    }
  });
});
