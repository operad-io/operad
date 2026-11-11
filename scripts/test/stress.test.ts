import { killProcessGroup } from "@operad-io/engine/platform";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAll, root, runStress, spawnStress } from "./stress-group.ts";

const flaky = join(import.meta.dir, "flaky.fixture.ts");
const steady = join(import.meta.dir, "steady.fixture.ts");
const leak = join(import.meta.dir, "leak.fixture.ts");

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
    const { out, code } = await runStress(["--runs", "9", flaky], { STRESS_COUNTER: counter });
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
    const { out, code } = await runStress(["--runs", "4", steady]);
    expect(code).toBe(0);
    expect(out).toContain("runs: 4\n");
    expect(out).toContain("passes: 4\n");
    expect(out).toContain("failures: 0\n");
    expect(out).not.toContain("failing tests");
  });

  test("-t limits the run to matching tests", async () => {
    const { out, code } = await runStress(["--runs", "3", "-t", "steady", steady]);
    expect(code).toBe(0);
    expect(out).toContain("passes: 3\n");
  });

  test("a pattern that matches nothing is a failure, not a pass", async () => {
    const { out, code } = await runStress(["--runs", "3", "-t", "no such test", steady]);
    expect(out).toContain("runs: 0\n");
    expect(code).toBe(1);
  });

  test("a missing test file is a failure, not a pass", async () => {
    const { code } = await runStress(["--runs", "2", join(scratch(), "missing.test.ts")]);
    expect(code).toBe(1);
  });

  test("--load starts busy helpers and none is left after exit", async () => {
    const pidfile = join(scratch(), "pids");
    const { code } = await runStress(["--runs", "2", "--load", "2", steady], { STRESS_PIDFILE: pidfile });
    expect(code).toBe(0);
    const pids = readFileSync(pidfile, "utf8").split("\n").filter(Boolean).map(Number);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });

  test("--load never starts more helpers than there are CPUs", async () => {
    const pidfile = join(scratch(), "pids");
    await runStress(["--runs", "1", "--load", "100000", steady], { STRESS_PIDFILE: pidfile, STRESS_CPUS: "2" });
    const pids = readFileSync(pidfile, "utf8").split("\n").filter(Boolean);
    expect(pids.length).toBe(2);
  });

  test("STRESS_CPUS=0 is refused instead of starting no helper", async () => {
    const pidfile = join(scratch(), "pids");
    const { code, err } = await runStress(["--runs", "1", "--load", "2", steady], {
      STRESS_PIDFILE: pidfile,
      STRESS_CPUS: "0",
    });
    expect(code).toBe(2);
    expect(err).toContain("STRESS_CPUS wants a positive number");
    expect(existsSync(pidfile)).toBe(false);
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
    const { out, code } = await runStress(["--runs", "1", "--load", "1", probe], { STRESS_PIDFILE: pidfile });
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

  test("SIGKILL of the script stops the test runner it started", async () => {
    const dir = scratch();
    const pidfile = join(dir, "pids");
    const started = join(dir, "started");
    const release = join(dir, "release");
    const blocker = join(dir, "blocker.fixture.ts");
    writeFileSync(
      blocker,
      `import { test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
test("blocker", async () => {
  writeFileSync(${JSON.stringify(started)}, String(process.pid));
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
}, 60000);
`,
    );
    const run = spawnStress(["--runs", "100000", "--load", "2", blocker], {
      STRESS_PIDFILE: pidfile,
      STRESS_CPUS: "2",
    });
    try {
      await waitForPids(pidfile, 2);
      const testPid = await waitForNumber(started);
      process.kill(run.pid, "SIGKILL");
      await run.child.exited;
      await expectGone([testPid]);
    } finally {
      run.kill();
    }
  }, 60000);

  describe("the machine-wide lock", () => {
    /** A test file that records its pid in `started`, then waits for `release` to exist. */
    function blocker(dir: string): { file: string; started: string; release: string } {
      const started = join(dir, "started");
      const release = join(dir, "release");
      const file = join(dir, "blocker.fixture.ts");
      writeFileSync(
        file,
        `import { test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
test("blocker", async () => {
  writeFileSync(${JSON.stringify(started)}, String(process.pid));
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
}, 60000);
`,
      );
      return { file, started, release };
    }

    async function until(what: string, ready: () => boolean): Promise<void> {
      const deadline = Date.now() + 20000;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(5);
      }
    }

    async function readUntil(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<string> {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of stream) {
        text += decoder.decode(chunk, { stream: true });
        if (pattern.test(text)) return text;
      }
      throw new Error(`the stream ended before ${pattern}`);
    }

    test("a second run waits while the first holds the lock, and starts when it ends", async () => {
      const dir = scratch();
      const lock = join(dir, "lock");
      const b = blocker(dir);
      const first = spawnStress(["--runs", "1", b.file], { STRESS_LOCK: lock });
      await until("the first run's test to start", () => existsSync(b.started));
      expect(readFileSync(join(lock, "pid"), "utf8").trim()).toBe(String(first.pid));
      const pidfile = join(dir, "second-pids");
      const second = spawnStress(["--runs", "2", "--load", "1", steady], { STRESS_LOCK: lock, STRESS_PIDFILE: pidfile });
      const err = await readUntil(second.child.stderr as ReadableStream<Uint8Array>, /waiting for the stress run/);
      expect(err).toContain(`pid ${first.pid}`);
      expect(err).toContain("stress.sh --runs 1");
      expect(err).toContain(root);
      expect(err).toMatch(/held for \d+m \d+s/);
      // It has not started a helper or a test while it waits.
      expect(existsSync(pidfile)).toBe(false);
      writeFileSync(b.release, "");
      const [out, code] = await Promise.all([new Response(second.child.stdout).text(), second.child.exited]);
      expect(code).toBe(0);
      expect(out).toContain("passes: 2\n");
      expect(await first.child.exited).toBe(0);
      expect(existsSync(lock)).toBe(false);
    }, 60000);

    test("two runs with different TMPDIR values still share the lock", async () => {
      const dir = scratch();
      const home = join(dir, "home");
      const tmpA = join(dir, "tmp-a");
      const tmpB = join(dir, "tmp-b");
      mkdirSync(home, { recursive: true });
      mkdirSync(tmpA, { recursive: true });
      mkdirSync(tmpB, { recursive: true });
      const b = blocker(dir);
      const first = spawnStress(["--runs", "1", b.file], {
        HOME: home,
        TMPDIR: tmpA,
        STRESS_LOCK: "",
      });
      await until("the first run's test to start", () => existsSync(b.started));
      const second = spawnStress(["--runs", "1", steady], {
        HOME: home,
        TMPDIR: tmpB,
        STRESS_LOCK: "",
      });
      const err = await readUntil(second.child.stderr as ReadableStream<Uint8Array>, /waiting for the stress run/);
      expect(err).toContain(`pid ${first.pid}`);
      writeFileSync(b.release, "");
      const [secondCode, firstCode] = await Promise.all([second.child.exited, first.child.exited]);
      expect(secondCode).toBe(0);
      expect(firstCode).toBe(0);
      expect(existsSync(join(home, ".operad-stress.lock"))).toBe(false);
    }, 60000);

    test("a lock held by a dead pid is taken over", async () => {
      const dir = scratch();
      const lock = join(dir, "lock");
      const dead = Bun.spawn(["true"], { stdout: "ignore" });
      await dead.exited;
      mkdirSync(lock);
      writeFileSync(join(lock, "cmd"), "bash scripts/stress.sh gone");
      writeFileSync(join(lock, "cwd"), dir);
      writeFileSync(join(lock, "since"), "0");
      writeFileSync(join(lock, "pid"), `${dead.pid}\n`);
      const { out, err, code } = await runStress(["--runs", "2", steady], { STRESS_LOCK: lock });
      expect(code).toBe(0);
      expect(out).toContain("passes: 2\n");
      expect(err.match(/taking over/g)?.length).toBe(1);
      expect(err).toContain(`pid ${dead.pid}`);
      expect(existsSync(lock)).toBe(false);
    });

    test("a lock whose pid now belongs to another program is taken over", async () => {
      const dir = scratch();
      const lock = join(dir, "lock");
      const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      try {
        mkdirSync(lock);
        writeFileSync(join(lock, "cmd"), "bash scripts/stress.sh gone");
        writeFileSync(join(lock, "cwd"), dir);
        writeFileSync(join(lock, "since"), "0");
        writeFileSync(join(lock, "pid"), `${other.pid}\n`);
        const { out, err, code } = await runStress(["--runs", "2", steady], { STRESS_LOCK: lock });
        expect(code).toBe(0);
        expect(out).toContain("passes: 2\n");
        expect(err).toContain(`pid ${other.pid}`);
        expect(err.match(/taking over/g)?.length).toBe(1);
        expect(existsSync(lock)).toBe(false);
      } finally {
        other.kill("SIGKILL");
        await other.exited;
      }
    });

    test("--no-lock runs while another run holds the lock", async () => {
      const dir = scratch();
      const lock = join(dir, "lock");
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), `${process.pid}\n`);
      const { code, err } = await runStress(["--runs", "1", "--no-lock", steady], { STRESS_LOCK: lock });
      expect(code).toBe(0);
      expect(err).not.toContain("waiting");
      expect(readFileSync(join(lock, "pid"), "utf8").trim()).toBe(String(process.pid));
    });

    test("SIGTERM leaves no helper or test process and releases the lock", async () => {
      const dir = scratch();
      const lock = join(dir, "lock");
      const pidfile = join(dir, "pids");
      const b = blocker(dir);
      const run = spawnStress(["--runs", "1", "--load", "2", b.file], {
        STRESS_LOCK: lock,
        STRESS_PIDFILE: pidfile,
        STRESS_CPUS: "2",
      });
      try {
        await until("the test to start", () => existsSync(b.started) && readFileSync(b.started, "utf8") !== "");
        const pids = [...readPids(pidfile), Number(readFileSync(b.started, "utf8"))];
        expect(pids.length).toBe(3);
        expect(existsSync(lock)).toBe(true);
        process.kill(run.pid, "SIGTERM");
        expect(await run.child.exited).toBe(143);
        await expectGone([run.pid, ...pids]);
        expect(existsSync(lock)).toBe(false);
      } finally {
        run.kill();
      }
    }, 60000);

    test("a run killed while it waits releases nothing and leaves the holder's lock", async () => {
      const dir = scratch();
      const lock = join(dir, "lock");
      const b = blocker(dir);
      const first = spawnStress(["--runs", "1", b.file], { STRESS_LOCK: lock });
      await until("the first run's test to start", () => existsSync(b.started));
      const second = spawnStress(["--runs", "1", steady], { STRESS_LOCK: lock });
      await readUntil(second.child.stderr as ReadableStream<Uint8Array>, /waiting for the stress run/);
      process.kill(second.pid, "SIGTERM");
      expect(await second.child.exited).toBe(143);
      expect(readFileSync(join(lock, "pid"), "utf8").trim()).toBe(String(first.pid));
      writeFileSync(b.release, "");
      expect(await first.child.exited).toBe(0);
    }, 60000);
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
        // The SIGTERM handler stops the group at once. Without it the script's
        // starter watcher is the only stop, which this bound does not allow.
        await expectGone(pids, signal === "SIGTERM" ? 1500 : 5000);
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

/** Reads a pid a fixture wrote, once the file holds one. */
async function waitForNumber(path: string): Promise<number> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const value = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(value) && value > 1) return value;
    } catch {
      // Not there yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for a pid in ${path}`);
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
async function expectGone(pids: number[], timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(10);
  expect(pids.filter(alive)).toEqual([]);
}
