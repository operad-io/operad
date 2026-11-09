import { killProcessGroup } from "@operad-io/engine/platform";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAll, root, runStress, spawnStress } from "./stress-group.ts";

const flaky = join(import.meta.dir, "flaky.fixture.ts");
const steady = join(import.meta.dir, "steady.fixture.ts");
const leak = join(import.meta.dir, "leak.fixture.ts");

const stress = runStress;

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
  afterEach(killAll);

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
    await stress(["--runs", "1", "--load", "100000", steady], { STRESS_PIDFILE: pidfile, STRESS_CPUS: "2" });
    const pids = readFileSync(pidfile, "utf8").split("\n").filter(Boolean);
    expect(pids.length).toBe(2);
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

  test("SIGKILL of the script leaves no helper alive", async () => {
    const pidfile = join(scratch(), "pids");
    const run = spawnStress(["--runs", "100000", "--load", "2", steady], { STRESS_PIDFILE: pidfile, STRESS_CPUS: "2" });
    try {
      const helpers = await waitForPids(pidfile, 2);
      process.kill(run.pid, "SIGKILL"); // the script only, not the group: no trap runs
      await run.child.exited;
      await expectGone(helpers);
    } finally {
      run.kill();
    }
  });

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(`${signal} to the test runner mid-test leaves no stress.sh or helper`, async () => {
      const pidfile = join(scratch(), "pids");
      const runner = Bun.spawn(["bun", "test", leak], {
        cwd: root,
        env: { ...process.env, LEAK_PIDFILE: pidfile },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      let pids: number[] = [];
      try {
        pids = await readReady(runner.stdout);
        expect(pids.length).toBe(3);
        runner.kill(signal);
        await runner.exited;
        await expectGone(pids);
      } finally {
        runner.kill("SIGKILL");
        // The stress group is not ours to the outer test; pids[0] is its group.
        if (pids[0] !== undefined) killProcessGroup(pids[0], "SIGKILL");
      }
    }, 60000);
  }
});

function readPids(pidfile: string): number[] {
  try {
    return readFileSync(pidfile, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return []; // the script has not created it yet
  }
}

async function waitForPids(pidfile: string, count: number): Promise<number[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const pids = readPids(pidfile);
    if (pids.length >= count) return pids;
    if (Date.now() > deadline) throw new Error("the helpers did not start");
    await Bun.sleep(5);
  }
}

/** Reads the runner's stdout until the fixture prints `ready <pids...>`. */
async function readReady(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const m = /^ready (.+)$/m.exec(text);
    if (m) return (m[1] ?? "").split(" ").map(Number);
  }
  throw new Error("the runner ended before it was ready");
}

/** A pid that is not a child has no exit event; wait for it with a bound. */
async function expectGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(10);
  expect(pids.filter(alive)).toEqual([]);
}
