import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const packages = [
  "engine",
  "harness/process",
  "mcp",
  "access-match",
  "shell",
  "chat",
  "review-grading",
  "pool",
  "dev",
  "harness/radian",
  "harness/pi",
  "harness/claude",
  "harness/codex",
  "bot",
  "tui",
  "cli",
];

/** A repository with the script and every package the script names. */
function repository(): { root: string; calls: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "publish-script-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "publish.sh"), readFileSync(new URL("../publish.sh", import.meta.url)));
  for (const directory of packages) {
    mkdirSync(join(root, "packages", directory), { recursive: true });
    writeFileSync(
      join(root, "packages", directory, "package.json"),
      JSON.stringify({ name: `@operad-io/${directory.replace("/", "-")}`, version: "0.0.1" }),
    );
  }
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(root, "calls");
  const fakeBun = join(bin, "bun");
  writeFileSync(
    fakeBun,
    `#!/bin/sh
if [ "$1" = "-e" ]; then exec "$REAL_BUN" "$@"; fi
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  "pm view")
    if [ -n "\${SKIP_NAME:-}" ] && printf '%s' "$*" | grep -q "$SKIP_NAME"; then exit 0; fi
    exit 1
    ;;
  "pm pack")
    if [ "$3" = "--dry-run" ]; then printf '%s\\n' "dry.tgz"; else printf '%s\\n' "$4/$(basename "$PWD").tgz"; fi
    ;;
  publish*) exit 0 ;;
  *) exit 3 ;;
esac
`,
  );
  chmodSync(fakeBun, 0o755);
  return { root, calls, bin };
}

function run(root: string, calls: string, bin: string, args: string[], skip = ""): { code: number; out: string } {
  const result = Bun.spawnSync({
    cmd: ["bash", "scripts/publish.sh", ...args],
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      CALLS: calls,
      REAL_BUN: process.execPath,
      SKIP_NAME: skip,
    },
    stdin: "ignore",
  });
  return { code: result.exitCode ?? 1, out: `${result.stdout}${result.stderr}` };
}

describe("publish.sh", () => {
  test("without --publish it dry-runs every package and publishes none", () => {
    const { root, calls, bin } = repository();
    const ran = run(root, calls, bin, []);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("@operad-io/engine@0.0.1");
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines.filter((line) => line === "pm pack --dry-run")).toHaveLength(packages.length);
    expect(lines.some((line) => line.startsWith("publish "))).toBe(false);
  });

  test("--publish packs and publishes in dependency order and passes --otp on", () => {
    const { root, calls, bin } = repository();
    const ran = run(root, calls, bin, ["--publish", "--otp", "123456"]);
    expect(ran.code).toBe(0);
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    const published = lines.filter((line) => line.startsWith("publish "));
    expect(published).toHaveLength(packages.length);
    expect(published[0]).toContain("/engine.tgz");
    expect(published[published.length - 1]).toContain("/cli.tgz");
    expect(published.every((line) => line.endsWith("--access public --otp 123456"))).toBe(true);
    const view = lines.filter((line) => line.startsWith("pm view "));
    expect(view).toHaveLength(packages.length);
  });

  test("--publish skips a version the registry already has", () => {
    const { root, calls, bin } = repository();
    const ran = run(root, calls, bin, ["--publish"], "@operad-io/engine@0.0.1");
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("@operad-io/engine@0.0.1 is already on the registry; skipped");
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines.some((line) => line.startsWith("publish ") && line.includes("/engine.tgz"))).toBe(false);
    expect(lines.filter((line) => line.startsWith("publish "))).toHaveLength(packages.length - 1);
  });

  test("a word it does not know is a usage error", () => {
    const { root, calls, bin } = repository();
    const ran = run(root, calls, bin, ["--publish-now"]);
    expect(ran.code).toBe(2);
    expect(ran.out).toContain("usage: publish.sh");
  });
});
