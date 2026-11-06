import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  openLog,
  readState,
  type PluginStepResult,
} from "@operad-io/engine";
import {
  createRadianHarnessPlugin,
  type RadianHarnessSettings,
} from "../src/index.ts";
import {
  cleanupTempRoots,
  fakeRadian,
  manualClock,
  tempRoot,
  waitForFile,
  type ManualClock,
} from "./support.ts";

afterAll(cleanupTempRoots);

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  restores.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

interface TestEnv {
  readonly root: string;
  readonly clock: ManualClock;
  readonly registry: PluginRegistry;
  readonly record: string;
  readonly marker: string;
  readonly calls: string;
}

async function setup(
  mode: string,
  settings: RadianHarnessSettings = {},
): Promise<TestEnv> {
  const root = await tempRoot();
  const bin = await fakeRadian(root);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  restores.push(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  setEnv("FAKE_RADIAN_MODE", mode);
  const record = join(root, "record.json");
  const marker = join(root, "marker");
  const calls = join(root, "calls");
  setEnv("FAKE_RADIAN_RECORD", record);
  setEnv("FAKE_RADIAN_MARKER", marker);
  setEnv("FAKE_RADIAN_CALLS", calls);

  const clock = manualClock();
  const plugin = createRadianHarnessPlugin({ clock, ...settings });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: root,
    store: new MemoryPluginStore({ root: join(root, "store") }),
  });
  return { root, clock, registry, record, marker, calls };
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

/** Waits for a real process to disappear; only a signal test needs this. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  stepMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for a condition");
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, stepMs));
  }
}

function runAgent(
  env: TestEnv,
  params: Record<string, unknown>,
  options: { readonly runId?: string; readonly signal?: AbortSignal } = {},
) {
  return env.registry.runStep("harness-radian/agent", params, {
    runId: options.runId ?? "run-1",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

describe("harness-radian/agent", () => {
  test("a successful run records the Result record and writes the JSONL log", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      args: ["--thinking", "off"],
    });

    expect(result.result).toBe("done");
    const data = dataOf(result);
    expect(data.exitCode).toBe(0);
    expect(data.signal).toBeNull();
    expect(data.sessionId).toBe("fake-session");
    expect(data.finalMessage).toBe("fake final message");
    expect(data.usage).toEqual({ input: 11, output: 7 });
    expect(data.cost).toEqual({
      micros: 1234,
      incomplete: false,
      estimated: false,
    });

    const record = JSON.parse(readFileSync(env.record, "utf8")) as {
      readonly argv: readonly string[];
      readonly workspace: string;
      readonly prompt: string;
    };
    expect(record.prompt).toBe("hello");
    expect(record.workspace).toBe(env.root);
    expect(record.argv).toEqual([
      "exec",
      "--workspace",
      env.root,
      "--output",
      "jsonl",
      "--thinking",
      "off",
      "-p",
      "hello",
    ]);
    expect(readFileSync(String(data.log), "utf8")).toContain('"type":"Result"');
  });

  test("a Result record without a cost leaves the cost unknown, not zero", async () => {
    const env = await setup("no-cost");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });

    expect(result.result).toBe("done");
    expect(dataOf(result).cost).toBeNull();
  });

  test("resumeSession is passed to radian", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      resumeSession: "session-7",
    });

    expect(result.result).toBe("done");
    const record = JSON.parse(readFileSync(env.record, "utf8")) as {
      readonly argv: readonly string[];
    };
    expect(record.argv).toContain("--resume");
    expect(record.argv[record.argv.indexOf("--resume") + 1]).toBe("session-7");
  });

  test("a non-zero exit is a failure that says so", async () => {
    const env = await setup("exit1");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });

    expect(result.result).toBe("failed");
    const data = dataOf(result);
    expect(data.reason).toBe("exit");
    expect(data.exitCode).toBe(1);
    expect(data.sessionId).toBe("fake-session");
  });

  test("a zero exit without a Result record is a failure that says so", async () => {
    const env = await setup("no-result");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });

    expect(result.result).toBe("failed");
    const data = dataOf(result);
    expect(data.reason).toBe("no_result");
    expect(data.exitCode).toBe(0);
  });

  test("no new output line for stallSecs stops the group", async () => {
    const env = await setup("stall");
    const running = runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      wallTimeSecs: 300,
      stallSecs: 1,
    });

    await waitForFile(env.marker);
    await waitUntil(() => env.clock.clears > 0);
    const pid = Number(readFileSync(env.marker, "utf8"));
    env.clock.fireUpTo(1000);

    const result = await running;
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("stall");
    await waitUntil(() => !alive(pid));
  });

  test("wallTimeSecs stops a run that never ends", async () => {
    const env = await setup("wall");
    const running = runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      wallTimeSecs: 1,
      stallSecs: 300,
    });

    await waitForFile(env.marker);
    const pid = Number(readFileSync(env.marker, "utf8"));
    env.clock.fireUpTo(1000);

    const result = await running;
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("wall");
    await waitUntil(() => !alive(pid));
  });

  test("cancel stops the process group and reports interrupted", async () => {
    const env = await setup("cancel");
    const controller = new AbortController();
    const running = runAgent(
      env,
      { prompt: "hello", cwd: env.root, wallTimeSecs: 300, stallSecs: 300 },
      { runId: "run-cancel", signal: controller.signal },
    );

    await waitForFile(env.marker);
    const pids = JSON.parse(readFileSync(env.marker, "utf8")) as {
      readonly pid: number;
      readonly child: number;
    };
    controller.abort();

    const result = await running;
    expect(result.result).toBe("interrupted");
    expect(dataOf(result).reason).toBe("cancelled");
    await waitUntil(() => !alive(pids.pid));
    if (typeof pids.child === "number") {
      await waitUntil(() => !alive(pids.child));
    }
  });

  test("a prompt over 1 MB goes through stdin unchanged", async () => {
    const env = await setup("done");
    const prompt = "p".repeat(1024 * 1024 + 123);
    const result = await runAgent(env, { prompt, cwd: env.root });

    expect(result.result).toBe("done");
    const record = JSON.parse(readFileSync(env.record, "utf8")) as {
      readonly argv: readonly string[];
      readonly prompt: string;
      readonly promptBytes: number;
    };
    expect(record.promptBytes).toBeGreaterThan(1024 * 1024);
    expect(record.prompt).toBe(prompt);
    expect(record.argv.slice(-2)).toEqual(["-p", "-"]);
  });

  test("a radian that is not on PATH fails with a clear reason", async () => {
    const env = await setup("done");
    const empty = join(env.root, "empty");
    await mkdir(empty, { recursive: true });
    process.env.PATH = empty;

    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("failed");
    const data = dataOf(result);
    expect(data.reason).toBe("missing");
    expect(String(data.message)).toContain("radian was not found on PATH");
  });

  test("a cwd that does not exist fails with a clear reason", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: join(env.root, "absent"),
    });

    expect(result.result).toBe("failed");
    const data = dataOf(result);
    expect(data.reason).toBe("cwd");
    expect(String(data.message)).toContain("cwd does not exist");
  });
});

describe("harness-radian:prompt", () => {
  test("runs the fake once with the prompt unchanged and ends with its result", async () => {
    const env = await setup("done");
    const found = env.registry.flow("harness-radian:prompt");
    if (found === undefined) throw new Error("the prompt flow is not loaded");

    const log = openLog({
      backend: "jsonl",
      path: join(env.root, "log"),
    });
    const info = await log.startRun(found.flow.name, "prompt:1");
    const prompt = "say the word pong";
    const runner = new Runner({
      log,
      flow: found.flow,
      runId: info.runId,
      registry: env.registry,
      params: {
        prompt,
        cwd: env.root,
        args: ["--thinking", "off"],
      },
    });

    await runner.run();
    const state = await readState(log, info.runId);
    expect(state.endedStatus).toBe("done");

    const record = JSON.parse(readFileSync(env.record, "utf8")) as {
      readonly argv: readonly string[];
      readonly prompt: string;
      readonly workspace: string;
    };
    expect(record.prompt).toBe(prompt);
    expect(record.workspace).toBe(env.root);
    expect(record.argv).toContain("--thinking");
    expect(readFileSync(env.calls, "utf8").trim().split("\n")).toHaveLength(1);

    await log.close();
  });
});

const realTest = process.env.OPERAD_TEST_RADIAN === "1" ? test : test.skip;

realTest(
  "runs the real radian (set OPERAD_TEST_RADIAN=1 to enable this test)",
  async () => {
    const root = await tempRoot();
    const plugin = createRadianHarnessPlugin();
    const registry = new PluginRegistry([plugin], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
    });
    const result = await registry.runStep(
      "harness-radian/agent",
      {
        prompt: "Reply with exactly the word pong.",
        cwd: root,
        wallTimeSecs: 120,
        stallSecs: 60,
      },
      { runId: "real-radian" },
    );

    expect(result.result).toBe("done");
    const data = dataOf(result);
    expect(typeof data.sessionId).toBe("string");
    expect(String(data.sessionId).length).toBeGreaterThan(0);
    expect(readFileSync(String(data.log), "utf8")).toContain('"type":"Result"');
  },
);
