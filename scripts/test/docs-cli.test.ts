/**
 * Every command example in `docs/user/cli.md` whose fence is `sh runnable`
 * runs, in order, against a temporary home. The examples are the commands a
 * reader can copy; a page that changes without them passing is a broken page.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const page = join(root, "docs", "user", "cli.md");
const entry = join(root, "packages", "cli", "bin", "operad.ts");

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** The lines of every `sh runnable` fence, in page order. */
export function runnableExamples(markdown: string): string[] {
  const lines: string[] = [];
  let runnable = false;
  let fence = false;
  for (const raw of markdown.split("\n")) {
    const marker = /^\s*```\s*(.*)$/.exec(raw);
    if (marker !== null && !fence) {
      fence = true;
      runnable = /^sh\s+runnable\s*$/.test(marker[1] ?? "");
      continue;
    }
    if (/^\s*```\s*$/.test(raw) && fence) {
      fence = false;
      runnable = false;
      continue;
    }
    const line = raw.trim();
    if (!fence || !runnable || line.length === 0 || line.startsWith("#")) continue;
    lines.push(line);
  }
  return lines;
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "docs-cli-"));
  directories.push(directory);
  return directory;
}

/** A temporary `operad` command that runs this checkout's entry file. */
function operadCommand(directory: string): string {
  const bin = join(directory, "bin");
  Bun.spawnSync({ cmd: ["mkdir", "-p", bin] });
  const file = join(bin, "operad");
  writeFileSync(
    file,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`,
  );
  chmodSync(file, 0o755);
  return bin;
}

describe("the cli page examples", () => {
  test("every runnable example runs in a temporary home", async () => {
    const examples = runnableExamples(readFileSync(page, "utf8"));
    expect(examples.length).toBeGreaterThan(0);
    const directory = tempDirectory();
    const bin = operadCommand(directory);
    const home = join(directory, "home");
    Bun.spawnSync({ cmd: ["mkdir", "-p", home] });
    const env = {
      ...process.env,
      HOME: directory,
      OPERAD_HOME: home,
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    };
    for (const example of examples) {
      const child = Bun.spawn({
        cmd: ["/bin/sh", "-c", example],
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(
        status,
        `${example}\nstatus ${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ).toBe(0);
    }
  });

  test("the parser reads only a runnable fence", () => {
    const markdown = [
      "```sh",
      "operad ignored",
      "```",
      "```sh runnable",
      "operad one",
      "# a comment",
      "operad two",
      "```",
      "```sh runnable --no",
      "operad almost",
      "```",
    ].join("\n");
    expect(runnableExamples(markdown)).toEqual(["operad one", "operad two"]);
  });
});
