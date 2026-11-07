import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EFFORT_LEVELS, parseInput } from "../src/protocol.ts";
import {
  SESSION,
  assistant,
  rateLimit,
  result,
  systemInit,
  type FakeScript,
  type FakeStep,
} from "./fake-claude.ts";

const FAKE_WORKER = join(import.meta.dir, "fake-worker.ts");
const REAL_WORKER = join(import.meta.dir, "..", "src", "worker.ts");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-claude-worker-"));
  temps.push(dir);
  return dir;
}

type Line = Record<string, unknown>;

interface Run {
  readonly lines: Line[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly record: Line[];
}

class Child {
  readonly #process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #stdout: Promise<string>;
  readonly #waiters = new Set<() => void>();
  #stderr = "";
  readonly #stderrDone: Promise<void>;

  constructor(
    file: string,
    env: Record<string, string | undefined>,
    private readonly recordFile: string,
  ) {
    this.#process = Bun.spawn([process.execPath, file], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    this.#stdout = new Response(this.#process.stdout).text();
    this.#stderrDone = this.#readStderr(this.#process.stderr);
  }

  async #readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.#stderr += decoder.decode(chunk, { stream: true });
      for (const wake of this.#waiters) wake();
      this.#waiters.clear();
    }
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  send(text: string): void {
    this.#process.stdin.write(text);
    void this.#process.stdin.end();
  }

  /** Waits until stderr holds the text, or the child ends. */
  async stderrHas(text: string): Promise<void> {
    let ended = false;
    void this.#process.exited.then(() => {
      ended = true;
      for (const wake of this.#waiters) wake();
      this.#waiters.clear();
    });
    while (!this.#stderr.includes(text) && !ended) {
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }

  signal(name: NodeJS.Signals): void {
    this.#process.kill(name);
  }

  async finish(): Promise<Run> {
    const exitCode = await this.#process.exited;
    await this.#stderrDone;
    const stdout = await this.#stdout;
    const lines = stdout
      .split("\n")
      .filter((text) => text.length > 0)
      .map((text) => JSON.parse(text) as Line);
    const record = existsSync(this.recordFile)
      ? readFileSync(this.recordFile, "utf8")
          .split("\n")
          .filter((text) => text.length > 0)
          .map((text) => JSON.parse(text) as Line)
      : [];
    return { lines, stdout, stderr: this.#stderr, exitCode, record };
  }
}

interface Setup {
  readonly input: Record<string, unknown>;
  readonly recordFile: string;
  readonly env: (script: FakeScript, extra?: Record<string, string>) => Record<string, string | undefined>;
}

function setup(): Setup {
  const dir = tempDir();
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const recordFile = join(dir, "record.jsonl");
  return {
    input: { prompt: "hello", cwd },
    recordFile,
    env: (script, extra = {}) => ({
      ...process.env,
      // A login of the machine running the tests must not reach the fake.
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      FAKE_SCRIPT: JSON.stringify(script),
      FAKE_RECORD: recordFile,
      ...extra,
    }),
  };
}

function start(s: Setup, script: FakeScript, extra: Record<string, string> = {}): Child {
  const child = new Child(FAKE_WORKER, s.env(script, extra), s.recordFile);
  child.send(JSON.stringify(s.input));
  return child;
}

async function runFake(s: Setup, script: FakeScript, extra: Record<string, string> = {}): Promise<Run> {
  return start(s, script, extra).finish();
}

const done: FakeStep[] = [
  { say: systemInit() },
  { say: assistant("m1", "the answer") },
  { say: result() },
];

/** The value of a claude flag, spelled `--flag value` or `--flag=value`. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const joined = args.find((arg) => arg.startsWith(`${flag}=`));
  if (joined !== undefined) return joined.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function last(run: Run): Line {
  const line = run.lines.at(-1);
  if (line === undefined) throw new Error("the worker wrote no line");
  return line;
}

function kinds(run: Run): unknown[] {
  return run.lines.map((line) => line["type"]);
}

test("a prompt that ends writes the lines in order and a Result with usage, cost, session and model", async () => {
  const s = setup();
  const run = await runFake(s, { steps: done });

  expect(run.exitCode).toBe(0);
  expect(kinds(run)).toEqual(["message_end", "result"]);
  expect(run.lines[0]).toMatchObject({
    role: "assistant",
    stopReason: "end_turn",
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
    cost: null,
  });
  expect(last(run)).toEqual({
    type: "result",
    result: "done",
    sessionId: SESSION,
    usage: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
    cost: { micros: 12346, quality: "exact" },
    finalMessage: "the answer",
    model: "claude-fake-1",
  });
  expect(run.stdout.endsWith("\n")).toBe(true);
});

test("cost quality is estimated for a subscription login and exact for an API key", async () => {
  const subscription = await runFake(setup(), { account: { subscriptionType: "Claude Max" }, steps: done });
  expect(last(subscription)["cost"]).toEqual({ micros: 12346, quality: "estimated" });

  const apiKey = await runFake(setup(), { account: { apiKeySource: "ANTHROPIC_API_KEY" }, steps: done });
  expect(last(apiKey)["cost"]).toEqual({ micros: 12346, quality: "exact" });
});

test("PreToolUse and PostToolUse hooks write tool_execution_start and tool_execution_end", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { hook: "PreToolUse", toolName: "Bash", toolUseId: "tool-1", input: { command: "ls" } },
      { hook: "PostToolUse", toolName: "Bash", toolUseId: "tool-1", input: { command: "ls" } },
      { hook: "PreToolUse", toolName: "Read", toolUseId: "tool-2" },
      { hook: "PostToolUseFailure", toolName: "Read", toolUseId: "tool-2" },
      { say: result() },
    ],
  });

  expect(run.exitCode).toBe(0);
  expect(run.lines.slice(0, 4)).toEqual([
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "Bash" },
    { type: "tool_execution_end", toolCallId: "tool-1", toolName: "Bash", isError: false },
    { type: "tool_execution_start", toolCallId: "tool-2", toolName: "Read" },
    { type: "tool_execution_end", toolCallId: "tool-2", toolName: "Read", isError: true },
  ]);
});

test("canUseTool allows a call that the access profile does not mention", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { ask: { toolName: "Bash", toolUseId: "tool-1", input: { command: "ls" } } },
      { say: result() },
    ],
  });

  expect(run.exitCode).toBe(0);
  const reply = run.record.find((entry) => "askReply" in entry);
  expect(reply).toMatchObject({ askReply: "Bash", answer: { behavior: "allow", updatedInput: { command: "ls" } } });
  expect(kinds(run)).not.toContain("blocked");
});

test("a result with is_error is failed with reason model_error and exit 1", async () => {
  const run = await runFake(setup(), {
    steps: [{ say: systemInit() }, { say: result({ is_error: true, result: "the model fell over" }) }],
  });

  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({
    result: "failed",
    reason: "model_error",
    message: "the model fell over",
    sessionId: SESSION,
    finalMessage: "the model fell over",
  });
  expect(last(run)["modelError"]).toBeUndefined();
});

test("a result that stopped at max turns is failed with the subtype in the message", async () => {
  const run = await runFake(setup(), {
    steps: [{ say: systemInit() }, { say: result({ subtype: "error_max_turns", result: undefined }) }],
  });

  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ result: "failed", reason: "model_error", message: "claude stopped: error_max_turns" });
});

test("a rejected rate limit event becomes a usage_limit modelError on the failed Result", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { say: rateLimit({ status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1 }) },
      { say: rateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1790000000 }) },
      { say: result({ is_error: true, result: "limit" }) },
    ],
  });

  expect(run.exitCode).toBe(1);
  expect(run.lines.filter((line) => line["type"] === "rate_limit")).toEqual([
    { type: "rate_limit", status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1 },
    { type: "rate_limit", status: "rejected", rateLimitType: "five_hour", resetsAt: 1790000000 },
  ]);
  expect(last(run)).toMatchObject({
    result: "failed",
    reason: "model_error",
    message: "usage limit reached (five_hour)",
    modelError: { kind: "usage_limit", rateLimitType: "five_hour", resetsAt: 1790000000 },
  });
});

test("a warning-only rate limit event does not change a run that ends well", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { say: rateLimit({ status: "allowed_warning", rateLimitType: "seven_day" }) },
      { say: result() },
    ],
  });

  expect(run.exitCode).toBe(0);
  expect(last(run)).toMatchObject({ result: "done" });
  expect(last(run)["modelError"]).toBeUndefined();
});

test("resume passes the session id to claude; an unknown one is failed session_missing", async () => {
  const s = setup();
  s.input["resumeSession"] = SESSION;
  const unknown = `No conversation found with session ID: ${SESSION}`;
  const run = await runFake(s, { steps: [{ say: result({ is_error: true, result: unknown }) }] });

  const spawned = run.record.find((entry) => "spawn" in entry);
  const args = (spawned?.["spawn"] as { args: string[] }).args;
  expect(flagValue(args, "--resume")).toBe(SESSION);
  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ result: "failed", reason: "session_missing", message: unknown });
});

test("a claude that exits with no result is failed, not done", async () => {
  const run = await runFake(setup(), { steps: [{ say: systemInit() }, { exit: 1 }] });

  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ type: "result", result: "failed", reason: "model_error" });
  expect(kinds(run).filter((kind) => kind === "result").length).toBe(1);
});

test("SIGTERM mid-turn aborts claude, writes a cancelled Result and exits 143", async () => {
  const s = setup();
  const child = start(s, { steps: [{ say: systemInit() }, { hang: true }] });
  await child.stderrHas("fake-claude-hanging");
  child.signal("SIGTERM");
  const run = await child.finish();

  expect(run.exitCode).toBe(143);
  expect(last(run)).toMatchObject({ type: "result", result: "cancelled", finalMessage: null, sessionId: SESSION });
  expect(kinds(run).filter((kind) => kind === "result").length).toBe(1);
  expect(kinds(run).at(-1)).toBe("result");
});

test("an unknown input field such as args is refused with exit 2", async () => {
  const s = setup();
  s.input["args"] = ["--model", "opus"];
  const run = await runFake(s, { steps: done });

  expect(run.exitCode).toBe(2);
  expect(kinds(run)).toEqual(["result"]);
  expect(last(run)).toMatchObject({ result: "failed", reason: "invalid_input", message: "args is not an input field" });
  expect(run.record).toEqual([]);
});

test("input that is not JSON is refused with exit 2", async () => {
  const s = setup();
  const child = new Child(FAKE_WORKER, s.env({ steps: done }), s.recordFile);
  child.send("not json");
  const run = await child.finish();

  expect(run.exitCode).toBe(2);
  expect(last(run)).toMatchObject({ reason: "invalid_input", message: "the input is not valid JSON" });
});

test("model, effort, maxTurns and budgetUsd reach claude as its own flags", async () => {
  const s = setup();
  Object.assign(s.input, { model: "opus", effort: "high", maxTurns: 3, budgetUsd: 2.5 });
  const run = await runFake(s, { steps: done });

  expect(run.exitCode).toBe(0);
  const args = (run.record.find((entry) => "spawn" in entry)?.["spawn"] as { args: string[] }).args;
  const after = (flag: string): string | undefined => flagValue(args, flag);
  expect(after("--model")).toBe("opus");
  expect(after("--effort")).toBe("high");
  expect(after("--max-turns")).toBe("3");
  expect(after("--max-budget-usd")).toBe("2.5");
});

test("claude runs without setting sources, with manual permissions and the isolation environment", async () => {
  const run = await runFake(setup(), { steps: done });

  const spawned = run.record.find((entry) => "spawn" in entry)?.["spawn"] as {
    args: string[];
    env: Record<string, string>;
  };
  expect(flagValue(spawned.args, "--setting-sources")).toBe("");
  expect(flagValue(spawned.args, "--permission-mode")).toBe("default");
  expect(flagValue(spawned.args, "--permission-prompts")).toBe("host");
  expect(spawned.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
  expect(spawned.env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"]).toBe("1");
  expect(spawned.env["DISABLE_TELEMETRY"]).toBe("1");
  expect(spawned.env["DISABLE_ERROR_REPORTING"]).toBe("1");
});

test("CLAUDE_CODE_OAUTH_TOKEN passes through unchanged and is written nowhere", async () => {
  const token = "sk-ant-oat01-test-token-value";
  const run = await runFake(setup(), { steps: done }, { CLAUDE_CODE_OAUTH_TOKEN: token });

  const spawned = run.record.find((entry) => "spawn" in entry)?.["spawn"] as { env: Record<string, string> };
  expect(spawned.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(token);
  expect(run.stdout).not.toContain(token);
  expect(run.stderr).not.toContain(token);
});

test("with no claude on PATH the real worker fails and says how to fix it", async () => {
  const s = setup();
  const child = new Child(REAL_WORKER, { HOME: process.env["HOME"], PATH: "" }, s.recordFile);
  child.send(JSON.stringify(s.input));
  const run = await child.finish();

  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ result: "failed", reason: "model_error" });
  expect(String(last(run)["message"])).toContain("install Claude Code");
});

test("the input table: required fields, types and limits", () => {
  const ok = { prompt: "p", cwd: "/work" };
  expect(parseInput(ok)).toEqual({
    ok: true,
    input: {
      prompt: "p",
      cwd: "/work",
      command: undefined,
      resumeSession: undefined,
      model: undefined,
      effort: undefined,
      access: undefined,
      maxTurns: undefined,
      budgetUsd: undefined,
    },
  });
  const message = (value: unknown): string => {
    const parsed = parseInput(value);
    return parsed.ok ? "ok" : parsed.message;
  };
  expect(message("text")).toBe("the input must be a JSON object");
  expect(message({ cwd: "/w" })).toBe("prompt is required");
  expect(message({ prompt: "", cwd: "/w" })).toBe("prompt must be a non-empty string");
  expect(message({ prompt: "p" })).toBe("cwd is required");
  expect(message({ ...ok, command: 3 })).toBe("command must be a non-empty string");
  expect(message({ ...ok, resumeSession: "abc" })).toBe("resumeSession must be a session id (a UUID)");
  expect(message({ ...ok, resumeSession: SESSION })).toBe("ok");
  expect(message({ ...ok, model: "" })).toBe("model must be a non-empty string");
  expect(message({ ...ok, effort: "huge" })).toBe(`effort must be one of ${EFFORT_LEVELS.join(", ")}`);
  for (const level of EFFORT_LEVELS) expect(message({ ...ok, effort: level })).toBe("ok");
  expect(message({ ...ok, maxTurns: 0 })).toBe("maxTurns must be a positive integer");
  expect(message({ ...ok, maxTurns: 1.5 })).toBe("maxTurns must be a positive integer");
  expect(message({ ...ok, budgetUsd: 0 })).toBe("budgetUsd must be a positive number");
  expect(message({ ...ok, budgetUsd: "1" })).toBe("budgetUsd must be a positive number");
  expect(message({ ...ok, access: "x" })).toBe("access must be an object");
  expect(message({ ...ok, access: { denyPaths: 3 } })).toContain("access.");
  expect(message({ ...ok, access: { denyPaths: ["/etc"] } })).toBe("ok");
  expect(message({ ...ok, args: [] })).toBe("args is not an input field");
});

test("a warning-only rate limit event is not a usage limit when the run fails for another reason", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { say: rateLimit({ status: "allowed_warning", rateLimitType: "five_hour" }) },
      { say: result({ is_error: true, result: "the model fell over" }) },
    ],
  });

  expect(last(run)).toMatchObject({ result: "failed", message: "the model fell over" });
  expect(last(run)["modelError"]).toBeUndefined();
});

test("a tool call ends once, and an end with no start writes nothing", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { hook: "PreToolUse", toolName: "Bash", toolUseId: "tool-1" },
      { hook: "PostToolUse", toolName: "Bash", toolUseId: "tool-1" },
      { hook: "PostToolUse", toolName: "Bash", toolUseId: "tool-1" },
      { hook: "PostToolUse", toolName: "Read", toolUseId: "tool-9" },
      { say: result() },
    ],
  });

  expect(kinds(run)).toEqual(["tool_execution_start", "tool_execution_end", "result"]);
});

test("several content blocks of one assistant message write one message_end", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { say: assistant("m1", "first block") },
      { say: assistant("m1", "second block") },
      { say: assistant("m2", "next message") },
      { say: result() },
    ],
  });

  expect(kinds(run)).toEqual(["message_end", "message_end", "result"]);
});
