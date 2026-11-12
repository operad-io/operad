import { radianLogLine } from "../src/index.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  AccessError,
  MemoryPluginStore,
  PluginError,
  PluginRegistry,
  Runner,
  definePlugin,
  openLog,
  readState,
  type PluginStepResult,
  type StepContext,
  type JsonValue,
  validateUsage,
  type TriggerView,
} from "@operad-io/engine";
import {
  createRadianHarnessPlugin,
  radianModel,
  radianRefusal,
  EVENT_NOTE_TEMPLATE,
  type RadianHarnessSettings,
} from "../src/index.ts";
import { degradedAskRequest, runAgent as runProcess } from "@operad-io/harness-process";
import {
  cleanupTempRoots,
  fakeRadian,
  fakeRadianNamed,
  processesUnder,
  stopTestProcesses,
  tempRoot,
  tempRoots,
  waitUntil,
} from "./support.ts";
import { alive, manualClock, waitForFile, type ManualClock } from "@operad-io/harness-process/test-support";

afterAll(cleanupTempRoots);

const restores: Array<() => void> = [];

afterEach(async () => {
  // Every test stops the group it started, even when an assertion failed
  // before the step returned and its own stop ran.
  await stopTestProcesses();
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
  readonly release: string;
}

async function setup(
  mode: string,
  settings: RadianHarnessSettings = {},
  registrySettings?: Readonly<Record<string, unknown>>,
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
  const release = join(root, "release");
  setEnv("FAKE_RADIAN_RECORD", record);
  setEnv("FAKE_RADIAN_MARKER", marker);
  setEnv("FAKE_RADIAN_CALLS", calls);
  setEnv("FAKE_RADIAN_RELEASE", release);

  const clock = manualClock();
  const plugin = createRadianHarnessPlugin({ clock, ...settings });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: root,
    store: new MemoryPluginStore({ root: join(root, "store") }),
    ...(registrySettings === undefined ? {} : { settings: registrySettings }),
  });
  return { root, clock, registry, record, marker, calls, release };
}

function dataOf(result: PluginStepResult): Record<string, unknown> {
  return (result.data ?? {}) as Record<string, unknown>;
}

function runAgent(
  env: TestEnv,
  params: Record<string, unknown>,
  options: { readonly runId?: string; readonly signal?: AbortSignal } = {},
) {
  return env.registry.runStep("radian/agent", params, {
    runId: options.runId ?? "run-1",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

describe("radian/agent", () => {
  test("tool lines carry the command summary, the duration and an error's first line", async () => {
    const times = [1_000, 73_000];
    const env = await setup("tool-detail", { now: () => times.shift() ?? 0 });
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    const text = await Bun.file(String(dataOf(result).log)).text();
    const records = text
      .split("\n")
      .filter((l) => l.includes("tool_execution"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records[0]).toEqual({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "Bash",
      at: 1_000,
      input: "token=*** make test",
    });
    expect(records[1]).toMatchObject({ type: "tool_execution_end", durationMs: 72_000, isError: true, error: "boom" });
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("SECRET OUTPUT");
  });

  test("a secret of the operad store is masked in the logged command", () => {
    const line = JSON.stringify({ type: "ToolExecutionStarted", toolCallId: "t1", toolName: "Bash", input: { command: "curl store-secret-9" } });
    const out = radianLogLine(line, () => 5, new Map(), "/work", {}, ["store-secret-9"]);
    expect(JSON.parse(out)).toMatchObject({ input: "curl ***" });
  });

  test("a multi-line command keeps its lines in the logged summary", () => {
    const line = JSON.stringify({ event: "ToolExecutionStarted", data: { call_id: "c1", name: "shell", arguments: { command: "python3 - <<'EOF'\nprint(1)\n\nEOF" } } });
    expect(JSON.parse(radianLogLine(line, () => 5, new Map(), "/work")).input).toBe("python3 - <<'EOF'\nprint(1)\n\nEOF");
  });

  test("a tool call the access profile refuses is only said to be denied in the log", async () => {
    const line = JSON.stringify({ type: "ToolExecutionStarted", toolCallId: "t1", toolName: "Read", input: { file_path: "/secrets/key" } });
    const out = radianLogLine(line, () => 5, new Map(), "/work", { denyPaths: ["/secrets"] });
    expect(JSON.parse(out)).toMatchObject({ type: "tool_execution_start", input: "Read denied by the access profile (rule: /secrets)" });
    expect(out).not.toContain("/secrets/key");
  });

  test("a denied call's settled error is not logged", async () => {
    const open = new Map();
    const profile = { denyPaths: ["/secrets"] };
    radianLogLine(JSON.stringify({ type: "ToolExecutionStarted", toolCallId: "t1", toolName: "Read", input: { file_path: "/secrets/key" } }), () => 5, open, "/work", profile);
    const end = radianLogLine(JSON.stringify({ type: "ToolExecutionSettled", toolCallId: "t1", toolName: "Read", isError: true, error: "path /secrets/key denied" }), () => 9, open, "/work", profile);
    expect(JSON.parse(end)).toMatchObject({ type: "tool_execution_end", isError: true });
    expect(end).not.toContain("/secrets/key");
  });

  test("radian's nested failure result logs isError and its first error line", async () => {
    const open = new Map();
    radianLogLine(JSON.stringify({ event: "ToolExecutionStarted", data: { call_id: "c1", name: "shell", arguments: { command: "false" } } }), () => 5, open, "/work");
    const end = radianLogLine(
      JSON.stringify({ event: "ToolExecutionSettled", data: { call_id: "c1", result: { call_id: "c1", is_error: true, content: [{ text: { text: "exit code: 1\nSECRET OUTPUT" } }] } } }),
      () => 9,
      open,
      "/work",
    );
    expect(JSON.parse(end)).toMatchObject({ type: "tool_execution_end", toolCallId: "c1", toolName: "shell", isError: true, durationMs: 4, error: "exit code: 1" });
    expect(end).not.toContain("SECRET OUTPUT");
  });

  test("radian's own tool names are judged by the access profile: shell, patch, glob, list, other path tools", () => {
    const profile = { denyPaths: ["/secrets"], denyCommands: ["rm"] };
    const start = (name: string, args: unknown): string =>
      String(JSON.parse(radianLogLine(JSON.stringify({ event: "ToolExecutionStarted", data: { call_id: "c", name, arguments: args } }), () => 1, new Map(), "/work", profile)).input);
    expect(start("shell", { command: "cat /secrets/key" })).toBe("shell denied by the access profile (rule: /secrets)");
    expect(start("shell", { command: "rm -rf build" })).toBe("shell denied by the access profile (rule: rm)");
    expect(start("patch", { path: "/secrets/key", old: "a", new: "b" })).toBe("patch denied by the access profile (rule: /secrets)");
    expect(start("glob", { pattern: "/secrets/**" })).toBe("glob denied by the access profile (rule: /secrets)");
    expect(start("list", { path: "/secrets" })).toBe("list denied by the access profile (rule: /secrets)");
    expect(start("git_diff", { path: "/secrets/key" })).toBe("git_diff denied by the access profile (rule: /secrets)");
    expect(start("shell", { command: "make test" })).toBe("make test");
    expect(start("patch", { path: "src/a.ts", old: "x", new: "y" })).toBe("src/a.ts");
    expect(start("git_diff", { path: "src/a.ts" })).toBe("src/a.ts");
  });

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
    expect(data.usage).toEqual({
      harness: "radian",
      model: null,
      tokens: { input: 11, output: 7, cacheread: 0, cachewrite: 0 },
      costMicros: 1234,
      costQuality: "exact",
    });
    expect(validateUsage(data.usage).ok).toBe(true);
    // The old fields are never written.
    expect("cost" in data).toBe(false);

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
    expect(validateUsage(dataOf(result).usage).ok).toBe(true);
    expect((dataOf(result).usage as { costMicros: unknown }).costMicros).toBeNull();
  });

  test("an incomplete or estimated cost says so in the usage", async () => {
    for (const quality of ["incomplete", "estimated"] as const) {
      const env = await setup(quality);
      const usage = dataOf(await runAgent(env, { prompt: "hello", cwd: env.root })).usage as {
        costMicros: unknown;
        costQuality: unknown;
      };
      expect(usage.costMicros).toBe(900);
      expect(usage.costQuality).toBe(quality);
      expect(validateUsage(usage).ok).toBe(true);
    }
  });

  test("a model that already names its provider is not prefixed again", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      args: ["--provider", "p", "--model", "p/m"],
    });
    expect((dataOf(result).usage as { model: unknown }).model).toBe("p/m");
    expect(radianModel(["--provider", "p", "--model", "p/m"])).toBe("p/m");
    expect(radianModel(["--provider", "p", "--model", "m"])).toBe("p/m");
    expect(radianModel(["--provider", "p"])).toBeUndefined();
  });

  test("the usage names the model as <provider>/<model> when the step names it", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      args: ["--provider", "opencode-go", "--model", "deepseek-v4.1-flash"],
    });
    expect((dataOf(result).usage as { model: unknown }).model).toBe("opencode-go/deepseek-v4.1-flash");
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

  test("operad's tools are given to radian as an MCP config that starts the tools program with the home", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      operadTools: { home: "/operad/home" },
    });
    expect(result.result).toBe("done");
    const record = JSON.parse(readFileSync(env.record, "utf8")) as {
      readonly argv: readonly string[];
    };
    const file = record.argv[record.argv.indexOf("--mcp-config") + 1];
    expect(file).toBeDefined();
    const config = JSON.parse(readFileSync(String(file), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = config.mcpServers["operad"];
    expect(server?.args.slice(-2)).toEqual(["--home", "/operad/home"]);
    expect(server?.args[0]).toMatch(/mcp\/src\/stdio\.ts$/);
    expect(server?.env["OPERAD_HOME"]).toBe("/operad/home");
  });

  test("without operadTools radian gets no MCP config", async () => {
    const env = await setup("done");
    await runAgent(env, { prompt: "hello", cwd: env.root });
    const record = JSON.parse(readFileSync(env.record, "utf8")) as {
      readonly argv: readonly string[];
    };
    expect(record.argv).not.toContain("--mcp-config");
  });

  test("a step that continues after a question passes the session and adds the paragraph", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      resumeSession: "session-7",
      askAnswer: { prompt: "Run it?", choice: "yes" },
    });
    expect(result.result).toBe("done");
    const record = JSON.parse(readFileSync(env.record, "utf8")) as {
      readonly argv: readonly string[];
    };
    expect(record.argv[record.argv.indexOf("--resume") + 1]).toBe("session-7");
    expect(record.argv[record.argv.indexOf("-p") + 1]).toBe(
      "hello\n\nYou asked: Run it?. The answer is: yes. Continue.",
    );
    const type = env.registry.stepTypes().find((item) => item.name === "radian/agent");
    expect(type?.resumable).toBe(true);
  });

  test("a resumed run that answers with another session fails as session_missing", async () => {
    const env = await setup("done");
    setEnv("FAKE_RADIAN_NEW_SESSION", "1");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root, resumeSession: "session-7" });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("session_missing");
    expect(String(dataOf(result).message)).toContain("session-7");
    // Without --resume a fresh session is what was asked for.
    const fresh = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(fresh.result).toBe("done");
  });

  test("a one-time permission is refused before radian runs, naming radian", async () => {
    const env = await setup("done");
    const result = await env.registry.runStep(
      "radian/agent",
      { prompt: "hello", cwd: env.root },
      {
        runId: "run-grant",
        access: { grants: [{ waitId: "w1", kind: "command", value: "rm -rf build" }] },
      },
    );
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("grant_unsupported");
    expect(String(dataOf(result).message)).toContain("radian cannot enforce a one-time permission");
    expect(existsSync(env.record)).toBe(false);
  });

  describe("a profile with rules", () => {
    async function configOf(access: Record<string, JsonValue> | undefined) {
      const env = await setup("done");
      await env.registry.runStep(
        "radian/agent",
        { prompt: "hi", cwd: env.root },
        { runId: "run-ro", ...(access === undefined ? {} : { access }) },
      );
      const record = JSON.parse(readFileSync(env.record, "utf8")) as { readonly argv: readonly string[] };
      const at = record.argv.indexOf("--config");
      return at < 0 ? undefined : readFileSync(String(record.argv[at + 1]), "utf8");
    }

    test("radian is given a config that runs the profile's hook before every tool call", async () => {
      const text = await configOf({ readOnly: true });
      expect(text).toContain("[[hooks.PreToolUse]]");
      expect(text).toContain('matcher = "*"');
      expect(text).toMatch(/hook\.ts/);
    });

    test("a profile with no rules, and no profile, change nothing", async () => {
      expect(await configOf({})).toBeUndefined();
      expect(await configOf(undefined)).toBeUndefined();
    });

    test("radianRefusal lets a reading command and a read through", () => {
      expect(radianRefusal({ readOnly: true }, "shell", { command: "git status | head" }, "/work")).toBeUndefined();
      expect(radianRefusal({ readOnly: true }, "read", { path: "src/a.ts" }, "/work")).toBeUndefined();
      expect(radianRefusal({ readOnly: true }, "write", { path: "src/a.ts" }, "/work")).toContain("this chat is read-only here");
      expect(radianRefusal({ readOnly: true }, "operad__list", { type: "task" }, "/work")).toBeUndefined();
      expect(radianRefusal({}, "write", { path: "src/a.ts" }, "/work")).toBeUndefined();
    });
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

  test("a Result record's model_error is passed through as data", async () => {
    const env = await setup("model-error-unavailable");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });

    expect(result.result).toBe("failed");
    expect(dataOf(result).modelError).toEqual({
      kind: "unavailable",
      status: 429,
      retry_after_secs: 30,
    });
  });

  test("a run without a model_error carries no modelError", async () => {
    const env = await setup("exit1");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect("modelError" in dataOf(result)).toBe(false);
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
    // The group is signaled asynchronously: wait for the pid to go.
    await waitUntil(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });

  test("an open tool call pauses the stall timer until it settles", async () => {
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
    expect(dataOf(result).exitCode).toBe(0);
  });

  test("the wall limit still stops a run while a tool call is open", async () => {
    const env = await setup("tool-wall");
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
    await waitUntil(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });

  test("settings.command is the executable that runs", async () => {
    const env = await setup("done", {}, {
      "radian": { command: "custom-radian" },
    });
    await fakeRadianNamed(env.root, "custom-radian");
    unlinkSync(join(env.root, "bin", "radian"));

    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
  });

  test("settings supply the stall limit", async () => {
    const env = await setup("stall", {}, {
      "radian": { wallTimeSecs: 300, stallSecs: 1 },
    });
    const running = runAgent(env, { prompt: "hello", cwd: env.root });

    await waitForFile(env.marker);
    env.clock.fireUpTo(1_000);
    const result = await running;
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("stall");
  });

  test("a step parameter overrides a settings limit", async () => {
    const env = await setup("stall", {}, {
      "radian": { wallTimeSecs: 300, stallSecs: 1 },
    });
    const controller = new AbortController();
    const running = runAgent(
      env,
      { prompt: "hello", cwd: env.root, stallSecs: 300 },
      { signal: controller.signal },
    );

    await waitForFile(env.marker);
    expect(env.clock.fireUpTo(2_000)).toBe(0);
    controller.abort();
    expect((await running).result).toBe("interrupted");
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
    await waitUntil(() => !alive(pids.pid));
    expect(alive(pids.pid)).toBe(false);
    if (typeof pids.child === "number") {
      await waitUntil(() => !alive(pids.child));
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

describe("radian:prompt", () => {
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
    const found = env.registry.flow("radian:prompt");
    if (found === undefined) throw new Error("the prompt flow is not loaded");
    const log = openLog({
      backend: "sqlite",
      path: join(env.root, "log", "log.sqlite"),
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

describe("radian check", () => {
  test("passes when radian is on PATH", async () => {
    const env = await setup("done");
    const [check] = await env.registry.checks();
    expect(check?.plugin).toBe("radian");
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
    expect(check?.plugin).toBe("radian");
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
      "radian/agent",
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

test("the guard sees a process whose command line names a temp directory", async () => {
  const root = await tempRoot();
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", "await Bun.sleep(30000)", root],
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    expect(processesUnder([root])).toContain(child.pid);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  expect(processesUnder([root])).toEqual([]);
});

test("no process started by this file's tests is left alive", () => {
  // The scratch directories are unique to this test file, so a live command
  // line that names one is a sentinel or fake radian this file started.
  expect(processesUnder(tempRoots())).toEqual([]);
});

test("a marker wait survives a directory that appears after it starts", async () => {
  // No watch can be armed on a directory that is not there yet, so only the
  // fallback look can find the marker; the same look covers an event the
  // platform dropped while the machine was loaded.
  const root = await tempRoot();
  const directory = join(root, "late");
  const marker = join(directory, "marker");
  const waiting = waitForFile(marker);

  await mkdir(directory, { recursive: true });
  writeFileSync(marker, String(process.pid));
  await waiting;

  expect(existsSync(marker)).toBe(true);
});

describe("radian/agent step limit", () => {
  function registryWith(settings: Record<string, unknown>): PluginRegistry {
    return new PluginRegistry([createRadianHarnessPlugin({})], {
      home: ".",
      cwd: ".",
      store: new MemoryPluginStore({ root: "store" }),
      settings: { "radian": settings },
    });
  }

  test("the key is radian:<provider>/<model> from the step's args", () => {
    const registry = registryWith({ concurrency: { "opencode-go/deepseek-v4.1-flash": 2 } });
    expect(
      registry.stepLimit("radian/agent", {
        args: ["--provider", "opencode-go", "--model", "deepseek-v4.1-flash"],
      }),
    ).toEqual({ key: "radian:opencode-go/deepseek-v4.1-flash", concurrent: 2 });
  });

  test("a model not in the map, or no --model, has no limit", () => {
    const registry = registryWith({ concurrency: { "p/a": 2 } });
    expect(
      registry.stepLimit("radian/agent", { args: ["--provider", "p", "--model", "b"] }),
    ).toBeUndefined();
    expect(registry.stepLimit("radian/agent", { args: ["--provider", "p"] })).toBeUndefined();
    expect(registry.stepLimit("radian/agent", {})).toBeUndefined();
  });

  test("the setting is declared with the default {}", () => {
    const registry = registryWith({});
    expect(registry.settingsFor("radian").concurrency).toEqual({});
  });
});

/**
 * radian is the degraded harness for questions (`operad-contract.md` decision
 * 6): no hook sees its tool calls, so it cannot enforce a one-time permission,
 * and a question it asks is refused once the grace passes instead of waiting
 * for a late answer. radian itself writes no question today; these tests ask
 * through a probe step that declares what radian's step declares.
 */
describe("radian: a question is reject_once", () => {
  const radian = createRadianHarnessPlugin().steps.find((step) => step.name === "agent");
  if (radian === undefined) throw new Error("radian has no agent step");

  type Run = (ctx: StepContext, params: unknown) => Promise<PluginStepResult>;

  function probe(ask: Run) {
    return definePlugin({
      name: "probe",
      kind: "harness",
      version: "0.0.0",
      steps: [{ name: "agent", results: radian?.results ?? [], grants: radian?.grants, resumable: radian?.resumable, run: ask }],
    });
  }

  async function registryOf(run: Run) {
    const root = await tempRoot();
    return new PluginRegistry([probe(run)], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
    });
  }

  test("radian declares no `waiting` result and no grants: nothing can resume a call", () => {
    expect(radian.results).toEqual(["done", "failed", "interrupted"]);
    expect(radian.grants).toBe(false);
  });

  test("a grace that passes is a refusal: the step goes on with rejected true and never ends waiting", async () => {
    const asked: unknown[] = [];
    const registry = await registryOf(async (ctx) => {
      const answer = await ctx.ask(degradedAskRequest("Run git push?"));
      return { result: "done", data: { rejected: answer.rejected === true } };
    });
    const result = await registry.runStep(
      "probe/agent",
      {},
      {
        runId: "run-degraded",
        asker: {
          ask: (request) => {
            asked.push(request);
            return Promise.resolve({ kind: "timeout", waitId: "w", prompt: request.prompt, choices: request.choices ?? [] });
          },
          useGrant: () => Promise.resolve(false),
        },
      },
    );
    expect(result).toEqual({ result: "done", data: { rejected: true } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ onTimeout: "reject_once" });
    expect(asked[0]).not.toHaveProperty("resume");
  });

  test("a question that would wait for a late answer is refused: radian has no `waiting` result", async () => {
    const registry = await registryOf(async (ctx) => {
      await ctx.ask({ prompt: "Run git push?", choices: ["allow_once", "reject_once"] });
      return { result: "done" };
    });
    let error: unknown;
    try {
      await registry.runStep("probe/agent", {}, { runId: "run-waiting", asker: { ask: () => Promise.reject(new Error("nobody is asked")), useGrant: () => Promise.resolve(false) } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginError);
    expect(String((error as Error).message)).toContain('onTimeout "waiting"');
  });

  test("a question that offers a one-time permission is refused before anyone is asked", async () => {
    const asked: unknown[] = [];
    const registry = await registryOf(async (ctx) => {
      await ctx.ask({
        prompt: "Run git push?",
        choices: ["allow_once", "reject_once"],
        onTimeout: "reject_once",
        resume: { session: "s", grant: { kind: "command", value: "git push", choice: "allow_once" } },
      });
      return { result: "done" };
    });
    let error: unknown;
    try {
      await registry.runStep("probe/agent", {}, { runId: "run-grant-ask", asker: { ask: (request) => { asked.push(request); return Promise.reject(new Error("no")); }, useGrant: () => Promise.resolve(false) } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginError);
    expect(String((error as Error).message)).toContain("cannot enforce a one-time permission");
    expect(asked).toEqual([]);
  });

  test("a profile with askCommands is refused at start and the field is named", async () => {
    const env = await setup("done");
    let error: unknown;
    try {
      env.registry.checkAccess("radian:prompt", { askCommands: ["git push"] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AccessError);
    expect(String((error as Error).message)).toContain("askCommands");
  });
});
