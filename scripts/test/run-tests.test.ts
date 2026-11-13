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

const parallel = "3";

function run(
  root: string,
  times: string,
  args: string[],
  env: Record<string, string> = {},
): { code: number; out: string } {
  // The parallel counts are set here, not taken from the caller: a check runs with its own.
  const inherited = { ...process.env };
  delete inherited.OPERAD_TEST_PARALLEL;
  delete inherited.OPERAD_TEST_HEAVY_PARALLEL;
  delete inherited.OPERAD_TEST_OVERLAP;
  const result = Bun.spawnSync(["bash", "scripts/run-tests.sh", ...args], {
    cwd: root,
    env: {
      ...inherited,
      OPERAD_TEST_PARALLEL: parallel,
      OPERAD_TEST_HEAVY_PARALLEL: "2",
      OPERAD_TEST_OVERLAP: "0",
      OPERAD_TEST_TIMES: times,
      ...env,
    },
    stdin: "ignore",
  });
  return { code: result.exitCode, out: `${result.stdout}${result.stderr}` };
}

/** Adds a heavy test under `test/heavy/` of package `a`. */
function heavyTest(root: string, failing = false): void {
  write(
    root,
    "packages/a/test/heavy/heavy.test.ts",
    `import { expect, test } from "bun:test";
test("heavy runs", () => {
  expect(1).toBe(${failing ? 2 : 1});
});
`,
  );
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
      new RegExp(String.raw`^date=\d{4}-\d\d-\d\dT[\d:]+Z commit=\S+ tests=3 together=\d+ total=\d+ parallel=${parallel} result=pass$`),
    );
  });

  test("a silent step prints no heartbeat that would hide a stall", () => {
    const { root, times } = repository();
    write(
      root,
      "packages/a/test/slow.test.ts",
      `import { test } from "bun:test";
test("shows nothing until it ends", async () => { await new Promise((r) => setTimeout(r, 1500)); });
`,
    );
    const { code, out } = run(root, times, [], { OPERAD_TEST_HEARTBEAT_SECS: "1" });
    expect(code).toBe(0);
    expect(out).not.toContain("run-tests: still running");
  });

  test("a step whose output grows still prints a heartbeat", () => {
    const { root, times } = repository();
    write(
      root,
      "packages/a/test/heavy/heavy.test.ts",
      `import { test } from "bun:test";
test("keeps the heavy step open past a heartbeat", async () => { await new Promise((r) => setTimeout(r, 1500)); });
`,
    );
    const { code, out } = run(root, times, [], {
      OPERAD_TEST_HEARTBEAT_SECS: "1",
      OPERAD_TEST_HEAVY_PARALLEL: "1",
      OPERAD_TEST_OVERLAP: "1",
    });
    expect(code).toBe(0);
    expect(out).toContain("run-tests: still running");
  });

  test("a run of named packages lists the slowest tests and keeps no line", () => {
    const { root, times } = repository();
    const { code, out } = run(root, times, ["a"]);
    expect(code).toBe(0);
    expect(out).toContain("Slowest tests");
    expect(Bun.file(times).size).toBe(0);
  });

  test("a full run runs heavy tests in a step of their own, with their own parallelism", () => {
    const { root, times } = repository();
    heavyTest(root);
    const { code, out } = run(root, times, []);
    expect(code).toBe(0);
    expect(out).toContain("heavy runs");
    expect(readFileSync(times, "utf8").trim()).toMatch(
      new RegExp(
        String.raw`^date=\d{4}-\d\d-\d\dT[\d:]+Z commit=\S+ tests=4 together=\d+ heavy=\d+ total=\d+ parallel=${parallel} heavyParallel=2 result=pass$`,
      ),
    );
  });

  test("the heavy step's parallelism is its own setting", () => {
    const { root, times } = repository();
    heavyTest(root);
    const { code } = run(root, times, [], { OPERAD_TEST_HEAVY_PARALLEL: "3" });
    expect(code).toBe(0);
    expect(readFileSync(times, "utf8")).toContain(`parallel=${parallel} heavyParallel=3 result=pass`);
  });

  test("a named package runs its own heavy tests and leaves another package's alone", () => {
    const { root } = repository();
    heavyTest(root);
    write(root, "packages/b/package.json", JSON.stringify({ name: "@operad-io/b" }));
    write(
      root,
      "packages/b/test/heavy/b.test.ts",
      'import { expect, test } from "bun:test";\ntest("b is heavy and fails", () => { expect(1).toBe(2); });\n',
    );
    const { code, out } = run(root, join(root, "times"), ["a"]);
    expect(code).toBe(0);
    expect(out).toContain("heavy runs");
    expect(out).not.toContain("b is heavy and fails");
  });

  test("a failing heavy test fails the run and records the failure", () => {
    const { root, times } = repository();
    heavyTest(root, true);
    const { code, out } = run(root, times, []);
    expect(code).not.toBe(0);
    expect(out).toContain("heavy runs");
    expect(readFileSync(times, "utf8")).toContain("heavy=");
    expect(readFileSync(times, "utf8")).toContain("result=fail");
  });

  test("with overlap the heavy step runs beside the light step and is still counted, shown and recorded", () => {
    const { root, times } = repository();
    heavyTest(root);
    const { code, out } = run(root, times, [], { OPERAD_TEST_OVERLAP: "1" });
    expect(code).toBe(0);
    expect(out).toContain("heavy runs");
    expect(readFileSync(times, "utf8").trim()).toMatch(
      new RegExp(
        String.raw`tests=4 together=\d+ heavy=\d+ total=\d+ parallel=${parallel} heavyParallel=2 result=pass$`,
      ),
    );
  });

  test("with overlap a failing heavy test still fails the run", () => {
    const { root, times } = repository();
    heavyTest(root, true);
    const { code, out } = run(root, times, [], { OPERAD_TEST_OVERLAP: "1" });
    expect(code).not.toBe(0);
    expect(out).toContain("heavy runs");
    expect(readFileSync(times, "utf8")).toContain("result=fail");
  });

  test("a failing test fails the run, which still lists the slowest and records the failure", () => {
    const { root, times } = repository(true);
    const { code, out } = run(root, times, []);
    expect(code).not.toBe(0);
    expect(out).toContain("Slowest tests");
    expect(readFileSync(times, "utf8")).toContain("result=fail");
  });
});
