import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

// A worktree of the checked-in files with a complete install (every link the
// manifests ask for), then the access-match links removed: a stale install.
function worktree(complete = false): string {
  const dir = mkdtempSync(join(tmpdir(), "install-test-"));
  cpSync(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
  cpSync(join(root, "bunfig.toml"), join(dir, "bunfig.toml"));
  cpSync(join(root, "package.json"), join(dir, "package.json"));
  writeFileSync(join(dir, "trivial.test.ts"), 'import { test } from "bun:test";\ntest("runs", () => {});\n');
  const manifests = [dir];
  for (const name of readdirSync(join(root, "packages"))) {
    cpSync(join(root, "packages", name, "package.json"), join(dir, "packages", name, "package.json"));
    cpSync(join(root, "packages", name, "bunfig.toml"), join(dir, "packages", name, "bunfig.toml"));
    manifests.push(join(dir, "packages", name));
  }
  for (const m of manifests) {
    const json = JSON.parse(readFileSync(join(m, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries({ ...json.devDependencies, ...json.dependencies })) {
      if (!range.startsWith("workspace:") || (!complete && name === "@operad-io/access-match")) continue;
      mkdirSync(join(m, "node_modules", "@operad-io"), { recursive: true });
      symlinkSync(join(root, "packages", name.replace("@operad-io/", "")), join(m, "node_modules", name));
    }
  }
  return dir;
}

describe("scripts/check-install.ts", () => {
  test("the repository's own install is current", async () => {
    const { code, err } = await run(["bun", "scripts/check-install.ts"], root);
    expect(err).toBe("");
    expect(code).toBe(0);
  });

  test("the same worktree with every link passes, and bun test runs", async () => {
    const dir = worktree(true);
    try {
      expect((await run(["bun", "scripts/check-install.ts", dir], root)).code).toBe(0);
      const { code, err } = await run(["bun", "test", "./trivial.test.ts"], dir);
      expect(err).not.toContain("run bun install");
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a worktree with the access-match link removed fails fast with the bun install line", async () => {
    const dir = worktree();
    try {
      const { code, err } = await run(["bun", "scripts/check-install.ts", dir], root);
      expect(code).toBe(1);
      expect(err.trim().split("\n")).toHaveLength(1);
      expect(err).toContain("packages/harness-radian/node_modules/@operad-io/access-match");
      expect(err).toContain("run bun install");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bun test in such a worktree stops on the same line before running a test", async () => {
    const dir = worktree();
    try {
      const { code, err } = await run(["bun", "test", "./trivial.test.ts"], dir);
      expect(code).not.toBe(0);
      expect(err).toContain("run bun install");
      expect(err).not.toContain("Cannot find module");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bun test run from a package directory stops on the same line", async () => {
    const dir = worktree();
    try {
      writeFileSync(join(dir, "packages", "dev", "trivial.test.ts"), 'import { test } from "bun:test";\ntest("runs", () => {});\n');
      const { code, err } = await run(["bun", "test", "./trivial.test.ts"], join(dir, "packages", "dev"));
      expect(code).not.toBe(0);
      expect(err).toContain("run bun install");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scripts/stress.sh refuses to start on a stale install", async () => {
    const dir = worktree();
    try {
      const { code, err, out } = await run(["bash", "scripts/stress.sh", "./trivial.test.ts"], dir);
      expect(code).toBe(2);
      expect(err).toContain("run bun install");
      expect(out).not.toContain("runs:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
