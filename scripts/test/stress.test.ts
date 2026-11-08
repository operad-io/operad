import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const script = join(root, "scripts", "stress.sh");
const flaky = join(import.meta.dir, "flaky.fixture.ts");
const steady = join(import.meta.dir, "steady.fixture.ts");

async function stress(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["bash", script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { out, code };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "stress-test-"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("scripts/stress.sh", () => {
  test("a fixture failing every third run reports the counts and exits 1", async () => {
    const counter = join(scratch(), "counter");
    writeFileSync(counter, "0");
    const { out, code } = await stress(["--runs", "9", flaky], { STRESS_COUNTER: counter });
    expect(code).toBe(1);
    expect(out).toContain("runs: 9\n");
    expect(out).toContain("passes: 6\n");
    expect(out).toContain("failures: 3\n");
    expect(out).toContain("3 x flaky fixture");
    const log = /^log: (.+)$/m.exec(out)?.[1];
    expect(log).toBeDefined();
    expect(readFileSync(log ?? "", "utf8")).toContain("(fail) flaky fixture");
  });

  test("a passing fixture exits 0", async () => {
    const { out, code } = await stress(["--runs", "4", steady]);
    expect(code).toBe(0);
    expect(out).toContain("runs: 4\n");
    expect(out).toContain("passes: 4\n");
    expect(out).toContain("failures: 0\n");
    expect(out).not.toContain("failing tests");
  });

  test("-t limits the run to matching tests", async () => {
    const { out, code } = await stress(["--runs", "3", "-t", "steady", steady]);
    expect(code).toBe(0);
    expect(out).toContain("passes: 3\n");
  });

  test("a pattern that matches nothing is a failure, not a pass", async () => {
    const { out, code } = await stress(["--runs", "3", "-t", "no such test", steady]);
    expect(out).toContain("runs: 0\n");
    expect(code).toBe(1);
  });

  test("a missing test file is a failure, not a pass", async () => {
    const { code } = await stress(["--runs", "2", join(scratch(), "missing.test.ts")]);
    expect(code).toBe(1);
  });

  test("--load starts busy helpers and none is left after exit", async () => {
    const pidfile = join(scratch(), "pids");
    const { code } = await stress(["--runs", "2", "--load", "2", steady], { STRESS_PIDFILE: pidfile });
    expect(code).toBe(0);
    const pids = readFileSync(pidfile, "utf8").split("\n").filter(Boolean).map(Number);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });

  test("--load never starts more helpers than there are CPUs", async () => {
    const pidfile = join(scratch(), "pids");
    await stress(["--runs", "1", "--load", "100000", steady], { STRESS_PIDFILE: pidfile });
    const pids = readFileSync(pidfile, "utf8").split("\n").filter(Boolean);
    expect(pids.length).toBeGreaterThan(0);
    expect(pids.length).toBeLessThanOrEqual(navigator.hardwareConcurrency);
  });

  test("the load helpers are alive while the tests run", async () => {
    const dir = scratch();
    const pidfile = join(dir, "pids");
    const probe = join(dir, "probe.fixture.ts");
    writeFileSync(
      probe,
      `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("helpers are running", () => {
  const pids = readFileSync(${JSON.stringify(pidfile)}, "utf8").split("\\n").filter(Boolean).map(Number);
  expect(pids.length).toBe(1);
  for (const pid of pids) process.kill(pid, 0);
});
`,
    );
    const { out, code } = await stress(["--runs", "1", "--load", "1", probe], { STRESS_PIDFILE: pidfile });
    expect(out).toContain("failures: 0\n");
    expect(code).toBe(0);
  });
});
