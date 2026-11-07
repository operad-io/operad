import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccessError,
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  openLog,
  readState,
  type JsonValue,
  validateUsage,
  type PluginStepResult,
  type TriggerView,
} from "@operad-io/engine";
import { EVENT_NOTE_TEMPLATE } from "@operad-io/harness-process";
import { createPiHarnessPlugin, modelErrorOf, piToolEvent } from "../src/index.ts";
import {
  cleanupTempRoots,
  manualClock,
  tempRoot,
  waitForFile,
  type ManualClock,
} from "./support.ts";

afterAll(cleanupTempRoots);

const FAKE = fileURLToPath(new URL("./fake-lines-worker.ts", import.meta.url));

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
  readonly release: string;
}

async function setup(
  mode: string,
  settings?: Readonly<Record<string, unknown>>,
): Promise<TestEnv> {
  const root = await tempRoot();
  const record = join(root, "record.json");
  const marker = join(root, "marker");
  const release = join(root, "release");
  setEnv("FAKE_PI_MODE", mode);
  setEnv("FAKE_PI_RECORD", record);
  setEnv("FAKE_PI_MARKER", marker);
  setEnv("FAKE_PI_RELEASE", release);

  const clock = manualClock();
  const plugin = createPiHarnessPlugin({ clock, command: process.execPath, args: [FAKE] });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: root,
    store: new MemoryPluginStore({ root: join(root, "store") }),
    ...(settings === undefined ? {} : { settings: { "harness-pi": settings } }),
  });
  return { root, clock, registry, record, marker, release };
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

function recorded(env: TestEnv): Record<string, unknown> {
  return JSON.parse(readFileSync(env.record, "utf8")) as Record<string, unknown>;
}

function runAgent(
  env: TestEnv,
  params: Record<string, unknown>,
  options: { readonly runId?: string; readonly signal?: AbortSignal } = {},
) {
  return env.registry.runStep("harness-pi/agent", params, {
    runId: options.runId ?? "run-1",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

describe("harness-pi/agent", () => {
  test("a done run has the facts harness-radian records for the same data", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    const data = dataOf(result);
    expect(data.exitCode).toBe(0);
    expect(data.signal).toBeNull();
    expect(data.sessionId).toBe("fake-session");
    expect(data.finalMessage).toBe("fake final message");
    expect(data.usage).toEqual({
      harness: "harness-pi",
      model: null,
      tokens: { input: 11, output: 7, cacheread: 0, cachewrite: 0 },
      costMicros: 1234,
    });
    expect(validateUsage(data.usage).ok).toBe(true);
    expect("cost" in data).toBe(false);
    expect(data.stderr).toEqual([]);
    expect(typeof data.durationMs).toBe("number");
    expect(readFileSync(String(data.log), "utf8")).toContain('"type":"result"');

    // The same fake data through harness-radian gives the same facts.
    const radianModule = (await import(
      new URL("../../harness-radian/src/index.ts", import.meta.url).href
    )) as { readonly createRadianHarnessPlugin: (o: object) => unknown };
    const bin = join(env.root, "fake-radian");
    writeFileSync(
      bin,
      `#!/usr/bin/env bun\nconsole.log(JSON.stringify({type:"Result",session_id:"fake-session",usage:{input:11,output:7},cost:{micros:1234},text:"fake final message"}));\n`,
      { mode: 0o755 },
    );
    const radian = new PluginRegistry([radianModule.createRadianHarnessPlugin({})], {
      home: env.root,
      cwd: env.root,
      store: new MemoryPluginStore({ root: join(env.root, "store2") }),
      settings: { "harness-radian": { command: bin } },
    });
    const other = await radian.runStep(
      "harness-radian/agent",
      { prompt: "hello", cwd: env.root },
      { runId: "run-radian" },
    );
    expect(other.result).toBe("done");
    const otherData = dataOf(other);
    expect(Object.keys(data).sort()).toEqual(Object.keys(otherData).sort());
    for (const key of ["exitCode", "signal", "sessionId", "finalMessage", "stderr"]) {
      expect(data[key]).toEqual(otherData[key]);
    }
    // The same usage but for who ran.
    expect(otherData.usage).toEqual({ ...(data.usage as object), harness: "harness-radian" });
  });

  test("a worker line without a price leaves the cost unknown, not zero", async () => {
    const env = await setup("no-cost");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    expect(validateUsage(dataOf(result).usage).ok).toBe(true);
    expect((dataOf(result).usage as { costMicros: unknown }).costMicros).toBeNull();
  });

  test("the worker gets the prompt, the directories, the settings and no discovery", async () => {
    const env = await setup("done", {
      model: "fake/model",
      thinkingLevel: "low",
      authPath: "/auth/here.json",
    });
    await runAgent(env, { prompt: "hello", cwd: env.root });
    const input = recorded(env);
    expect(input.prompt).toBe("hello");
    expect(input.cwd).toBe(env.root);
    expect(input.model).toBe("fake/model");
    expect(input.thinkingLevel).toBe("low");
    expect(input.authPath).toBe("/auth/here.json");
    expect(String(input.modelsPath).endsWith("/.pi/agent/models.json")).toBe(true);
    expect(input.agentDir).toBe(join(env.root, "harness", "pi"));
    expect(input.sessionDir).toBe(join(env.root, "harness", "pi", "sessions"));
    expect("resumeSession" in input).toBe(false);
    expect("access" in input).toBe(false);
  });

  test("--model and --thinking in args reach the worker and win over the settings", async () => {
    const env = await setup("done", { model: "fake/setting", thinkingLevel: "low" });
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      args: ["--model", "openai-codex/gpt-5.6-terra", "--thinking", "medium"],
    });
    expect(result.result).toBe("done");
    const input = recorded(env);
    expect(input.model).toBe("openai-codex/gpt-5.6-terra");
    expect(input.thinkingLevel).toBe("medium");
    expect((dataOf(result).usage as { model: unknown }).model).toBe("openai-codex/gpt-5.6-terra");
  });

  test("the usage names the model setting when the step has no --model", async () => {
    const env = await setup("done", { model: "fake/setting" });
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect((dataOf(result).usage as { model: unknown }).model).toBe("fake/setting");
  });

  test("a flag given alone leaves the other from the settings", async () => {
    const env = await setup("done", { model: "fake/setting", thinkingLevel: "low" });
    await runAgent(env, { prompt: "hello", cwd: env.root, args: ["--thinking", "high"] });
    const input = recorded(env);
    expect(input.model).toBe("fake/setting");
    expect(input.thinkingLevel).toBe("high");
  });

  const INVALID_ARGS: ReadonlyArray<readonly [string, string[], string]> = [
    ["an unknown flag", ["--x"], "--x"],
    ["a flag without its value", ["--model"], "--model"],
    ["a thinking flag without its value", ["--thinking"], "--thinking"],
    ["a model that is not provider/id", ["--model", "gpt"], "gpt"],
    ["a model with an empty id", ["--model", "openai/"], "openai/"],
    ["a flag as the value", ["--model", "--thinking"], "--thinking"],
    ["an unknown level", ["--thinking", "extreme"], "extreme"],
    ["a model given twice", ["--model", "a/b", "--model", "c/d"], "--model"],
    ["a level given twice", ["--thinking", "low", "--thinking", "high"], "--thinking"],
    ["a stray value", ["--model", "a/b", "extra"], "extra"],
    ["the = spelling", ["--model=a/b"], "--model=a/b"],
  ];
  for (const [name, args, entry] of INVALID_ARGS) {
    test(`${name} fails with invalid_args and the worker is not started`, async () => {
      const env = await setup("done");
      const result = await runAgent(env, { prompt: "hello", cwd: env.root, args });
      expect(result.result).toBe("failed");
      expect(dataOf(result).reason).toBe("invalid_args");
      expect(String(dataOf(result).message)).toContain(entry);
      expect(existsSync(env.record)).toBe(false);
    });
  }

  test("unset model and thinking level are not sent, so pi uses its default", async () => {
    const env = await setup("done");
    await runAgent(env, { prompt: "hello", cwd: env.root });
    const input = recorded(env);
    expect("model" in input).toBe(false);
    expect("thinkingLevel" in input).toBe(false);
    expect(String(input.authPath).endsWith("/.pi/agent/auth.json")).toBe(true);
    expect(String(input.authPath).startsWith("~")).toBe(false);
  });

  test("resumeSession is passed through to the worker's stdin", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      resumeSession: "/sessions/one.jsonl",
    });
    expect(result.result).toBe("done");
    expect(recorded(env).resumeSession).toBe("/sessions/one.jsonl");
  });

  test("the run's access profile is passed to the worker", async () => {
    const env = await setup("done");
    await env.registry.runStep(
      "harness-pi/agent",
      { prompt: "hello", cwd: env.root },
      { runId: "run-access", access: { denyCommands: ["rm"] } },
    );
    expect(recorded(env).access).toEqual({ denyCommands: ["rm"] });
  });

  test("a worker Result of failed is a failure that names the reason", async () => {
    const env = await setup("session-missing");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("session_missing");
    expect(String(dataOf(result).message)).toContain("/nowhere");
    expect("modelError" in dataOf(result)).toBe(false);
  });

  test("no Result line and an exit: failed with the last stderr lines in the message", async () => {
    const env = await setup("no-result");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("failed");
    const data = dataOf(result);
    expect(data.reason).toBe("no_result");
    expect(String(data.message)).toContain("first stderr line");
    expect(String(data.message)).toContain("second stderr line");
    expect(data.sessionId).toBeNull();
  });

  test("a worker killed with SIGKILL ends interrupted and leaves the test alive", async () => {
    const env = await setup("kill");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("interrupted");
    const data = dataOf(result);
    expect(data.reason).toBe("signal");
    expect(String(data.message)).toContain("SIGKILL");
    expect(alive(Number(readFileSync(env.marker, "utf8")))).toBe(false);
    expect(alive(process.pid)).toBe(true);
  });

  test("a model_error failure carries modelError of kind unavailable for a 429", async () => {
    const env = await setup("model-error-429");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("model_error");
    const error = dataOf(result).modelError as Record<string, unknown>;
    expect(error.kind).toBe("unavailable");
    expect(error.status).toBe(429);
  });

  test("a model_error failure about a usage limit is usage_limit", async () => {
    const env = await setup("model-error-usage-limit");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect((dataOf(result).modelError as Record<string, unknown>).kind).toBe("usage_limit");
  });

  test("any other model_error is protocol", async () => {
    const env = await setup("model-error-other");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect((dataOf(result).modelError as Record<string, unknown>).kind).toBe("protocol");
  });

  test("modelErrorOf: a usage-limit text wins over a 429 in the same text", () => {
    expect(modelErrorOf("429 usage limit reached").kind).toBe("usage_limit");
    expect(modelErrorOf("provider is overloaded").kind).toBe("unavailable");
    expect(modelErrorOf("a 4290 tokens message").kind).toBe("protocol");
  });

  test("silence without an open tool call is a stall", async () => {
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

  test("silence with an open tool call is not a stall", async () => {
    const env = await setup("tool-silent");
    const running = runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      wallTimeSecs: 300,
      stallSecs: 1,
    });
    await waitForFile(env.marker);
    await env.clock.when(() => env.clock.clears > 0);
    // Twice the stall limit passes with no line and no stop: the tool is open.
    expect(env.clock.fireUpTo(2_000)).toBe(0);

    writeFileSync(env.release, "settle");
    const result = await running;
    expect(result.result).toBe("done");
  });

  test("the wall limit still stops a run while a tool call is open", async () => {
    const env = await setup("tool-silent");
    const running = runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      wallTimeSecs: 1,
      stallSecs: 300,
    });
    await waitForFile(env.marker);
    const pid = Number(readFileSync(env.marker, "utf8"));
    env.clock.fireUpTo(1_000);

    const result = await running;
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("wall");
    expect(alive(pid)).toBe(false);
  });

  test("settings supply the limits and a step param overrides them", async () => {
    const env = await setup("stall", { stallSecs: 5 });
    const running = runAgent(env, { prompt: "hello", cwd: env.root, stallSecs: 2 });
    await waitForFile(env.marker);
    await env.clock.when(() => env.clock.clears > 0);
    env.clock.fireUpTo(2000);
    const result = await running;
    expect(dataOf(result).reason).toBe("stall");
    expect(String(dataOf(result).message)).toContain("2s");
  });

  test("a wallTimeSecs above the step timeout is refused", async () => {
    const env = await setup("done");
    await expect(
      runAgent(env, { prompt: "hello", cwd: env.root, wallTimeSecs: 10 * 3600 }),
    ).rejects.toThrow(/wallTimeSecs/);
  });

  test("cancel stops the worker and reports interrupted", async () => {
    const env = await setup("cancel");
    const controller = new AbortController();
    const running = runAgent(
      env,
      { prompt: "hello", cwd: env.root, wallTimeSecs: 300, stallSecs: 300 },
      { signal: controller.signal },
    );
    await waitForFile(env.marker);
    const pid = Number(readFileSync(env.marker, "utf8"));
    controller.abort();

    const result = await running;
    expect(result.result).toBe("interrupted");
    expect(dataOf(result).reason).toBe("cancelled");
    expect(alive(pid)).toBe(false);
  });

  test("a cwd that does not exist fails with a clear reason", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hello", cwd: join(env.root, "nope") });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("cwd");
  });

  test("a worker program that is not there fails with a clear reason", async () => {
    const env = await setup("done");
    const plugin = createPiHarnessPlugin({ command: join(env.root, "no-such-bun"), args: [] });
    const registry = new PluginRegistry([plugin], {
      home: env.root,
      cwd: env.root,
      store: new MemoryPluginStore({ root: join(env.root, "store3") }),
    });
    const result = await registry.runStep(
      "harness-pi/agent",
      { prompt: "hello", cwd: env.root },
      { runId: "run-missing" },
    );
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("missing");
  });

  test("the step declares the deny fields it enforces and a timeout above its wall time", async () => {
    const env = await setup("done");
    const type = env.registry.stepTypes().find((item) => item.name === "harness-pi/agent");
    expect(type?.enforces).toEqual(["denyPaths", "denyCommands"]);
    expect(type?.timeoutSecs).toBeGreaterThan(3600);
  });

  test("a profile with askCommands is refused at start and the field is named", async () => {
    const env = await setup("done");
    let error: unknown;
    try {
      env.registry.checkAccess("harness-pi:prompt", { askCommands: ["git push"] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AccessError);
    expect(String((error as Error).message)).toContain("askCommands");
    expect(() =>
      env.registry.checkAccess("harness-pi:prompt", {
        denyCommands: ["rm"],
        denyPaths: ["/etc"],
      }),
    ).not.toThrow();
  });
});

describe("piToolEvent", () => {
  test("classifies pi's tool events and nothing else", () => {
    expect(piToolEvent('{"type":"tool_execution_start","toolName":"bash"}')).toBe("tool-start");
    expect(piToolEvent('{"type":"tool_execution_end","toolName":"bash"}')).toBe("tool-end");
    expect(piToolEvent('{"type":"message_end"}')).toBeUndefined();
    expect(piToolEvent("not json")).toBeUndefined();
  });
});

describe("harness-pi:prompt", () => {
  async function runPrompt(env: TestEnv, params: JsonValue, trigger?: TriggerView) {
    const found = env.registry.flow("harness-pi:prompt");
    if (found === undefined) throw new Error("the prompt flow is not loaded");
    const log = openLog({ backend: "jsonl", path: join(env.root, "log") });
    const info = await log.startRun(found.flow.name, "prompt:1");
    await new Runner({
      log,
      flow: found.flow,
      runId: info.runId,
      registry: env.registry,
      params,
      ...(trigger === undefined ? {} : { trigger }),
    }).run();
    const state = await readState(log, info.runId);
    await log.close();
    return { input: recorded(env), endedStatus: state.endedStatus };
  }

  test("runs the worker once with the prompt unchanged and ends done", async () => {
    const env = await setup("done");
    const { input, endedStatus } = await runPrompt(env, { prompt: "say pong", cwd: env.root });
    expect(input.prompt).toBe("say pong");
    expect(input.cwd).toBe(env.root);
    expect(endedStatus).toBe("done");
  });

  test("a failing worker ends the flow failed", async () => {
    const env = await setup("model-error-other");
    const { endedStatus } = await runPrompt(env, { prompt: "p", cwd: env.root });
    expect(endedStatus).toBe("failed");
  });

  test("a trigger with a summary file appends the same event note as harness-radian", async () => {
    const env = await setup("done");
    const { input } = await runPrompt(env, { prompt: "p", cwd: env.root }, {
      summary: "/events/1/summary.md",
    } as TriggerView);
    expect(input.prompt).toBe(
      `p\n\n${EVENT_NOTE_TEMPLATE.replace("{files}", "summary: /events/1/summary.md")}`,
    );
  });
});

describe("harness-pi check", () => {
  test("passes with the default worker program", async () => {
    const root = await tempRoot();
    const registry = new PluginRegistry([createPiHarnessPlugin()], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
    });
    const checks = await registry.checks();
    expect(checks.find((item) => item.plugin === "harness-pi")?.ok).toBe(true);
  });
});

describe("harness-pi/agent step limit", () => {
  function registryWith(settings: Record<string, unknown>): PluginRegistry {
    return new PluginRegistry([createPiHarnessPlugin()], {
      home: ".",
      cwd: ".",
      store: new MemoryPluginStore({ root: "store" }),
      settings: { "harness-pi": settings },
    });
  }

  test("the key is harness-pi:<model> from --model, else the model setting", () => {
    const registry = registryWith({
      model: "opencode-go/deepseek-v4.1-flash",
      concurrency: { "opencode-go/deepseek-v4.1-flash": 2, "p/other": 1 },
    });
    expect(registry.stepLimit("harness-pi/agent", { args: ["--model", "p/other"] })).toEqual({
      key: "harness-pi:p/other",
      concurrent: 1,
    });
    expect(registry.stepLimit("harness-pi/agent", {})).toEqual({
      key: "harness-pi:opencode-go/deepseek-v4.1-flash",
      concurrent: 2,
    });
  });

  test("a model not in the map, or no model, has no limit", () => {
    const registry = registryWith({ concurrency: { "p/a": 2 } });
    expect(registry.stepLimit("harness-pi/agent", { args: ["--model", "p/b"] })).toBeUndefined();
    expect(registry.stepLimit("harness-pi/agent", {})).toBeUndefined();
    expect(registryWith({}).stepLimit("harness-pi/agent", { args: ["--model", "p/a"] })).toBeUndefined();
  });

  test("a count that is not a positive integer refuses the plugin at load", () => {
    expect(registryWith({ concurrency: { "p/a": 0 } }).names()).toEqual([]);
  });
});
