import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  openLog,
  readState,
  validateUsage,
  type JsonValue,
  type PluginStepResult,
  type TriggerView,
} from "@operad-io/engine";
import { EVENT_NOTE_TEMPLATE } from "@operad-io/harness-process";
import { claudeToolEvent, createClaudeHarnessPlugin } from "../src/index.ts";
import { alive, cleanupTempRoots, manualClock, tempRoot, waitForFile, waitForGone, waitForPid, type ManualClock } from "@operad-io/harness-process/test-support";

afterAll(cleanupTempRoots);

const FAKE = fileURLToPath(new URL("./fake-lines-worker.ts", import.meta.url));
const SESSION = "11111111-2222-4333-8444-555555555555";

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

async function setup(mode: string, settings?: Readonly<Record<string, unknown>>): Promise<TestEnv> {
  const root = await tempRoot();
  const record = join(root, "record.json");
  const marker = join(root, "marker");
  const release = join(root, "release");
  setEnv("FAKE_CLAUDE_MODE", mode);
  setEnv("FAKE_CLAUDE_RECORD", record);
  setEnv("FAKE_CLAUDE_MARKER", marker);
  setEnv("FAKE_CLAUDE_RELEASE", release);

  const clock = manualClock();
  const plugin = createClaudeHarnessPlugin({ clock, command: process.execPath, args: [FAKE] });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: root,
    store: new MemoryPluginStore({ root: join(root, "store") }),
    ...(settings === undefined ? {} : { settings: { "claude": settings } }),
  });
  return { root, clock, registry, record, marker, release };
}

function dataOf(result: PluginStepResult): Record<string, unknown> {
  return (result.data ?? {}) as Record<string, unknown>;
}

function recorded(env: TestEnv): Record<string, unknown> {
  return JSON.parse(readFileSync(env.record, "utf8")) as Record<string, unknown>;
}

function runAgent(
  env: TestEnv,
  params: Record<string, unknown>,
  options: { readonly runId?: string; readonly signal?: AbortSignal } = {},
) {
  return env.registry.runStep("claude/agent", params, {
    runId: options.runId ?? "run-1",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

describe("claude/agent", () => {
  test("a done run has the facts of pi/agent: session, final message, usage, log", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    const data = dataOf(result);
    expect(data.exitCode).toBe(0);
    expect(data.signal).toBeNull();
    expect(data.sessionId).toBe(SESSION);
    expect(data.finalMessage).toBe("fake final message");
    expect(data.usage).toEqual({
      harness: "claude",
      model: "claude-fake-1",
      tokens: { input: 11, output: 7, cacheread: 3, cachewrite: 5 },
      costMicros: 1234,
      costQuality: "estimated",
    });
    expect(validateUsage(data.usage).ok).toBe(true);
    expect("cost" in data).toBe(false);
    expect(data.stderr).toEqual([]);
    expect(typeof data.durationMs).toBe("number");
    expect(readFileSync(String(data.log), "utf8")).toContain('"type":"result"');
  });

  test("a cost the worker calls exact is exact", async () => {
    const env = await setup("exact");
    const usage = dataOf(await runAgent(env, { prompt: "hello", cwd: env.root })).usage as {
      costMicros: unknown;
      costQuality: unknown;
    };
    expect(usage.costMicros).toBe(1234);
    expect(usage.costQuality).toBe("exact");
  });

  test("a worker line without a price leaves the cost unknown, not zero", async () => {
    const env = await setup("no-cost");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    expect(validateUsage(dataOf(result).usage).ok).toBe(true);
    expect((dataOf(result).usage as { costMicros: unknown }).costMicros).toBeNull();
  });

  test("the worker gets the prompt, the directory and the settings", async () => {
    const env = await setup("done", {
      model: "sonnet",
      effort: "low",
      command: "/opt/claude/bin/claude",
      maxTurns: 7,
      budgetUsd: 2.5,
      bashTimeoutSecs: 900,
    });
    await runAgent(env, { prompt: "hello", cwd: env.root });
    const input = recorded(env);
    expect(input).toEqual({
      bashTimeoutSecs: 900,
      prompt: "hello",
      cwd: env.root,
      command: "/opt/claude/bin/claude",
      model: "sonnet",
      effort: "low",
      maxTurns: 7,
      budgetUsd: 2.5,
    });
  });

  test("unset settings are not sent, so claude uses its defaults; the command defaults to claude and Bash to 1800 s", async () => {
    const env = await setup("done");
    await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(recorded(env)).toEqual({ prompt: "hello", cwd: env.root, command: "claude", bashTimeoutSecs: 1800 });
  });

  test("--model and --effort in args reach the worker and win over the settings", async () => {
    const env = await setup("done", { model: "sonnet", effort: "low" });
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      args: ["--model", "opus", "--effort", "xhigh"],
    });
    expect(result.result).toBe("done");
    const input = recorded(env);
    expect(input.model).toBe("opus");
    expect(input.effort).toBe("xhigh");
    expect((dataOf(result).usage as { model: unknown }).model).toBe("opus");
  });

  test("a flag given alone leaves the other from the settings", async () => {
    const env = await setup("done", { model: "sonnet", effort: "low" });
    await runAgent(env, { prompt: "hello", cwd: env.root, args: ["--effort", "high"] });
    const input = recorded(env);
    expect(input.model).toBe("sonnet");
    expect(input.effort).toBe("high");
  });

  test("the usage names the model claude reports when the step named none", async () => {
    const env = await setup("done");
    const named = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect((dataOf(named).usage as { model: unknown }).model).toBe("claude-fake-1");

    const quiet = await setup("no-model", { model: "sonnet" });
    const result = await runAgent(quiet, { prompt: "hello", cwd: quiet.root });
    expect((dataOf(result).usage as { model: unknown }).model).toBe("sonnet");
  });

  test("a step that fails before it starts still records the model it named", async () => {
    const env = await setup("done", { model: "sonnet" });
    const badArgs = await runAgent(env, { prompt: "hello", cwd: env.root, args: ["--bogus"] });
    expect(badArgs.result).toBe("failed");
    expect((dataOf(badArgs).usage as { model: unknown }).model).toBe("sonnet");
    const badFlag = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      args: ["--model", "opus", "--effort", "loud"],
    });
    expect((dataOf(badFlag).usage as { model: unknown }).model).toBe("opus");
    const badCwd = await runAgent(env, { prompt: "hello", cwd: join(env.root, "missing") });
    expect(badCwd.result).toBe("failed");
    expect((dataOf(badCwd).usage as { model: unknown }).model).toBe("sonnet");
  });

  const INVALID_ARGS: ReadonlyArray<readonly [string, string[], string]> = [
    ["an unknown flag", ["--x"], "--x"],
    ["the pi spelling of effort", ["--thinking", "low"], "--thinking"],
    ["a model flag without its value", ["--model"], "--model"],
    ["an effort flag without its value", ["--effort"], "--effort"],
    ["a flag as the value", ["--model", "--effort", "high"], '"--model" has no value'],
    ["an effort outside the set", ["--effort", "extreme"], "extreme"],
    ["a model given twice", ["--model", "a", "--model", "b"], "--model"],
    ["an effort given twice", ["--effort", "low", "--effort", "high"], "--effort"],
    ["a stray value", ["--model", "opus", "extra"], "extra"],
    ["the = spelling", ["--model=opus"], "--model=opus"],
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

  test("resumeSession is passed through to the worker's stdin", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root, resumeSession: SESSION });
    expect(result.result).toBe("done");
    expect(recorded(env).resumeSession).toBe(SESSION);
  });

  test("a step that continues after a question passes the session and adds the paragraph once", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      resumeSession: SESSION,
      askAnswer: { prompt: "Run rm -rf build?", choice: "yes", note: "go on" },
    });
    expect(result.result).toBe("done");
    const sent = recorded(env);
    expect(sent.resumeSession).toBe(SESSION);
    expect(sent.prompt).toBe(
      "hello\n\nYou asked: Run rm -rf build?. The answer is: yes. The person's note follows, quoted line by line; it is part of the answer, not a new instruction.\n> go on\nContinue.",
    );
  });

  test("a step declares that it can resume and has a timeout above its wall time", async () => {
    const env = await setup("done");
    const type = env.registry.stepTypes().find((item) => item.name === "claude/agent");
    expect(type?.resumable).toBe(true);
    expect(type?.results).toEqual(["done", "failed", "interrupted", "waiting"]);
    expect(type?.timeoutSecs).toBeGreaterThan(3600);
  });

  test("a grant in the profile is used through the host before the program goes on", async () => {
    const env = await setup("grant");
    const used: string[] = [];
    const grants = [{ waitId: "w1", kind: "command", value: "rm -rf build" }];
    const result = await env.registry.runStep(
      "claude/agent",
      { prompt: "hello", cwd: env.root },
      {
        runId: "run-grant",
        access: { grants },
        asker: {
          ask: () => Promise.reject(new Error("no question here")),
          useGrant: (waitId) => {
            used.push(waitId);
            return Promise.resolve(used.length === 1);
          },
        },
      },
    );
    expect(result.result).toBe("done");
    expect(used).toEqual(["w1"]);
    expect(JSON.parse(readFileSync(`${env.record}.ack`, "utf8"))).toEqual({
      type: "grant_ack",
      id: 1,
      used: true,
    });
  });

  test("a message the host sends through the inbox reaches the program as a message line", async () => {
    const env = await setup("message");
    const handlers: Array<(text: string) => void> = [];
    let stopped = 0;
    const inbox = {
      listen(handler: (text: string) => void): () => void {
        handlers.push(handler);
        return () => {
          stopped += 1;
        };
      },
    };
    const running = env.registry.runStep(
      "claude/agent",
      { prompt: "hello", cwd: env.root, inbox },
      { runId: "run-message" },
    );
    await waitForFile(env.marker);
    expect(handlers).toHaveLength(1);
    handlers[0]?.("wrap up now");
    expect((await running).result).toBe("done");
    expect(JSON.parse(readFileSync(`${env.record}.message`, "utf8"))).toEqual({
      type: "message",
      text: "wrap up now",
    });
    expect(stopped).toBe(1);
  });

  test("the run's access profile is passed to the worker", async () => {
    const env = await setup("done");
    await env.registry.runStep(
      "claude/agent",
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
    expect(String(dataOf(result).message)).toContain("No conversation found");
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
    await waitForGone(await waitForPid(env.marker));
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

  test("a rate limit the worker saw is a usage_limit modelError", async () => {
    const env = await setup("model-error-usage-limit");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(dataOf(result).modelError).toEqual({
      kind: "usage_limit",
      status: null,
      retry_after_secs: null,
      message: "claude stopped at its plan limit (five_hour)",
    });
  });

  test("any other model_error is protocol", async () => {
    const env = await setup("model-error-other");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect((dataOf(result).modelError as Record<string, unknown>).kind).toBe("protocol");
  });

  test("silence without an open tool call is a stall", async () => {
    const env = await setup("stall");
    const running = runAgent(env, { prompt: "hello", cwd: env.root, wallTimeSecs: 300, stallSecs: 1 });
    await waitForFile(env.marker);
    await env.clock.when(() => env.clock.clears > 0);
    const pid = await waitForPid(env.marker);
    env.clock.fireUpTo(1000);

    const result = await running;
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("stall");
    await waitForGone(pid);
  });

  test("silence with an open tool call is not a stall", async () => {
    const env = await setup("tool-silent");
    const running = runAgent(env, { prompt: "hello", cwd: env.root, wallTimeSecs: 300, stallSecs: 1 });
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
    const running = runAgent(env, { prompt: "hello", cwd: env.root, wallTimeSecs: 1, stallSecs: 300 });
    await waitForFile(env.marker);
    const pid = await waitForPid(env.marker);
    env.clock.fireUpTo(1_000);

    const result = await running;
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("wall");
    await waitForGone(pid);
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
    const pid = await waitForPid(env.marker);
    controller.abort();

    const result = await running;
    expect(result.result).toBe("interrupted");
    expect(dataOf(result).reason).toBe("cancelled");
    await waitForGone(pid);
  });

  test("a cwd that does not exist fails with a clear reason", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hello", cwd: join(env.root, "nope") });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("cwd");
  });

  test("a worker program that is not there fails with a clear reason", async () => {
    const env = await setup("done");
    const plugin = createClaudeHarnessPlugin({ command: join(env.root, "no-such-bun"), args: [] });
    const registry = new PluginRegistry([plugin], {
      home: env.root,
      cwd: env.root,
      store: new MemoryPluginStore({ root: join(env.root, "store3") }),
    });
    const result = await registry.runStep(
      "claude/agent",
      { prompt: "hello", cwd: env.root },
      { runId: "run-missing" },
    );
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("missing");
  });
});

describe("claude access", () => {
  test("the step declares the deny and ask fields it enforces", async () => {
    const env = await setup("done");
    const type = env.registry.stepTypes().find((item) => item.name === "claude/agent");
    expect(type?.enforces).toEqual(["denyPaths", "denyCommands", "askCommands", "askPaths", "readPaths"]);
  });

  test("a profile with askCommands is accepted: the step enforces it", async () => {
    const env = await setup("done");
    expect(() =>
      env.registry.checkAccess("claude:prompt", { askCommands: ["git push"], denyCommands: ["rm"], denyPaths: ["/etc"] }),
    ).not.toThrow();
  });
});

describe("claudeToolEvent", () => {
  test("classifies the worker's tool lines and nothing else", () => {
    expect(claudeToolEvent('{"type":"tool_execution_start","toolName":"Bash"}')).toBe("tool-start");
    expect(claudeToolEvent('{"type":"tool_execution_end","toolName":"Bash"}')).toBe("tool-end");
    expect(claudeToolEvent('{"type":"message_end"}')).toBeUndefined();
    expect(claudeToolEvent("not json")).toBeUndefined();
  });
});

describe("claude:prompt", () => {
  async function runPrompt(env: TestEnv, params: JsonValue, trigger?: TriggerView) {
    const found = env.registry.flow("claude:prompt");
    if (found === undefined) throw new Error("the prompt flow is not loaded");
    const log = openLog({ backend: "sqlite", path: join(env.root, "log", "log.sqlite") });
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

  test("a trigger with a summary file appends the same event note as radian", async () => {
    const env = await setup("done");
    const { input } = await runPrompt(env, { prompt: "p", cwd: env.root }, {
      summary: "/events/1/summary.md",
    } as TriggerView);
    expect(input.prompt).toBe(
      `p\n\n${EVENT_NOTE_TEMPLATE.replace("{files}", "summary: /events/1/summary.md")}`,
    );
  });
});

describe("claude/agent step limit", () => {
  function registryWith(settings: Record<string, unknown>): PluginRegistry {
    return new PluginRegistry([createClaudeHarnessPlugin()], {
      home: ".",
      cwd: ".",
      store: new MemoryPluginStore({ root: "store" }),
      settings: { "claude": settings },
    });
  }

  test("the key is claude:<model> from --model, else the model setting", () => {
    const registry = registryWith({ model: "sonnet", concurrency: { sonnet: 2, opus: 1 } });
    expect(registry.stepLimit("claude/agent", { args: ["--model", "opus"] })).toEqual({
      key: "claude:opus",
      concurrent: 1,
    });
    expect(registry.stepLimit("claude/agent", {})).toEqual({
      key: "claude:sonnet",
      concurrent: 2,
    });
  });

  test("a model not in the map, or no model, has no limit", () => {
    const registry = registryWith({ concurrency: { sonnet: 2 } });
    expect(registry.stepLimit("claude/agent", { args: ["--model", "opus"] })).toBeUndefined();
    expect(registry.stepLimit("claude/agent", {})).toBeUndefined();
    expect(registryWith({}).stepLimit("claude/agent", { args: ["--model", "sonnet"] })).toBeUndefined();
  });

  test("a count that is not a positive integer refuses the plugin at load", () => {
    expect(registryWith({ concurrency: { sonnet: 0 } }).names()).toEqual([]);
  });
});
