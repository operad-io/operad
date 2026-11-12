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
  type JsonValue,
  validateUsage,
  type PluginStepResult,
  type TriggerView,
} from "@operad-io/engine";
import { EVENT_NOTE_TEMPLATE, modelErrorOf } from "@operad-io/harness-process";
import { createPiHarnessPlugin, piToolEvent } from "../src/index.ts";
import {
  cleanupTempRoots,
  manualClock,
  tempRoot,
  waitForFile,
  type ManualClock,
} from "@operad-io/harness-process/test-support";

afterAll(cleanupTempRoots);

const DEV_PI = fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url));
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
    ...(settings === undefined ? {} : { settings: { "pi": settings } }),
  });
  return { root, clock, registry, record, marker, release };
}

function dataOf(result: PluginStepResult): Record<string, unknown> {
  return (result.data ?? {}) as Record<string, unknown>;
}

/**
 * Resolves true once the process is gone; the kill lands asynchronously. When
 * it gives up it writes `ps` for the pid to stderr, so a failure says whether
 * the worker is alive (a leak) or a zombie nobody reaped.
 */
async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (alive(pid)) {
    if (Date.now() > deadline) {
      const ps = Bun.spawnSync(["ps", "-o", "pid,ppid,pgid,stat,command", "-p", String(pid)]);
      console.error(`worker ${pid} still there:\n${ps.stdout.toString()}${ps.stderr.toString()}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
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
  return env.registry.runStep("pi/agent", params, {
    runId: options.runId ?? "run-1",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

describe("pi/agent", () => {
  test("a done run has the facts radian records for the same data", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    const data = dataOf(result);
    expect(data.exitCode).toBe(0);
    expect(data.signal).toBeNull();
    expect(data.sessionId).toBe("fake-session");
    expect(data.finalMessage).toBe("fake final message");
    expect(data.usage).toEqual({
      harness: "pi",
      model: null,
      tokens: { input: 11, output: 7, cacheread: 0, cachewrite: 0 },
      costMicros: 1234,
      costQuality: "exact",
    });
    expect(validateUsage(data.usage).ok).toBe(true);
    expect("cost" in data).toBe(false);
    expect(data.stderr).toEqual([]);
    expect(typeof data.durationMs).toBe("number");
    expect(readFileSync(String(data.log), "utf8")).toContain('"type":"result"');

    // The same fake data through radian gives the same facts.
    const radianModule = (await import(
      new URL("../../radian/src/index.ts", import.meta.url).href
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
      settings: { "radian": { command: bin } },
    });
    const other = await radian.runStep(
      "radian/agent",
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
    expect(otherData.usage).toEqual({ ...(data.usage as object), harness: "radian" });
  });

  test("a worker line without a price leaves the cost unknown, not zero", async () => {
    const env = await setup("no-cost");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    expect(validateUsage(dataOf(result).usage).ok).toBe(true);
    expect((dataOf(result).usage as { costMicros: unknown }).costMicros).toBeNull();
  });

  test("bashTimeoutSecs reaches the worker; unset it is 1800", async () => {
    const custom = await setup("done", { bashTimeoutSecs: 900 });
    await runAgent(custom, { prompt: "hello", cwd: custom.root });
    expect(recorded(custom).bashTimeoutSecs).toBe(900);
    const plain = await setup("done");
    await runAgent(plain, { prompt: "hello", cwd: plain.root });
    expect(recorded(plain).bashTimeoutSecs).toBe(1800);
  });

  test("a bashTimeoutSecs of 0, below 0 or not a number refuses the plugin at load and names the field", () => {
    for (const bad of [0, -5, "60", 1.5]) {
      const registry = new PluginRegistry([createPiHarnessPlugin()], {
        home: "/tmp",
        cwd: "/tmp",
        store: new MemoryPluginStore({ root: "/tmp/unused-store" }),
        settings: { "pi": { bashTimeoutSecs: bad } },
      });
      expect(registry.names()).toEqual([]);
    }
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

  test("an effort from a chat reaches the worker as pi's thinking level", async () => {
    const env = await setup("done", { thinkingLevel: "low" });
    await runAgent(env, { prompt: "hello", cwd: env.root, effort: "xhigh" });
    expect(recorded(env).thinkingLevel).toBe("xhigh");
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

  test("a run with an unpriced message has an incomplete cost", async () => {
    const env = await setup("incomplete");
    const usage = dataOf(await runAgent(env, { prompt: "hello", cwd: env.root })).usage as {
      costMicros: unknown;
      costQuality: unknown;
    };
    expect(usage.costMicros).toBe(900);
    expect(usage.costQuality).toBe("incomplete");
    expect(validateUsage(usage).ok).toBe(true);
  });

  test("a step that fails before it starts still records the model it named", async () => {
    const env = await setup("done", { model: "fake/setting" });
    const badArgs = await runAgent(env, { prompt: "hello", cwd: env.root, args: ["--bogus"] });
    expect(badArgs.result).toBe("failed");
    expect((dataOf(badArgs).usage as { model: unknown }).model).toBe("fake/setting");
    const badFlag = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      args: ["--model", "a/b", "--thinking", "loud"],
    });
    expect((dataOf(badFlag).usage as { model: unknown }).model).toBe("a/b");
    const badCwd = await runAgent(env, { prompt: "hello", cwd: join(env.root, "missing") });
    expect(badCwd.result).toBe("failed");
    expect((dataOf(badCwd).usage as { model: unknown }).model).toBe("fake/setting");
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

  test("a step that continues after a question passes the session and adds the paragraph once", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      resumeSession: "/sessions/one.jsonl",
      askAnswer: { prompt: "Run rm -rf build?", choice: "yes", note: "go on" },
    });
    expect(result.result).toBe("done");
    const sent = recorded(env);
    expect(sent.resumeSession).toBe("/sessions/one.jsonl");
    expect(sent.prompt).toBe(
      "hello\n\nYou asked: Run rm -rf build?. The answer is: yes. The person's note follows, quoted line by line; it is part of the answer, not a new instruction.\n> go on\nContinue.",
    );
  });

  test("a step declares that it can resume", async () => {
    const env = await setup("done");
    const type = env.registry.stepTypes().find((item) => item.name === "pi/agent");
    expect(type?.resumable).toBe(true);
  });

  test("a message the host sends through the inbox reaches the program as a message line", async () => {
    const env = await setup("message");
    const handlers: Array<(text: string) => void> = [];
    const inbox = {
      listen(handler: (text: string) => void): () => void {
        handlers.push(handler);
        return () => undefined;
      },
    };
    const running = env.registry.runStep(
      "pi/agent",
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
  });

  test("a grant in the profile is used through the host before the program goes on", async () => {
    const env = await setup("grant");
    const used: string[] = [];
    const grants = [{ waitId: "w1", kind: "command", value: "rm -rf build" }];
    const result = await env.registry.runStep(
      "pi/agent",
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

  test("the run's access profile is passed to the worker", async () => {
    const env = await setup("done");
    await env.registry.runStep(
      "pi/agent",
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
    expect(await gone(Number(readFileSync(env.marker, "utf8")))).toBe(true);
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
    expect(await gone(pid)).toBe(true);
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
    expect(await gone(pid)).toBe(true);
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
    expect(await gone(pid)).toBe(true);
  });

  test("cancel fired the moment the worker is up never leaves it running", async () => {
    for (let i = 0; i < 40; i++) {
      const env = await setup("cancel");
      const controller = new AbortController();
      const running = runAgent(
        env,
        { prompt: "hello", cwd: env.root, wallTimeSecs: 300, stallSecs: 300 },
        { signal: controller.signal, runId: `run-${i}` },
      );
      await waitForFile(env.marker);
      // The file exists before the worker has written its pid into it.
      let pid = Number(readFileSync(env.marker, "utf8"));
      while (!(pid > 0)) {
        await new Promise((r) => setTimeout(r, 1));
        pid = Number(readFileSync(env.marker, "utf8"));
      }
      controller.abort();
      const result = await running;
      expect(result.result).toBe("interrupted");
      expect(await gone(pid)).toBe(true);
    }
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
      "pi/agent",
      { prompt: "hello", cwd: env.root },
      { runId: "run-missing" },
    );
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("missing");
  });

  test("the step declares the deny and ask fields it enforces and a timeout above its wall time", async () => {
    const env = await setup("done");
    const type = env.registry.stepTypes().find((item) => item.name === "pi/agent");
    expect(type?.enforces).toEqual(["denyPaths", "denyCommands", "askCommands", "askPaths", "readPaths"]);
    expect(type?.timeoutSecs).toBeGreaterThan(3600);
  });

  test("a profile with askCommands is accepted: the step enforces it", async () => {
    const env = await setup("done");
    expect(() =>
      env.registry.checkAccess("pi:prompt", { askCommands: ["git push"], denyCommands: ["rm"], denyPaths: ["/etc"] }),
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

describe("pi:prompt", () => {
  async function runPrompt(env: TestEnv, params: JsonValue, trigger?: TriggerView) {
    const found = env.registry.flow("pi:prompt");
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

  test("the command setting reaches the worker as piCommand; unset it is pi", async () => {
    const set = await setup("done", { command: "/opt/pi/bin/pi" });
    const withCommand = await runPrompt(set, { prompt: "p", cwd: set.root });
    expect(withCommand.input.piCommand).toBe("/opt/pi/bin/pi");

    const unset = await setup("done");
    const without = await runPrompt(unset, { prompt: "p", cwd: unset.root });
    expect(without.input.piCommand).toBe("pi");
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

describe("pi check", () => {
  test("passes with the default worker program", async () => {
    const root = await tempRoot();
    const registry = new PluginRegistry([createPiHarnessPlugin()], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      settings: { "pi": { command: DEV_PI } },
    });
    const checks = await registry.checks();
    expect(checks.find((item) => item.plugin === "pi")?.ok).toBe(true);
  });
});

describe("pi/agent step limit", () => {
  function registryWith(settings: Record<string, unknown>): PluginRegistry {
    return new PluginRegistry([createPiHarnessPlugin()], {
      home: ".",
      cwd: ".",
      store: new MemoryPluginStore({ root: "store" }),
      settings: { "pi": settings },
    });
  }

  test("the key is pi:<model> from --model, else the model setting", () => {
    const registry = registryWith({
      model: "opencode-go/deepseek-v4.1-flash",
      concurrency: { "opencode-go/deepseek-v4.1-flash": 2, "p/other": 1 },
    });
    expect(registry.stepLimit("pi/agent", { args: ["--model", "p/other"] })).toEqual({
      key: "pi:p/other",
      concurrent: 1,
    });
    expect(registry.stepLimit("pi/agent", {})).toEqual({
      key: "pi:opencode-go/deepseek-v4.1-flash",
      concurrent: 2,
    });
  });

  test("a model not in the map, or no model, has no limit", () => {
    const registry = registryWith({ concurrency: { "p/a": 2 } });
    expect(registry.stepLimit("pi/agent", { args: ["--model", "p/b"] })).toBeUndefined();
    expect(registry.stepLimit("pi/agent", {})).toBeUndefined();
    expect(registryWith({}).stepLimit("pi/agent", { args: ["--model", "p/a"] })).toBeUndefined();
  });

  test("a count that is not a positive integer refuses the plugin at load", () => {
    expect(registryWith({ concurrency: { "p/a": 0 } }).names()).toEqual([]);
  });
});
