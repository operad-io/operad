import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  defineFlow,
  openLog,
  readState,
  validateFlow,
  type FlowDefinition,
  type PluginStepResult,
} from "@operad-io/engine";
import shell from "../src/index.ts";
import { cleanupTempRoots, tempRoot, waitForFile } from "./support.ts";

afterAll(cleanupTempRoots);

interface Fixture {
  readonly root: string;
  readonly registry: PluginRegistry;
}

async function fixture(): Promise<Fixture> {
  const root = await tempRoot();
  return {
    root,
    registry: new PluginRegistry([shell], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
    }),
  };
}

function dataOf(result: PluginStepResult): Record<string, unknown> {
  return (result.data ?? {}) as Record<string, unknown>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    const { registry } = await fixture();
    const started = Date.now();
    const result = await registry.runStep(
      "shell/command",
      { line: "sleep 30", timeoutSecs: 0.1 },
      { runId: "run-1" },
    );

    expect(result.result).toBe("fail");
    expect(dataOf(result).reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("cancel stops the process group and reports interrupted", async () => {
    const { root, registry } = await fixture();
    const marker = join(root, "started");
    const controller = new AbortController();
    const running = registry.runStep(
      "shell/command",
      { line: `trap '' TERM; echo $$ > '${marker}'; sleep 30` },
      { runId: "run-cancel", signal: controller.signal },
    );

    await waitForFile(marker);
    const pid = Number(readFileSync(marker, "utf8").trim());
    controller.abort();

    const result = await running;
    expect(result.result).toBe("interrupted");
    expect(dataOf(result).reason).toBe("cancelled");
    expect(alive(pid)).toBe(false);
  });

  test("megabytes of output land in the log and only the tail is in the fact", async () => {
    const { registry } = await fixture();
    const result = await registry.runStep(
      "shell/command",
      { line: "yes x | head -c 3000000" },
      { runId: "run-big" },
    );

    expect(result.result).toBe("pass");
    const data = dataOf(result);
    expect(statSync(String(data.log)).size).toBeGreaterThanOrEqual(3_000_000);
    const tail = data.tail as readonly string[];
    expect(tail.length).toBeLessThanOrEqual(20);
    expect(tail.join("\n")).toContain("x");
  });

  test("a child that outlives the line is in the group and is stopped", async () => {
    const { root, registry } = await fixture();
    const pidFile = join(root, "child.pid");
    const result = await registry.runStep(
      "shell/command",
      { line: `sleep 3 >/dev/null 2>&1 & echo $! > '${pidFile}'` },
      { runId: "run-fork" },
    );

    expect(result.result).toBe("pass");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(pid)).toBe(false);
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

    const log = openLog({ backend: "jsonl", path: join(root, "log") });
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

    const log = openLog({ backend: "jsonl", path: join(root, "log") });
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
});
