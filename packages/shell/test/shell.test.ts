import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SqlitePluginStore,
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  defineFlow,
  openLog,
  readState,
  validateFlow,
  type FlowDefinition,
  type PluginDefinition,
  type PluginStepResult,
} from "@operad-io/engine";
import shell, { createShellPlugin } from "../src/index.ts";
import {
  alive,
  cleanupTempRoots,
  manualClock,
  tempRoot,
  signalable,
  waitForFile,
  waitForGone,
  waitForPid,
} from "./support.ts";

afterAll(cleanupTempRoots);

interface Fixture {
  readonly root: string;
  readonly registry: PluginRegistry;
}

describe("shell plugin kind", () => {
  test("shell is a stage: its steps end in pass and fail, which a harness may not", () => {
    expect(shell.kind).toBe("stage");
  });
});

async function fixture(plugin: PluginDefinition = shell): Promise<Fixture> {
  const root = await tempRoot();
  return {
    root,
    registry: new PluginRegistry([plugin], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
    }),
  };
}

function dataOf(result: PluginStepResult): Record<string, unknown> {
  return (result.data ?? {}) as Record<string, unknown>;
}

describe("shell/command", () => {
  test("runs a line and keeps its output in a file", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: "echo hello" },
      { runId: "run-1" },
    );

    expect(result.result).toBe("pass");
    const data = dataOf(result);
    expect(data.exitCode).toBe(0);
    expect(readFileSync(String(data.log), "utf8")).toContain("hello");
    expect(data.tail).toContain("hello");
  });

  test("understands quoting, pipes and &&", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: "printf 'a b\\n' | tr ' ' '-' && echo done" },
      { runId: "run-1" },
    );

    expect(result.result).toBe("pass");
    const text = readFileSync(String(dataOf(result).log), "utf8");
    expect(text).toContain("a-b");
    expect(text).toContain("done");
  });

  test("env is added to the command's environment", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: 'printf %s "$X"', env: { X: "from-params" } },
      { runId: "run-1" },
    );

    expect(result.result).toBe("pass");
    expect(readFileSync(String(dataOf(result).log), "utf8").trim()).toBe(
      "from-params",
    );
  });

  test("the host environment is still there when env is given", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: 'printf %s "$PATH"', env: { X: "from-params" } },
      { runId: "run-1" },
    );

    expect(result.result).toBe("pass");
    expect(readFileSync(String(dataOf(result).log), "utf8").trim()).toBe(
      String(process.env.PATH),
    );
  });

  test("a non-zero exit is a failure with its code and output path", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: "echo bad >&2; exit 3" },
      { runId: "run-1" },
    );

    expect(result.result).toBe("fail");
    const data = dataOf(result);
    expect(data.reason).toBe("exit");
    expect(data.exitCode).toBe(3);
    expect(readFileSync(String(data.log), "utf8")).toContain("bad");
    expect(data.tail).toContain("bad");
  });

  test("a timeout is a failure that says so", async () => {
    const clock = manualClock();
    const { root, registry } = await fixture(createShellPlugin({ clock }));
    const marker = join(root, "started");
    const running = registry.runStep(
      "shell/command",
      { line: `trap '' TERM; echo $$ > '${marker}'; sleep 30`, timeoutSecs: 5 },
      { runId: "run-1" },
    );

    await waitForFile(marker);
    expect(clock.fireTimeouts()).toBe(1);

    const result = await running;
    expect(result.result).toBe("fail");
    expect(dataOf(result).reason).toBe("timeout");
  });

  test("cancel stops the process group and reports interrupted", async () => {
    // The grace is injected: the stop sends its SIGTERM and its SIGKILL, but
    // the test does not wait out the production 500 ms first. A real timer
    // here left the test at the edge of the default timeout under a loaded
    // suite. The sentinel's survival of the SIGTERM has its own test.
    const clock = manualClock();
    const { root, registry } = await fixture(createShellPlugin({ clock }));
    const marker = join(root, "started");
    const controller = new AbortController();
    const running = registry.runStep(
      "shell/command",
      { line: `trap '' TERM; echo $$ > '${marker}'; sleep 30` },
      { runId: "run-cancel", signal: controller.signal },
    );

    const pid = await waitForPid(marker);
    controller.abort();

    const result = await running;
    expect(result.result).toBe("interrupted");
    expect(dataOf(result).reason).toBe("cancelled");
    // The SIGKILL reaches the whole group but the kernel takes the processes
    // down asynchronously: wait for the pid to go instead of sampling it once.
    await waitForGone(pid);
  });

  test("more than 8 MiB of output lands in the log and only the tail is in the fact", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: "yes x | head -c 12000000" },
      { runId: "run-big" },
    );

    expect(result.result).toBe("pass");
    const data = dataOf(result);
    expect(statSync(String(data.log)).size).toBeGreaterThanOrEqual(12_000_000);
    const tail = data.tail as readonly string[];
    expect(tail.length).toBeLessThanOrEqual(20);
    expect(tail.join("\n")).toContain("x");
  });

  test("a command that exits 130 keeps the exit code in the fact", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: "exit 130" },
      { runId: "run-130" },
    );

    expect(result.result).toBe("fail");
    const data = dataOf(result);
    expect(data.exitCode).toBe(130);
    expect(data.reason).toBe("exit");
    expect(String(data.message)).toContain("exited 130");
  });

  test("a child that outlives the line is in the group and is stopped", async () => {
    const { root, registry } = await fixture();
    const pidFile = join(root, "child.pid");
    const result = await registry.runStep(
      "shell/command",
      { line: `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'` },
      { runId: "run-fork" },
    );

    expect(result.result).toBe("pass");
    const pid = await waitForPid(pidFile);
    try {
      // The child sleeps far longer than waitForGone waits: only the stop path ends it.
      await waitForGone(pid);
    } finally {
      if (signalable(pid) && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test("a child that leaves the group cannot hold the command open, and the step stops it when it ends", async () => {
    const clock = manualClock();
    const { root, registry } = await fixture(createShellPlugin({ clock }));
    const pidFile = join(root, "escaped.pid");
    // Job control puts the background job in a process group of its own. It
    // keeps the inherited output descriptors and can no longer be signaled
    // through the command's group; the step's own sweep stops it at the end.
    // macOS's /bin/sh turns on job control here; Linux's dash refuses it
    // without a tty, so there `setsid` starts the job in a group of its own.
    // The child writes the pid itself, after it left the group.
    const escaped =
      process.platform === "linux"
        ? `setsid sh -c 'echo $$ > "${pidFile}"; sleep 60' & sleep 0.05`
        : `set -m; sleep 60 & echo $! > '${pidFile}'; sleep 0.05`;
    const running = registry.runStep(
      "shell/command",
      // The shell lives a few tens of milliseconds more, as a shell does that
      // reads its profile and ends a command: the sweep sees the job below it.
      { line: escaped },
      { runId: "run-escape" },
    );

    // Wait until the child reports from its own group, then end the drain
    // grace the injected clock holds.
    const pid = await waitForPid(pidFile);
    await clock.when(() => clock.pending > 0);
    expect(clock.fireTimeouts()).toBe(1);

    const result = await running;

    try {
      expect(result.result).toBe("pass");
      // The group stop cannot reach it; the sweep at the end of the step does.
      await waitForGone(pid);
      expect(clock.sleeps).toBe(0);
    } finally {
      if (signalable(pid) && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test("a cwd that does not exist fails with a clear reason", async () => {
    const { root, registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: "echo hello", cwd: join(root, "missing") },
      { runId: "run-1" },
    );

    expect(result.result).toBe("fail");
    const data = dataOf(result);
    expect(data.reason).toBe("cwd");
    expect(String(data.message)).toContain("cwd does not exist");
  });
});

describe("shell/check", () => {
  test("runs every line in order and passes", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/check",
      { lines: ["true", "echo ok"] },
      { runId: "run-1" },
    );

    expect(result.result).toBe("pass");
    const data = dataOf(result);
    expect(data.lines).toBe(2);
    expect(readFileSync(String(data.log), "utf8")).toContain("ok");
  });

  test("stops at the first failure and names the line", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/check",
      { lines: ["true", "exit 4", "echo never"] },
      { runId: "run-1" },
    );

    expect(result.result).toBe("fail");
    const data = dataOf(result);
    expect(data.line).toBe("exit 4");
    expect(data.lineNumber).toBe(2);
    expect(data.exitCode).toBe(4);
    expect(data.reason).toBe("exit");
    expect(readFileSync(String(data.log), "utf8")).not.toContain("never");
  });

  test("names the byte where this call's own output starts", async () => {
    const { registry } = await fixture();
    const first = await registry.runStep(
      "shell/check",
      { lines: ["echo first"] },
      { runId: "run-offset" },
    );
    const firstData = dataOf(first);
    expect(firstData.logStart).toBe(0);
    const before = statSync(String(firstData.log)).size;

    const second = await registry.runStep(
      "shell/check",
      { lines: ["echo second", "exit 4"] },
      { runId: "run-offset" },
    );
    expect(second.result).toBe("fail");
    const secondData = dataOf(second);
    expect(secondData.logStart).toBe(before);
    const text = readFileSync(String(secondData.log), "utf8");
    expect(text.slice(0, Number(secondData.logStart))).not.toContain("second");
    expect(text.slice(Number(secondData.logStart))).toContain("second");
  });

  test("a line that exceeds the timeout fails and names it", async () => {
    const clock = manualClock();
    const { root, registry } = await fixture(createShellPlugin({ clock }));
    const marker = join(root, "second-line");
    const running = registry.runStep(
      "shell/check",
      {
        lines: [
          "echo one",
          `trap '' TERM; echo $$ > '${marker}'; sleep 30`,
        ],
        timeoutSecs: 5,
      },
      { runId: "run-1" },
    );

    await waitForFile(marker);
    expect(clock.fireTimeouts()).toBe(1);

    const result = await running;
    expect(result.result).toBe("fail");
    const data = dataOf(result);
    expect(data.reason).toBe("timeout");
    expect(data.lineNumber).toBe(2);
    expect(String(data.message)).toContain("check line 2 was stopped after 5s");
  });

  test("an empty list passes", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/check",
      { lines: [] },
      { runId: "run-1" },
    );

    expect(result.result).toBe("pass");
    expect(dataOf(result).lines).toBe(0);
  });

  test("a line may use quoting, pipes and &&", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/check",
      { lines: ["printf 'a b\\n' | tr ' ' '-' && echo done"] },
      { runId: "run-1" },
    );

    expect(result.result).toBe("pass");
    expect(readFileSync(String(dataOf(result).log), "utf8")).toContain("a-b");
  });

  test("an abort before the first line is interrupted and leaves a log", async () => {
    const { registry } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await registry.runStep(
      "shell/check",
      { lines: ["true", "echo never"] },
      { runId: "run-abort", signal: controller.signal },
    );

    expect(result.result).toBe("interrupted");
    const data = dataOf(result);
    expect(data.reason).toBe("cancelled");
    expect(data.lineNumber).toBe(1);
    expect(existsSync(String(data.log))).toBe(true);
    expect(readFileSync(String(data.log), "utf8")).not.toContain("never");
  });

  test("an abort during a line is interrupted and names it", async () => {
    const clock = manualClock();
    const { root, registry } = await fixture(createShellPlugin({ clock }));
    const marker = join(root, "check-started");
    const controller = new AbortController();
    const running = registry.runStep(
      "shell/check",
      { lines: [`trap '' TERM; echo $$ > '${marker}'; sleep 30`] },
      { runId: "run-abort-line", signal: controller.signal },
    );

    await waitForFile(marker);
    controller.abort();
    const result = await running;
    expect(result.result).toBe("interrupted");
    const data = dataOf(result);
    expect(data.reason).toBe("cancelled");
    expect(data.lineNumber).toBe(1);
    expect(data.line).toContain("sleep 30");
    expect(existsSync(String(data.log))).toBe(true);
  });

  test("a cwd that does not exist fails with a clear reason", async () => {
    const { root, registry } = await fixture();
    const result = await registry.runStep(
      "shell/check",
      { lines: ["true"], cwd: join(root, "missing") },
      { runId: "run-1" },
    );

    expect(result.result).toBe("fail");
    expect(dataOf(result).reason).toBe("cwd");
  });
});

describe("shell/probe", () => {
  test("a cwd that does not exist is interrupted with a clear reason", async () => {
    const { root, registry } = await fixture();
    const result = await registry.runStep(
      "shell/probe",
      { line: "true", cwd: join(root, "missing") },
      { runId: "run-probe-cwd" },
    );

    expect(result.result).toBe("interrupted");
    const data = dataOf(result);
    expect(data.reason).toBe("cwd");
    expect(String(data.message)).toContain("cwd does not exist");
  });

  test("cancel interrupts a probe", async () => {
    const clock = manualClock();
    const { root, registry } = await fixture(createShellPlugin({ clock }));
    const marker = join(root, "probe-started");
    const controller = new AbortController();
    const running = registry.runStep(
      "shell/probe",
      { line: `trap '' TERM; echo $$ > '${marker}'; sleep 30` },
      { runId: "run-probe-cancel", signal: controller.signal },
    );

    await waitForFile(marker);
    controller.abort();
    const result = await running;
    expect(result.result).toBe("interrupted");
    expect(dataOf(result).reason).toBe("cancelled");
  });

  test("a timeout interrupts a probe and says so", async () => {
    const clock = manualClock();
    const { root, registry } = await fixture(createShellPlugin({ clock }));
    const marker = join(root, "probe-timeout");
    const running = registry.runStep(
      "shell/probe",
      { line: `trap '' TERM; echo $$ > '${marker}'; sleep 30`, timeoutSecs: 5 },
      { runId: "run-probe-timeout" },
    );

    await waitForFile(marker);
    expect(clock.fireTimeouts()).toBe(1);
    const result = await running;
    expect(result.result).toBe("interrupted");
    const data = dataOf(result);
    expect(data.reason).toBe("timeout");
    expect(String(data.message)).toContain("stopped after 5s");
  });

  const rootUser = process.getuid?.() === 0;
  const spawnTest = rootUser ? test.skip : test;

  spawnTest("a spawn failure interrupts a probe and says so", async () => {
    const { root, registry } = await fixture();
    const locked = join(root, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    try {
      const result = await registry.runStep(
        "shell/probe",
        { line: "true", cwd: locked },
        { runId: "run-probe-spawn" },
      );

      expect(result.result).toBe("interrupted");
      const data = dataOf(result);
      expect(data.reason).toBe("spawn");
      expect(String(data.message)).toContain("EACCES");
    } finally {
      await chmod(locked, 0o700);
    }
  });

  test("becomes ready when the exit code differs from the previous probe", async () => {
    const { root, registry } = await fixture();
    const flag = join(root, "flag");
    const line = `test -f '${flag}'`;
    const options = { runId: "run-probe" };

    const first = await registry.runStep("shell/probe", { line }, options);
    expect(first.result).toBe("waiting");
    expect(dataOf(first).exitCode).toBe(1);

    writeFileSync(flag, "1");
    const second = await registry.runStep("shell/probe", { line }, options);
    expect(second.result).toBe("ready");
    expect(dataOf(second).exitCode).toBe(0);

    const third = await registry.runStep("shell/probe", { line }, options);
    expect(third.result).toBe("waiting");
  });
});

describe("a flow through the runner", () => {
  test("runs shell/command and shell/check", async () => {
    const { root, registry } = await fixture();
    const stored = validateFlow(
      defineFlow({
        name: "shell-flow",
        entry: "build",
        steps: [
          {
            id: "build",
            kind: "plugin",
            params: { use: "shell/command", params: { line: "echo built" } },
            replay: "safe",
            next: { pass: "checks", fail: "failed", interrupted: "failed" },
          },
          {
            id: "checks",
            kind: "plugin",
            params: {
              use: "shell/check",
              params: { lines: ["true", "echo checked"] },
            },
            replay: "safe",
            next: { pass: "done", fail: "failed", interrupted: "failed" },
          },
          { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
          {
            id: "failed",
            kind: "end",
            params: { status: "failed" },
            replay: "safe",
          },
        ],
      }),
      registry.stepTypes(),
    ) as FlowDefinition;

    const log = openLog({ backend: "sqlite", path: join(root, "log", "log.sqlite") });
    try {
      const info = await log.startRun("shell-flow", "job:1");
      const outcome = await new Runner({
        log,
        flow: stored,
        runId: info.runId,
        registry,
      }).run();

      expect(outcome).toBe("ended");
      expect((await readState(log, info.runId)).endedStatus).toBe("done");
    } finally {
      await log.close();
    }
  });

  test("waits on shell/probe with its params", async () => {
    const { root, registry } = await fixture();
    const flag = join(root, "ready");
    const stored = validateFlow(
      defineFlow({
        name: "probe-flow",
        entry: "watch",
        steps: [
          {
            id: "watch",
            kind: "wait",
            params: { check: "shell/probe", params: { line: `test -f '${flag}'` } },
            replay: "safe",
            next: { ready: "done", interrupted: "failed" },
          },
          { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
          {
            id: "failed",
            kind: "end",
            params: { status: "failed" },
            replay: "safe",
          },
        ],
      }),
      registry.stepTypes(),
    ) as FlowDefinition;

    const log = openLog({ backend: "sqlite", path: join(root, "log", "log.sqlite") });
    try {
      const info = await log.startRun("probe-flow", "job:1");
      const runner = new Runner({
        log,
        flow: stored,
        runId: info.runId,
        registry,
      });

      expect(await runner.run()).toBe("blocked");
      writeFileSync(flag, "1");
      expect(await runner.run()).toBe("ended");
      expect((await readState(log, info.runId)).endedStatus).toBe("done");
    } finally {
      await log.close();
    }
  });

  test("a run cancel stops the command's process group in a worker", async () => {
    const root = await tempRoot();
    const source = new URL("../src/index.ts", import.meta.url).href;
    const registry = new PluginRegistry([shell], {
      home: root,
      cwd: root,
      store: new SqlitePluginStore({ root: join(root, "store") }),
      sources: [source],
    });
    const marker = join(root, "started");
    const stored = validateFlow(
      defineFlow({
        name: "cancel-flow",
        entry: "run",
        steps: [
          {
            id: "run",
            kind: "plugin",
            params: {
              use: "shell/command",
              params: { line: `trap '' TERM; echo $$ > '${marker}'; sleep 30` },
            },
            replay: "safe",
            next: { pass: "done", fail: "failed", interrupted: "failed" },
          },
          { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
          {
            id: "failed",
            kind: "end",
            params: { status: "failed" },
            replay: "safe",
          },
        ],
      }),
      registry.stepTypes(),
    ) as FlowDefinition;

    const log = openLog({ backend: "sqlite", path: join(root, "log", "log.sqlite") });
    try {
      const info = await log.startRun("cancel-flow", "job:1");
      const controller = new AbortController();
      const running = new Runner({
        log,
        flow: stored,
        runId: info.runId,
        registry,
        signal: controller.signal,
      }).run();

      const pid = await waitForPid(marker);
      controller.abort();

      expect(await running).toBe("ended");
      expect((await readState(log, info.runId)).endedStatus).toBe("failed");
      try {
        await waitForGone(pid);
      } finally {
        if (alive(pid)) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    } finally {
      await log.close();
    }
  });
});
