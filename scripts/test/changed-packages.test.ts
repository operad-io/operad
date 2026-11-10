import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedPaths, selectPackages } from "../changed-packages.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/**
 * A workspace: `core` is loaded by `lib`'s code, `app`'s code loads `lib`,
 * `probe`'s tests (not its code) load `core`, `leaf` loads nothing.
 */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "changed-packages-"));
  roots.push(root);
  for (const name of ["core", "lib", "app", "probe", "leaf"]) {
    write(root, `packages/${name}/package.json`, JSON.stringify({ name: `@operad-io/${name}` }));
  }
  write(root, "packages/core/src/index.ts", "export const core = 1;\n");
  write(root, "packages/lib/src/index.ts", 'import { core } from "@operad-io/core";\nexport const lib = core;\n');
  write(root, "packages/app/src/main.ts", 'import { lib } from "../../lib/src/index.ts";\nconsole.log(lib);\n');
  write(root, "packages/probe/src/index.ts", "export const probe = 1;\n");
  write(
    root,
    "packages/probe/test/probe.test.ts",
    'const core = new URL("../../core/src/index.ts", import.meta.url);\n',
  );
  write(root, "packages/leaf/src/index.ts", '// "@operad-io/core" in a comment is not an import\nexport {};\n');
  return root;
}

function packages(root: string, changed: readonly string[]): readonly string[] | "all" {
  const selection = selectPackages(root, changed);
  return selection.kind === "all" ? "all" : selection.packages;
}

describe("selectPackages", () => {
  test("a change in a package nothing loads picks only that package", () => {
    expect(packages(workspace(), ["packages/leaf/src/index.ts"])).toEqual(["leaf"]);
  });

  test("code that loads changed code is picked transitively", () => {
    expect(packages(workspace(), ["packages/core/src/index.ts"])).toEqual(["app", "core", "lib", "probe"]);
  });

  test("a package whose tests load changed code is picked, and the pick goes no further", () => {
    const root = workspace();
    // app's code loads probe; probe is picked only for its tests, so app is not.
    write(root, "packages/app/src/extra.ts", 'import { probe } from "@operad-io/probe";\nexport { probe };\n');
    expect(packages(root, ["packages/core/src/x.ts"])).toEqual(["app", "core", "lib", "probe"]);
    expect(packages(root, ["packages/leaf/src/index.ts"])).toEqual(["leaf"]);
    expect(packages(root, ["packages/probe/src/index.ts"])).toEqual(["app", "probe"]);
  });

  test("a change outside packages/ picks every package", () => {
    const root = workspace();
    expect(packages(root, ["bun.lock"])).toBe("all");
    expect(packages(root, ["docs/manual.md", "packages/leaf/src/index.ts"])).toBe("all");
    expect(packages(root, ["packages/gone/src/index.ts"])).toBe("all");
  });

  test("no change picks nothing", () => {
    expect(packages(workspace(), [])).toEqual([]);
  });
});

describe("changedPaths", () => {
  function git(root: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  test("lists committed, unstaged and untracked changes since the base", () => {
    const root = workspace();
    git(root, "init", "-q", "-b", "main");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    write(root, "packages/leaf/src/index.ts", "export const changed = 1;\n");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "leaf");
    write(root, "packages/core/src/index.ts", "export const core = 2;\n");
    write(root, "packages/probe/src/new.ts", "export {};\n");
    expect(changedPaths(root, base)).toEqual([
      "packages/core/src/index.ts",
      "packages/leaf/src/index.ts",
      "packages/probe/src/new.ts",
    ]);
  });
});
