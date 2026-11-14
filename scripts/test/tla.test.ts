import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const script = join(import.meta.dir, "..", "tla.sh");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fake `curl` that writes `body` to the -o file, an empty cache and a PATH with it. */
function sandbox(body: string): { env: Record<string, string>; cache: string } {
  const root = mkdtempSync(join(tmpdir(), "tla-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; fi; shift; done\nprintf '%s' '${body}' > "$out"\n`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
  env.XDG_CACHE_HOME = join(root, "cache");
  return { env, cache: join(root, "cache", "operad", "tla") };
}

function run(args: string[], env: Record<string, string>): { code: number; err: string } {
  const result = Bun.spawnSync(["bash", script, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? -1, err: result.stderr.toString() };
}

describe("scripts/tla.sh", () => {
  test("a download whose sha256 differs is refused and not kept", () => {
    const { env, cache } = sandbox("not the jar");
    const result = run(["pool"], env);
    expect(result.code).toBe(1);
    expect(result.err).toContain("sha256 mismatch");
    expect(result.err).toContain("refusing to run");
    const kept = existsSync(cache) ? readdirSync(cache).filter((name) => name.endsWith(".jar")) : [];
    expect(kept).toEqual([]);
  });

  test("an unknown model is a usage error that fetches nothing", () => {
    const { env, cache } = sandbox("x");
    const result = run(["nope"], env);
    expect(result.code).toBe(2);
    expect(result.err).toContain("no model 'nope'");
    expect(existsSync(cache)).toBe(false);
  });

  test("no argument lists the models", () => {
    const { env } = sandbox("x");
    const result = run([], env);
    expect(result.code).toBe(2);
    expect(result.err).toContain("pool");
  });

  test("TLA_MAIN names the module and the config to run instead of MC", () => {
    const { env } = sandbox("x");
    const result = run(["pool"], { ...env, TLA_MAIN: "Nope" });
    expect(result.code).toBe(2);
    expect(result.err).toContain("Nope.tla and Nope.cfg");
  });
});
