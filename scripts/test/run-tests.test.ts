import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A repository of its own: the real scripts and one package `a` with a slow and a fast test. */
function repository(failing = false): { root: string; times: string } {
  const root = mkdtempSync(join(tmpdir(), "run-tests-"));
  roots.push(root);
  for (const file of ["run-tests.sh", "slowest-tests.ts"]) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(join(import.meta.dir, "..", file), join(root, "scripts", file));
  }
  write(root, "packages/a/package.json", JSON.stringify({ name: "@operad-io/a" }));
  write(
    root,
    "packages/a/test/a.test.ts",
    `import { expect, test } from "bun:test";
test("takes a while", async () => { await new Promise((r) => setTimeout(r, 120)); });
test("is quick", () => { expect(1).toBe(${failing ? 2 : 1}); });
`,
  );
  write(root, "scripts/own.test.ts", 'import { test } from "bun:test";\ntest("scripts own", () => {});\n');
  return { root, times: join(root, "times") };
}

function run(root: string, times: string, args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(["bash", "scripts/run-tests.sh", ...args], {
    cwd: root,
    env: { ...process.env, OPERAD_TEST_TIMES: times },
    stdin: "ignore",
  });
  return { code: result.exitCode, out: `${result.stdout}${result.stderr}` };
}

describe("run-tests.sh", () => {
  test("a run ends with the slowest tests and a full run appends one line to the times file", () => {
    const { root, times } = repository();
    const { code, out } = run(root, times, []);
    expect(code).toBe(0);
    const tail = out.slice(out.lastIndexOf("Slowest tests"));
    expect(tail).toMatch(/Slowest tests \(seconds, file, test\):\n\s+0\.\d+s {2}\S*a\.test\.ts {2}takes a while\n/);
    expect(tail.indexOf("takes a while")).toBeLessThan(tail.indexOf("is quick"));
    const lines = readFileSync(times, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^date=\d{4}-\d\d-\d\dT[\d:]+Z commit=\S+ tests=3 together=\d+ total=\d+ parallel=2 result=pass$/,
    );
  });

  test("a run of named packages lists the slowest tests and keeps no line", () => {
    const { root, times } = repository();
    const { code, out } = run(root, times, ["a"]);
    expect(code).toBe(0);
    expect(out).toContain("Slowest tests");
    expect(Bun.file(times).size).toBe(0);
  });

  test("a failing test fails the run, which still lists the slowest and records the failure", () => {
    const { root, times } = repository(true);
    const { code, out } = run(root, times, []);
    expect(code).not.toBe(0);
    expect(out).toContain("Slowest tests");
    expect(readFileSync(times, "utf8")).toContain("result=fail");
  });
});
