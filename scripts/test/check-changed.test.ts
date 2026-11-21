/**
 * check-changed.sh tests the packages a change touches and always the
 * scripts/test tests too, even when the package selection is `none`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const source = join(import.meta.dir, "..");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A repository with the real check scripts, a package and a `scripts/test` test. */
function repository(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "check-changed-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const name of ["check-changed.sh", "run-tests.sh", "changed-packages.ts", "slowest-tests.ts"]) {
    copyFileSync(join(source, name), join(root, "scripts", name));
  }
  write(join(root, "packages", "a", "package.json"), JSON.stringify({ name: "@operad-io/a" }));
  write(join(root, "packages", "a", "src", "index.ts"), "export const a = 1;\n");
  write(
    join(root, "packages", "a", "test", "a.test.ts"),
    'import { test } from "bun:test";\ntest("package probe", () => {});\n',
  );
  write(
    join(root, "scripts", "test", "probe.test.ts"),
    'import { test } from "bun:test";\ntest("scripts probe", () => {});\n',
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

/** A fake bun and bunx: install and type-check do nothing, tests run for real. */
function commands(): string {
  const directory = mkdtempSync(join(tmpdir(), "check-changed-bin-"));
  roots.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const bun = join(bin, "bun");
  writeFileSync(
    bun,
    `#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  );
  const bunx = join(bin, "bunx");
  writeFileSync(bunx, "#!/bin/sh\nexit 0\n");
  chmodSync(bun, 0o755);
  chmodSync(bunx, 0o755);
  return bin;
}

function run(root: string, base: string): { code: number; out: string } {
  const bin = commands();
  const result = spawnSync("bash", ["scripts/check-changed.sh"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      OPERAD_CHECK_BASE: base,
      OPERAD_TEST_PARALLEL: "1",
      OPERAD_TEST_HEAVY_PARALLEL: "1",
      OPERAD_TEST_OVERLAP: "0",
      OPERAD_TEST_TIMES: join(root, "times"),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
}

describe("check-changed.sh", () => {
  test("a change under packages/a/src runs the package's tests and scripts/test", () => {
    const { root, base } = repository();
    write(join(root, "packages", "a", "src", "index.ts"), "export const a = 2;\n");
    const { code, out } = run(root, base);
    expect(code).toBe(0);
    expect(out).toContain("check-changed: testing a");
    expect(out).toContain("package probe");
    expect(out).toContain("scripts probe");
  });

  test("a selection of none still runs scripts/test and no package's tests", () => {
    const { root, base } = repository();
    const { code, out } = run(root, base);
    expect(code, out).toBe(0);
    expect(out).toContain("check-changed: testing none");
    expect(out).not.toContain("package probe");
    expect(out).toContain("scripts probe");
  });
});
