import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  openLog,
  readState,
  type PluginStepResult,
  type JsonValue,
  type TriggerView,
} from "@operad-io/engine";
import {
  createRadianHarnessPlugin,
  EVENT_NOTE_TEMPLATE,
  type RadianHarnessSettings,
} from "../src/index.ts";
import { runAgent as runProcess } from "../src/process.ts";
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
    await env.clock.when(() => env.clock.clears > 0);
    const pid = Number(readFileSync(env.marker, "utf8"));
    env.clock.fireUpTo(1000);

    const result = await running;
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("stall");
    expect(alive(pid)).toBe(false);
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
    expect(alive(pid)).toBe(false);
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
    expect(alive(pids.pid)).toBe(false);
    if (typeof pids.child === "number") {
      expect(alive(pids.child)).toBe(false);
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

  const rootUser = process.getuid?.() === 0;
  const spawnFailureTest = rootUser ? test.skip : test;

  spawnFailureTest(
    "a spawn failure after the cwd check settles as a failure, not a hang",
    async () => {
      const env = await setup("done");
      const locked = join(env.root, "locked");
      await mkdir(locked);
      await chmod(locked, 0o000);
      try {
        const result = await runAgent(env, { prompt: "hello", cwd: locked });
        expect(result.result).toBe("failed");
        const data = dataOf(result);
        expect(data.reason).toBe("spawn");
        expect(String(data.message)).toContain("EACCES");
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  test("an unterminated output stream is stopped, not buffered forever", async () => {
    const env = await setup("flood");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      wallTimeSecs: 300,
      stallSecs: 300,
    });

    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("line_too_long");
  });

  test("a line handler that is still busy stops the reader from reading ahead", async () => {
    const env = await setup("lines");
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let firstSeen: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      firstSeen = resolve;
    });
    const seen: string[] = [];
    let busy = false;

    const running = runProcess({
      command: "radian",
      args: ["exec"],
      cwd: env.root,
      wallMs: 0,
      stallMs: 0,
      signal: new AbortController().signal,
      clock: manualClock(),
      onLine(line) {
        seen.push(line);
        firstSeen();
        if (busy) return undefined;
        busy = true;
        return gate;
      },
    });

    await first;
    // All lines arrive in one write; the second line may not be delivered
    // while the handler's answer is unanswered.
    expect(seen).toHaveLength(1);

    openGate();
    const outcome = await running;
    expect(outcome.exitCode).toBe(0);
    expect(seen).toHaveLength(5);
    expect(seen[seen.length - 1]).toContain('"Result"');
  });
});

describe("harness-radian:prompt", () => {
  interface PromptRun {
    readonly prompt: string;
    readonly argv: readonly string[];
    readonly workspace: string;
    readonly endedStatus: string | null;
  }

  async function runPrompt(
    env: TestEnv,
    params: JsonValue,
    trigger?: TriggerView,
  ): Promise<PromptRun> {
    const found = env.registry.flow("harness-radian:prompt");
    if (found === undefined) throw new Error("the prompt flow is not loaded");
    const log = openLog({
      backend: "jsonl",
      path: join(env.root, "log"),
    });
    const info = await log.startRun(found.flow.name, "prompt:1");
    const runner = new Runner({
      log,
      flow: found.flow,
      runId: info.runId,
      registry: env.registry,
      params,
      ...(trigger === undefined ? {} : { trigger }),
    });
    await runner.run();
    const state = await readState(log, info.runId);
    await log.close();
    const record = JSON.parse(readFileSync(env.record, "utf8")) as {
      readonly prompt: string;
      readonly argv: readonly string[];
      readonly workspace: string;
    };
    return { ...record, endedStatus: state.endedStatus };
  }

  test("runs the fake once with the prompt unchanged and ends with its result", async () => {
    const env = await setup("done");
    const prompt = "say the word pong";
    const record = await runPrompt(env, {
      prompt,
      cwd: env.root,
      args: ["--thinking", "off"],
    });

    expect(record.endedStatus).toBe("done");
    expect(record.prompt).toBe(prompt);
    expect(record.prompt).not.toContain("outside material");
    expect(record.workspace).toBe(env.root);
    expect(record.argv).toContain("--thinking");
    expect(readFileSync(env.calls, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a trigger with summary and data appends one note that names both files", async () => {
    const env = await setup("done");
    const summary = join(env.root, "event-summary.txt");
    const data = join(env.root, "event-data.json");
    const eventText = "THE EVENT TEXT MUST STAY OUT OF THE PROMPT";
    await writeFile(summary, eventText);
    await writeFile(data, JSON.stringify({ note: eventText }));

    const prompt = "say the word pong";
    const record = await runPrompt(
      env,
      { prompt, cwd: env.root },
      {
        source: "cron",
        key: "tick:1",
        type: "tick",
        hops: 0,
        summary,
        data,
      },
    );

    const note = EVENT_NOTE_TEMPLATE.replace(
      "{files}",
      `summary: ${summary}, data: ${data}`,
    );
    expect(record.prompt).toBe(`${prompt}\n\n${note}`);
    expect(record.prompt).toContain(summary);
    expect(record.prompt).toContain(data);
    expect(record.prompt).not.toContain(eventText);
  });

  test("a trigger with neither file leaves the prompt unchanged", async () => {
    const env = await setup("done");
    const prompt = "say the word pong";
    const record = await runPrompt(
      env,
      { prompt, cwd: env.root },
      { source: "cron", key: "tick:2", type: "tick", hops: 0 },
    );

    expect(record.prompt).toBe(prompt);
    expect(record.prompt).not.toContain("outside material");
  });
});

describe("harness-radian check", () => {
  test("passes when radian is on PATH", async () => {
    const env = await setup("done");
    const [check] = await env.registry.checks();
    expect(check?.plugin).toBe("harness-radian");
    expect(check?.ok).toBe(true);
    expect(check?.message).toContain("radian is available");
  });

  test("names a missing radian as a failed check", async () => {
    const root = await tempRoot();
    const empty = join(root, "empty");
    await mkdir(empty, { recursive: true });
    const previous = process.env.PATH;
    process.env.PATH = empty;
    restores.push(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
    const registry = new PluginRegistry([createRadianHarnessPlugin()], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
    });

    const [check] = await registry.checks();
    expect(check?.plugin).toBe("harness-radian");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("radian was not found on PATH");
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
