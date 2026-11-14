import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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

  describe("with a jar whose sha256 matches (a copy of the script pinned to a fake jar)", () => {
    const jar = "a jar";
    const sha = createHash("sha256").update(jar).digest("hex");

    /** A root holding a copy of tla.sh pinned to `jar`, a model `pool`, a fake curl and a fake java that records its arguments. */
    function pinned(): { env: Record<string, string>; cache: string; run: (args: string[], extra?: Record<string, string>) => { code: number; err: string }; calls: () => string; fetches: () => string } {
      const { env, cache } = sandbox(jar);
      const root = mkdtempSync(join(tmpdir(), "tla-pinned-"));
      roots.push(root);
      mkdirSync(join(root, "scripts"));
      const text = readFileSync(script, "utf8").replace(/^TLA_SHA256=".*"$/m, `TLA_SHA256="${sha}"`);
      writeFileSync(join(root, "scripts", "tla.sh"), text);
      const model = join(root, "tla", "pool");
      mkdirSync(model, { recursive: true });
      for (const name of ["MC", "TraceMC"]) {
        writeFileSync(join(model, `${name}.tla`), "");
        writeFileSync(join(model, `${name}.cfg`), "");
      }
      const bin = join(root, "bin");
      mkdirSync(bin);
      const log = join(root, "java.log");
      const fetchLog = join(root, "curl.log");
      writeFileSync(join(bin, "java"), `#!/bin/sh\necho "$@" >> '${log}'\n`);
      chmodSync(join(bin, "java"), 0o755);
      // the sandbox's curl, which also counts its calls
      const curl = readFileSync(join(env.PATH?.split(delimiter)[0] ?? "", "curl"), "utf8");
      writeFileSync(join(bin, "curl"), `${curl.replace("\n", `\necho x >> '${fetchLog}'\n`)}`);
      chmodSync(join(bin, "curl"), 0o755);
      const full = { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ""}` };
      const runIt = (args: string[], extra: Record<string, string> = {}) => {
        const result = Bun.spawnSync(["bash", join(root, "scripts", "tla.sh"), ...args], { env: { ...full, ...extra }, stdout: "pipe", stderr: "pipe" });
        return { code: result.exitCode ?? -1, err: result.stderr.toString() };
      };
      return {
        env: full,
        cache,
        run: runIt,
        calls: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
        fetches: () => (existsSync(fetchLog) ? readFileSync(fetchLog, "utf8") : ""),
      };
    }

    test("a matching download is kept, and the next run uses it without fetching", () => {
      const p = pinned();
      expect(p.run(["pool"]).code).toBe(0);
      expect(readdirSync(p.cache).filter((name) => name.endsWith(".jar"))).toEqual([`tla2tools-${sha}.jar`]);
      expect(p.fetches().trim().split("\n")).toHaveLength(1);
      expect(p.run(["pool"]).code).toBe(0);
      expect(p.fetches().trim().split("\n")).toHaveLength(1);
      expect(p.calls().trim().split("\n")).toHaveLength(2);
    });

    test("TLA_MAIN picks <name>.tla and <name>.cfg, and TLA_LIB goes to TLC as its library", () => {
      const p = pinned();
      const lib = mkdtempSync(join(tmpdir(), "tla-lib-"));
      roots.push(lib);
      expect(p.run(["pool", "-workers", "1"], { TLA_MAIN: "TraceMC", TLA_LIB: lib }).code).toBe(0);
      const call = p.calls();
      expect(call).toContain("-config TraceMC.cfg");
      expect(call).toContain("TraceMC.tla");
      expect(call).toContain("-workers 1");
      expect(call).toContain(`-DTLA-Library=`);
      expect(p.run(["pool"]).code).toBe(0);
      expect(p.calls()).toContain("-config MC.cfg");
    });
  });
});
