import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EFFORT_LEVELS, parseInput } from "../../src/protocol.ts";
import { serveWorker } from "../../src/worker.ts";
import { fakeHooks } from "../fake-hooks.ts";
import { TOOL_TABLE } from "../../src/access.ts";
import {
  MISSING_SESSION,
  SESSION,
  assistant,
  rateLimit,
  result,
  systemInit,
  type FakeScript,
  type FakeStep,
} from "../fake-claude.ts";

const FAKE_WORKER = join(import.meta.dir, "..", "fake-worker.ts");
const REAL_WORKER = join(import.meta.dir, "..", "..", "src", "worker.ts");

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
  /** Every stdout line but the `session` line, which has its own field. */
  readonly lines: Line[];
  readonly session: Line[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly record: Line[];
}

function toRun(stdout: string, stderr: string, exitCode: number, recordFile: string): Run {
  const all = stdout
    .split("\n")
    .filter((text) => text.length > 0)
    .map((text) => JSON.parse(text) as Line);
  const lines = all.filter((line) => line["type"] !== "session");
  const session = all.filter((line) => line["type"] === "session");
  const record = existsSync(recordFile)
    ? readFileSync(recordFile, "utf8")
        .split("\n")
        .filter((text) => text.length > 0)
        .map((text) => JSON.parse(text) as Line)
    : [];
  return { lines, session, stdout, stderr, exitCode, record };
}

class ProcessChild {
  readonly #process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #waiters = new Set<() => void>();
  #stdout = "";
  #stderr = "";
  readonly #stdoutDone: Promise<void>;
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
    this.#stdoutDone = this.#readStdout(this.#process.stdout);
    this.#stderrDone = this.#readStderr(this.#process.stderr);
  }

  async #readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.#stdout += decoder.decode(chunk, { stream: true });
      for (const wake of this.#waiters) wake();
      this.#waiters.clear();
    }
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
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

  /** Writes one input line and leaves stdin open, so the host can answer later. */
  sendLine(text: string): void {
    this.#process.stdin.write(`${text}\n`);
    void this.#process.stdin.flush();
  }

  endInput(): void {
    void this.#process.stdin.end();
  }

  /** Waits for the first stdout line of this type, or the end of the child. */
  async untilLine(type: string): Promise<Line | undefined> {
    let ended = false;
    void this.#process.exited.then(() => {
      ended = true;
      for (const wake of this.#waiters) wake();
      this.#waiters.clear();
    });
    for (;;) {
      for (const text of this.#stdout.split("\n")) {
        if (!text.startsWith("{")) continue;
        const parsed = JSON.parse(text) as Line;
        if (parsed["type"] === type) return parsed;
      }
      if (ended) return undefined;
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
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
    await this.#stdoutDone;
    return toRun(this.#stdout, this.#stderr, exitCode, this.recordFile);
  }
}

/**
 * The worker run in this process, with the same surface as `ProcessChild`.
 * `signal` aborts the run the way SIGTERM does; the tests that need a real
 * signal use `ProcessChild`.
 */
class Child {
  readonly #stdin = new TransformStream<Uint8Array, Uint8Array>();
  readonly #writer = this.#stdin.writable.getWriter();
  readonly #encoder = new TextEncoder();
  readonly #waiters = new Set<() => void>();
  readonly #controller = new AbortController();
  #stdout = "";
  #stderr = "";
  #exit: number | undefined;
  readonly #exited: Promise<number>;

  constructor(
    env: Record<string, string | undefined>,
    private readonly recordFile: string,
  ) {
    const wake = (): void => {
      for (const resolve of this.#waiters) resolve();
      this.#waiters.clear();
    };
    const log = (text: string): void => {
      this.#stderr += text;
      wake();
    };
    this.#exited = serveWorker(
      this.#stdin.readable,
      {
        write: (text) => {
          this.#stdout += text;
          wake();
        },
        log: (text) => log(`${text}\n`),
      },
      this.#controller.signal,
      fakeHooks(env, log),
    ).then((code) => {
      this.#exit = code;
      wake();
      return code;
    });
  }

  send(text: string): void {
    void this.#writer.write(this.#encoder.encode(text));
    void this.#writer.close();
  }

  /** Writes one input line and leaves stdin open, so the host can answer later. */
  sendLine(text: string): void {
    void this.#writer.write(this.#encoder.encode(`${text}\n`));
  }

  endInput(): void {
    void this.#writer.close().catch(() => undefined);
  }

  /** Waits for the first stdout line of this type, or the end of the run. */
  async untilLine(type: string): Promise<Line | undefined> {
    for (;;) {
      for (const text of this.#stdout.split("\n")) {
        if (!text.startsWith("{")) continue;
        const parsed = JSON.parse(text) as Line;
        if (parsed["type"] === type) return parsed;
      }
      if (this.#exit !== undefined) return undefined;
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }

  /** Waits until stderr holds the text, or the run ends. */
  async stderrHas(text: string): Promise<void> {
    while (!this.#stderr.includes(text) && this.#exit === undefined) {
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }

  signal(_name: NodeJS.Signals): void {
    this.#controller.abort();
  }

  async finish(): Promise<Run> {
    const exitCode = await this.#exited;
    return toRun(this.#stdout, this.#stderr, exitCode, this.recordFile);
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
  const child = new Child(s.env(script, extra), s.recordFile);
  child.send(JSON.stringify(s.input));
  return child;
}

/** The real worker process, for what only a process shows: a signal, the entry. */
function startProcess(s: Setup, script: FakeScript): ProcessChild {
  const child = new ProcessChild(FAKE_WORKER, s.env(script), s.recordFile);
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
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "Bash", at: expect.any(Number), input: "ls" },
    { type: "tool_execution_end", toolCallId: "tool-1", toolName: "Bash", isError: false, durationMs: expect.any(Number) },
    { type: "tool_execution_start", toolCallId: "tool-2", toolName: "Read", at: expect.any(Number) },
    { type: "tool_execution_end", toolCallId: "tool-2", toolName: "Read", isError: true, durationMs: expect.any(Number), error: "failed" },
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
  const child = startProcess(s, { steps: [{ say: systemInit() }, { hang: true }] });
  await child.stderrHas("fake-claude-hanging");
  child.signal("SIGTERM");
  const run = await child.finish();

  expect(run.exitCode).toBe(143);
  expect(last(run)).toMatchObject({ type: "result", result: "cancelled", finalMessage: null, sessionId: SESSION });
  expect(kinds(run).filter((kind) => kind === "result").length).toBe(1);
  expect(kinds(run).at(-1)).toBe("result");
});

test("a message line from the host reaches claude as a user turn while the run hangs", async () => {
  const s = setup();
  const child = new Child(s.env({ steps: [{ say: systemInit() }, { hang: true }] }), s.recordFile);
  child.sendLine(JSON.stringify(s.input));
  await child.stderrHas("fake-claude-hanging");
  child.sendLine(JSON.stringify({ type: "message", text: "wrap up now" }));
  await child.stderrHas("fake-claude-user-later");
  child.signal("SIGTERM");
  const run = await child.finish();

  const later = run.record.find((entry) => "userLater" in entry);
  expect(later).toMatchObject({ userLater: { role: "user", content: "wrap up now" } });
  expect(last(run)).toMatchObject({ type: "result", result: "cancelled" });
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
  const child = new Child(s.env({ steps: done }), s.recordFile);
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
  const child = new ProcessChild(REAL_WORKER, { HOME: process.env["HOME"], PATH: "" }, s.recordFile);
  child.send(JSON.stringify(s.input));
  const run = await child.finish();

  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ result: "failed", reason: "model_error" });
  expect(String(last(run)["message"])).toContain("install claude");
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

// Access profile and one-time grants.

const DENY_RM: FakeStep[] = [
  { say: systemInit() },
  { hook: "PreToolUse", toolName: "Bash", toolUseId: "tool-1", input: { command: "rm -rf build" } },
  { ask: { toolName: "Bash", toolUseId: "tool-1", input: { command: "rm -rf build" } } },
  { say: assistant("m1", "I could not run it") },
  { say: result() },
];

function answerOf(run: Run): Line {
  const reply = run.record.find((entry) => "askReply" in entry);
  return (reply?.["answer"] ?? {}) as Line;
}

test("a Bash command that denyCommands refuses is denied with the reason, logged, and the run goes on", async () => {
  const s = setup();
  s.input["access"] = { denyCommands: ["rm"] };
  const run = await runFake(s, { steps: DENY_RM });

  expect(run.exitCode).toBe(0);
  const answer = answerOf(run);
  expect(answer["behavior"]).toBe("deny");
  expect(String(answer["message"])).toContain('denyCommands rule "rm"');
  expect(run.lines.slice(0, 3)).toEqual([
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "Bash", at: expect.any(Number), input: "Bash denied by the access profile (rule: rm)" },
    { type: "blocked", toolName: "Bash", reason: "refused by the access profile" },
    {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "Bash",
      isError: true,
      durationMs: expect.any(Number),
      error: "refused by the access profile",
    },
  ]);
  expect(kinds(run).slice(3)).toEqual(["message_end", "result"]);
  expect(last(run)).toMatchObject({ result: "done" });
});

test("a command the profile does not refuse is allowed", async () => {
  const s = setup();
  s.input["access"] = { denyCommands: ["rm"] };
  const run = await runFake(s, {
    steps: [
      { say: systemInit() },
      { ask: { toolName: "Bash", toolUseId: "tool-1", input: { command: "ls -la" } } },
      { say: result() },
    ],
  });

  expect(answerOf(run)["behavior"]).toBe("allow");
  expect(kinds(run)).not.toContain("blocked");
});

test("a Read under denyPaths is denied, and Read elsewhere is allowed", async () => {
  const s = setup();
  s.input["access"] = { denyPaths: ["/etc"] };
  const run = await runFake(s, {
    steps: [
      { say: systemInit() },
      { ask: { toolName: "Read", toolUseId: "tool-1", input: { file_path: "/etc/passwd" } } },
      { say: result() },
    ],
  });

  expect(answerOf(run)["behavior"]).toBe("deny");
  expect(String(answerOf(run)["message"])).toContain('under denyPaths entry "/etc"');
  expect(run.lines.find((line) => line["type"] === "blocked")).toMatchObject({
    toolName: "Read",
    reason: "refused by the access profile",
  });
  expect(JSON.stringify(run.lines)).not.toContain("/etc/passwd");
});

test("a denied NotebookEdit or MultiEdit start line shows no path", async () => {
  const s = setup();
  s.input["access"] = { denyPaths: ["/secrets"] };
  const run = await runFake(s, {
    steps: [
      { say: systemInit() },
      { hook: "PreToolUse", toolName: "NotebookEdit", toolUseId: "n1", input: { notebook_path: "/secrets/key" } },
      { hook: "PreToolUse", toolName: "MultiEdit", toolUseId: "m1", input: { file_path: "/secrets/key" } },
      { say: result() },
    ],
  });
  const starts = run.lines.filter((line) => line["type"] === "tool_execution_start");
  expect(starts.map((line) => line["input"])).toEqual([
    "NotebookEdit denied by the access profile (rule: /secrets)",
    "MultiEdit denied by the access profile (rule: /secrets)",
  ]);
  expect(JSON.stringify(run.lines)).not.toContain("/secrets/key");
});

test("every tool the translation maps shows only its denial when the profile denies it", async () => {
  const s = setup();
  s.input["access"] = { denyPaths: ["/secrets"], denyCommands: ["rm"] };
  const calls = TOOL_TABLE.map((row, i) => ({
    name: row.claude,
    id: `t${i}`,
    input: { [row.from]: row.tool === "bash" ? "rm /secrets/key" : "/secrets/key" },
  }));
  const run = await runFake(s, {
    steps: [
      { say: systemInit() },
      ...calls.map((c) => ({ hook: "PreToolUse" as const, toolName: c.name, toolUseId: c.id, input: c.input })),
      { say: result() },
    ],
  });
  const starts = run.lines.filter((line) => line["type"] === "tool_execution_start");
  expect(starts.map((line) => line["input"])).toEqual(calls.map((c) => `${c.name} denied by the access profile (rule: ${c.name === "Bash" ? "rm" : "/secrets"})`));
  expect(JSON.stringify(run.lines)).not.toContain("/secrets/key");
});

test("a tool outside the table is denied under a rule and allowed without one", async () => {
  const steps: FakeStep[] = [
    { say: systemInit() },
    { ask: { toolName: "mcp__files__read", toolUseId: "tool-1", input: {} } },
    { say: result() },
  ];
  const ruled = setup();
  ruled.input["access"] = { denyPaths: ["/etc"] };
  const denied = await runFake(ruled, { steps });
  expect(answerOf(denied)["behavior"]).toBe("deny");

  const free = await runFake(setup(), { steps });
  expect(answerOf(free)["behavior"]).toBe("allow");
});

const GRANT_ACCESS = {
  denyCommands: ["rm"],
  grants: [{ waitId: "w1", kind: "command", value: "rm -rf build" }],
};

async function grantRun(ack: boolean | "none"): Promise<{ run: Run; grantLine: Line | undefined }> {
  const s = setup();
  s.input["access"] = GRANT_ACCESS;
  const child = new Child(s.env({ steps: DENY_RM }), s.recordFile);
  child.sendLine(JSON.stringify(s.input));
  if (ack === "none") {
    // The host is gone: stdin ends and no answer will come.
    child.endInput();
    return { run: await child.finish(), grantLine: undefined };
  }
  const grantLine = await child.untilLine("grant_use");
  if (grantLine !== undefined) child.sendLine(JSON.stringify({ type: "grant_ack", id: grantLine["id"], used: ack }));
  child.endInput();
  return { run: await child.finish(), grantLine };
}

test("a grant that matches is asked for, and the call runs when the host says used", async () => {
  const { run, grantLine } = await grantRun(true);

  expect(grantLine).toEqual({ type: "grant_use", id: 1, waitId: "w1" });
  expect(run.exitCode).toBe(0);
  expect(answerOf(run)["behavior"]).toBe("allow");
  expect(kinds(run)).not.toContain("blocked");
  expect(kinds(run).indexOf("grant_use")).toBeLessThan(kinds(run).indexOf("message_end"));
});

test("a grant the host did not use up leaves the call denied", async () => {
  const { run } = await grantRun(false);

  expect(answerOf(run)["behavior"]).toBe("deny");
  expect(kinds(run)).toContain("blocked");
  expect(last(run)).toMatchObject({ result: "done" });
});

test("a grant whose answer never comes, because the host is gone, leaves the call denied", async () => {
  const { run } = await grantRun("none");

  expect(answerOf(run)["behavior"]).toBe("deny");
  expect(kinds(run)).toContain("blocked");
  expect(last(run)).toMatchObject({ result: "done" });
});

test("a call no grant covers never writes a grant_use line", async () => {
  const s = setup();
  s.input["access"] = GRANT_ACCESS;
  const run = await runFake(s, {
    steps: [
      { say: systemInit() },
      { ask: { toolName: "Bash", toolUseId: "tool-1", input: { command: "rm -rf dist" } } },
      { say: result() },
    ],
  });

  expect(answerOf(run)["behavior"]).toBe("deny");
  expect(kinds(run)).not.toContain("grant_use");
});

test("an access profile the matcher cannot read is invalid input", async () => {
  const s = setup();
  s.input["access"] = { denyCommands: "rm" };
  const run = await runFake(s, { steps: done });

  expect(run.exitCode).toBe(2);
  expect(last(run)).toMatchObject({ reason: "invalid_input", message: "access.denyCommands must be an array of strings" });
});

test("the session line says which credential claude uses, and is written once, first", async () => {
  const subscription = await runFake(setup(), { steps: done });
  expect(subscription.session).toEqual([
    { type: "session", claudeVersion: "2.1.319", apiKeySource: "none", model: "fake" },
  ]);
  expect(subscription.stdout.startsWith('{"type":"session"')).toBe(true);

  const withKey = await runFake(setup(), {
    steps: [{ say: { ...systemInit(), apiKeySource: "ANTHROPIC_API_KEY" } }, { say: result() }],
  });
  expect(withKey.session[0]).toMatchObject({ apiKeySource: "ANTHROPIC_API_KEY" });
});

test("no session line is written when claude never starts a session", async () => {
  const run = await runFake(setup(), { steps: [{ say: result() }] });
  expect(run.session).toEqual([]);
});

test("an unknown session as the real claude reports it: errors, no result text, no model", async () => {
  const s = setup();
  s.input["resumeSession"] = "00000000-0000-4000-8000-000000000000";
  const run = await runFake(s, {
    steps: [
      {
        say: result({
          subtype: "error_during_execution",
          is_error: true,
          result: undefined,
          errors: [MISSING_SESSION],
          total_cost_usd: 0,
          modelUsage: {},
        }),
      },
    ],
  });

  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ result: "failed", reason: "session_missing", message: MISSING_SESSION });
});

test("a failed run that used no model has no cost, not an exact zero", async () => {
  const run = await runFake(setup(), {
    steps: [{ say: result({ subtype: "error_during_execution", is_error: true, errors: ["boom"], total_cost_usd: 0, modelUsage: {} }) }],
  });

  expect(last(run)).toMatchObject({ result: "failed", reason: "model_error", message: "boom", cost: null, model: null });
});

test("claude runs in the foreground: background tasks off, waiting tools disallowed, Bash timeouts set", async () => {
  const run = await runFake(setup(), { steps: done });
  const spawned = run.record.find((entry) => "spawn" in entry)?.["spawn"] as {
    args: string[];
    env: Record<string, string>;
  };
  expect(spawned.env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]).toBe("1");
  expect(spawned.env["BASH_DEFAULT_TIMEOUT_MS"]).toBe("1800000");
  expect(spawned.env["BASH_MAX_TIMEOUT_MS"]).toBe("1800000");
  const disallowed = flagValue(spawned.args, "--disallowedTools") ?? "";
  for (const name of ["Monitor", "ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "TaskStop"]) {
    expect(disallowed).toContain(name);
  }
});

test("bashTimeoutSecs sets both Bash timeouts and must be a positive integer", async () => {
  const s = setup();
  s.input["bashTimeoutSecs"] = 900;
  const run = await runFake(s, { steps: done });
  const env = (run.record.find((entry) => "spawn" in entry)?.["spawn"] as { env: Record<string, string> }).env;
  expect(env["BASH_DEFAULT_TIMEOUT_MS"]).toBe("900000");
  expect(env["BASH_MAX_TIMEOUT_MS"]).toBe("900000");

  const bad = setup();
  bad.input["bashTimeoutSecs"] = 0;
  const refused = await runFake(bad, { steps: done });
  expect(refused.exitCode).toBe(2);
  expect(last(refused)).toMatchObject({ message: "bashTimeoutSecs must be a positive integer" });
});

test("a second session after the result is not accepted as a second turn", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { say: assistant("m1", "waiting for the build") },
      { say: result({ result: "waiting" }) },
      { say: systemInit() },
      { say: assistant("m2", "committed") },
      { say: result({ result: "done after the wait" }) },
    ],
  });

  expect(run.exitCode).toBe(1);
  expect(run.session.length).toBe(1);
  expect(kinds(run)).toEqual(["message_end", "result"]);
  expect(last(run)).toMatchObject({
    result: "failed",
    reason: "model_error",
    sessionId: SESSION,
    usage: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
    finalMessage: "waiting",
  });
  expect(String(last(run)["message"])).toContain("a second session started by itself");
  expect(run.stderr).toContain("a second session started after the result");
});

/* ---- what a tool call line says (T-0063) ---- */

const BASE = 1_700_000_000_000;

function toolLines(run: Run): { start: Line[]; end: Line[] } {
  return {
    start: run.lines.filter((line) => line["type"] === "tool_execution_start"),
    end: run.lines.filter((line) => line["type"] === "tool_execution_end"),
  };
}

test("a Bash call logs its command, its start time and its duration", async () => {
  const run = await runFake(
    setup(),
    {
      steps: [
        { say: systemInit() },
        { hook: "PreToolUse", toolName: "Bash", toolUseId: "b1", input: { command: "xcodebuild test\n  -only-testing A/B" } },
        { hook: "PostToolUse", toolName: "Bash", toolUseId: "b1", input: {}, output: "TOOL OUTPUT MUST NOT APPEAR" },
        { say: result() },
      ],
    },
    { FAKE_CLOCK_STEP: "72000" },
  );
  const { start, end } = toolLines(run);
  expect(start[0]).toMatchObject({ toolName: "Bash", at: BASE, input: "xcodebuild test\n-only-testing A/B" });
  expect(end[0]).toMatchObject({ toolCallId: "b1", isError: false, durationMs: 72000 });
  expect(run.stdout).not.toContain("TOOL OUTPUT MUST NOT APPEAR");
});

test("a long command is cut at 500 characters", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { hook: "PreToolUse", toolName: "Bash", toolUseId: "b1", input: { command: `echo ${"x".repeat(900)}` } },
      { say: result() },
    ],
  });
  const text = String(toolLines(run).start[0]?.["input"]);
  expect(text.length).toBe(500);
  expect(text.startsWith("echo xxx")).toBe(true);
});

test("a Read and a Write log their path and never the file content", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { hook: "PreToolUse", toolName: "Read", toolUseId: "r1", input: { file_path: "/w/a.ts" } },
      { hook: "PostToolUse", toolName: "Read", toolUseId: "r1", output: "FILE BODY" },
      {
        hook: "PreToolUse",
        toolName: "Write",
        toolUseId: "w1",
        input: { file_path: "/w/b.ts", content: "NEW FILE BODY" },
      },
      { hook: "PreToolUse", toolName: "Grep", toolUseId: "g1", input: { pattern: "needle", path: "/w" } },
      { hook: "PreToolUse", toolName: "TodoWrite", toolUseId: "t1", input: { todos: [{ content: "x" }] } },
      { say: result() },
    ],
  });
  const { start } = toolLines(run);
  expect(start.map((line) => line["input"])).toEqual(["/w/a.ts", "/w/b.ts", "/w", undefined]);
  expect(run.stdout).not.toContain("FILE BODY");
});

test("a tool error logs its first line only", async () => {
  const run = await runFake(setup(), {
    steps: [
      { say: systemInit() },
      { hook: "PreToolUse", toolName: "Bash", toolUseId: "b1", input: { command: "false" } },
      { hook: "PostToolUseFailure", toolName: "Bash", toolUseId: "b1", output: "\nexit code 1\nsecond line\nthird" },
      { say: result() },
    ],
  });
  expect(toolLines(run).end[0]).toMatchObject({ isError: true, error: "exit code 1" });
  expect(run.stdout).not.toContain("second line");
});

test("a call the access profile refuses, and an environment value, are not logged", async () => {
  const s = setup();
  s.input["access"] = { denyPaths: ["/secrets"] };
  const run = await runFake(s, {
    steps: [
      { say: systemInit() },
      { hook: "PreToolUse", toolName: "Read", toolUseId: "r1", input: { file_path: "/secrets/key" } },
      { hook: "PreToolUse", toolName: "Bash", toolUseId: "b1", input: { command: "API_TOKEN=hunter2 make test" } },
      { say: result() },
    ],
  });
  const { start } = toolLines(run);
  expect(start[0]?.["input"]).toBe("Read denied by the access profile (rule: /secrets)");
  expect(start[1]?.["input"]).toBe("API_TOKEN=*** make test");
  expect(run.stdout).not.toContain("hunter2");
  expect(run.stdout).not.toContain("/secrets/key");
});

test("an assistant message logs its first 300 characters as one paragraph, without thinking", async () => {
  const message = assistant("m1", `first\n\nsecond ${"y".repeat(400)}`);
  const inner = message["message"] as Record<string, unknown>;
  inner["content"] = [{ type: "thinking", thinking: "PRIVATE THOUGHT" }, ...(inner["content"] as unknown[])];
  const run = await runFake(setup(), { steps: [{ say: systemInit() }, { say: message }, { say: result() }] });
  const line = run.lines.find((l) => l["type"] === "message_end");
  expect(String(line?.["text"]).length).toBe(300);
  expect(String(line?.["text"]).startsWith("first second yyy")).toBe(true);
  expect(run.stdout).not.toContain("PRIVATE THOUGHT");
});

test("a secret of the operad store sent as secretValues is masked in the logged command", async () => {
  const s = setup();
  s.input["secretValues"] = ["store-secret-9"];
  const run = await runFake(s, {
    steps: [
      { say: systemInit() },
      { hook: "PreToolUse", toolName: "Bash", toolUseId: "b1", input: { command: "curl -H store-secret-9 x" } },
      { say: result() },
    ],
  });
  expect(toolLines(run).start[0]?.["input"]).toBe("curl -H *** x");
  expect(run.stdout).not.toContain("store-secret-9");
});

// -- askCommands: a call that must ask a person ------------------------------

const ASK_PUSH: FakeStep[] = [
  { say: systemInit() },
  { hook: "PreToolUse", toolName: "Bash", toolUseId: "tool-1", input: { command: "git push origin main" } },
  { ask: { toolName: "Bash", toolUseId: "tool-1", input: { command: "git push origin main" } } },
  { say: assistant("m1", "done") },
  { say: result() },
];
const ASKING = { askCommands: ["git push"] };

async function askRun(decision: "allow" | "deny" | "stop" | "gone"): Promise<{ run: Run; call: Line | undefined }> {
  const s = setup();
  s.input["access"] = ASKING;
  const child = new Child(s.env({ steps: ASK_PUSH }), s.recordFile);
  child.sendLine(JSON.stringify(s.input));
  if (decision === "gone") {
    child.endInput();
    return { run: await child.finish(), call: undefined };
  }
  const call = await child.untilLine("ask_call");
  if (call === undefined) return { run: await child.finish(), call };
  child.sendLine(JSON.stringify({ type: "ask_ack", id: call["id"], decision, reason: "no thanks" }));
  if (decision === "stop") {
    // The host ends the program after it answers `stop`.
    await child.untilLine("ask_resolved");
    child.signal("SIGTERM");
  }
  child.endInput();
  return { run: await child.finish(), call };
}

test("a command that askCommands matches writes an ask_call with the command and the session, and runs once when allowed", async () => {
  const { run, call } = await askRun("allow");
  expect(call).toEqual({
    type: "ask_call",
    id: 1,
    kind: "command",
    value: "git push origin main",
    shown: "git push origin main",
    session: SESSION,
  });
  expect(answerOf(run)["behavior"]).toBe("allow");
  expect(kinds(run)).not.toContain("blocked");
  // The start line shows the call as itself: it is not refused.
  expect(run.lines.find((line) => line["type"] === "tool_execution_start")?.["input"]).toBe("git push origin main");
  expect(kinds(run).indexOf("ask_call")).toBeLessThan(kinds(run).indexOf("ask_resolved"));
  expect(kinds(run).indexOf("ask_resolved")).toBeLessThan(kinds(run).indexOf("message_end"));
  expect(last(run)).toMatchObject({ result: "done" });
});

test("a refused question denies the call with the reason and the run goes on", async () => {
  const { run } = await askRun("deny");
  expect(answerOf(run)["behavior"]).toBe("deny");
  expect(String(answerOf(run)["message"])).toContain('matches askCommands rule "git push"');
  expect(String(answerOf(run)["message"])).toContain("no thanks");
  expect(kinds(run)).toContain("blocked");
  expect(last(run)).toMatchObject({ result: "done" });
});

test("a host that is gone refuses the call", async () => {
  const { run } = await askRun("gone");
  expect(answerOf(run)["behavior"]).toBe("deny");
  expect(last(run)).toMatchObject({ result: "done" });
});

test("a stop holds the call until the program is ended, and the call never runs", async () => {
  const { run } = await askRun("stop");
  expect(kinds(run)).not.toContain("message_end");
  expect(answerOf(run)["behavior"]).not.toBe("allow");
});

test("a deny wins over an ask: nobody is asked about a denied command", async () => {
  const s = setup();
  s.input["access"] = { askCommands: ["git push"], denyCommands: ["git push --force*"] };
  const run = await runFake(s, {
    steps: [
      { say: systemInit() },
      { ask: { toolName: "Bash", toolUseId: "tool-1", input: { command: "git push --force origin" } } },
      { say: result() },
    ],
  });
  expect(answerOf(run)["behavior"]).toBe("deny");
  expect(kinds(run)).not.toContain("ask_call");
});

test("a command that holds a secret value is refused and never asked about", async () => {
  const s = setup();
  s.input["access"] = ASKING;
  s.input["secretValues"] = ["hunter2hunter2"];
  const steps: FakeStep[] = [
    { say: systemInit() },
    { ask: { toolName: "Bash", toolUseId: "tool-1", input: { command: "git push https://u:hunter2hunter2@h/r" } } },
    { say: result() },
  ];
  // The host stays and would allow whatever it is asked.
  const child = new Child(s.env({ steps }), s.recordFile);
  child.sendLine(JSON.stringify(s.input));
  const call = await child.untilLine("ask_call");
  if (call !== undefined) child.sendLine(JSON.stringify({ type: "ask_ack", id: call["id"], decision: "allow" }));
  child.endInput();
  const run = await child.finish();
  expect(call).toBeUndefined();
  expect(answerOf(run)["behavior"]).toBe("deny");
  expect(run.stdout).not.toContain("hunter2hunter2");
});

test("after a late answer the one-time grant lets that command through and any other asks again", async () => {
  const s = setup();
  s.input["access"] = { ...ASKING, grants: [{ waitId: "w1", kind: "command", value: "git push origin main" }] };
  const steps: FakeStep[] = [
    { say: systemInit() },
    { ask: { toolName: "Bash", toolUseId: "tool-1", input: { command: "git push origin main" } } },
    { ask: { toolName: "Bash", toolUseId: "tool-2", input: { command: "git push origin other" } } },
    { say: result() },
  ];
  const child = new Child(s.env({ steps }), s.recordFile);
  child.sendLine(JSON.stringify(s.input));
  const use = await child.untilLine("grant_use");
  child.sendLine(JSON.stringify({ type: "grant_ack", id: use?.["id"], used: true }));
  const call = await child.untilLine("ask_call");
  // The granted call did not ask; the other one does.
  expect(call?.["value"]).toBe("git push origin other");
  child.sendLine(JSON.stringify({ type: "ask_ack", id: call?.["id"], decision: "deny" }));
  child.endInput();
  const run = await child.finish();
  const answers = run.record.filter((entry) => "askReply" in entry).map((entry) => (entry["answer"] as Line)["behavior"]);
  expect(answers).toEqual(["allow", "deny"]);
});

test("a Write to an askPaths path asks with the path and the tool, and runs once when allowed", async () => {
  const s = setup();
  s.input["access"] = { askPaths: ["~/.zshrc"] };
  const child = new Child(
    s.env({
      steps: [
        { say: systemInit() },
        { ask: { toolName: "Write", toolUseId: "tool-1", input: { file_path: "~/.zshrc" } } },
        { say: result() },
      ],
    }),
    s.recordFile,
  );
  child.sendLine(JSON.stringify(s.input));
  const call = await child.untilLine("ask_call");
  child.sendLine(JSON.stringify({ type: "ask_ack", id: call?.["id"], decision: "allow" }));
  child.endInput();
  const run = await child.finish();
  expect(call).toMatchObject({ type: "ask_call", kind: "path", value: "~/.zshrc", tool: "write", session: SESSION });
  expect(answerOf(run)["behavior"]).toBe("allow");
});

test("operad's tools are given to claude as an MCP server that runs from the program, with the home", async () => {
  const s = setup();
  s.input["operadTools"] = { home: "/operad/home" };
  const run = await runFake(s, { steps: done });
  expect(run.exitCode).toBe(0);
  const args = (run.record.find((entry) => "spawn" in entry)?.["spawn"] as { args: string[] }).args;
  const config = JSON.parse(flagValue(args, "--mcp-config") ?? "{}") as {
    mcpServers?: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = config.mcpServers?.["operad"];
  expect(server?.type).toBe("stdio");
  expect(server?.args.slice(-2)).toEqual(["--home", "/operad/home"]);
  expect(server?.args[0]).toMatch(/mcp\/src\/stdio\.ts$/);
  expect(server?.env["OPERAD_HOME"]).toBe("/operad/home");
});

test("a bot's servers are given to claude beside operad's, by name, as the commands the input names", async () => {
  const s = setup();
  s.input["operadTools"] = { home: "/operad/home" };
  s.input["mcpServers"] = { notes: { command: "/bin/guard", args: ["--bot", "default"] }, operad: { command: "/bin/evil", args: [] } };
  const run = await runFake(s, { steps: done });
  expect(run.exitCode).toBe(0);
  const args = (run.record.find((entry) => "spawn" in entry)?.["spawn"] as { args: string[] }).args;
  const config = JSON.parse(flagValue(args, "--mcp-config") ?? "{}") as {
    mcpServers?: Record<string, { command: string; args: string[] }>;
  };
  expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["notes", "operad"]);
  expect(config.mcpServers?.["notes"]).toMatchObject({ command: "/bin/guard", args: ["--bot", "default"] });
  // The name of operad's own server cannot be taken over.
  expect(config.mcpServers?.["operad"]?.command).not.toBe("/bin/evil");
});

test("without operadTools claude is given no MCP server", async () => {
  const run = await runFake(setup(), { steps: done });
  const args = (run.record.find((entry) => "spawn" in entry)?.["spawn"] as { args: string[] }).args;
  expect(flagValue(args, "--mcp-config")).toBeUndefined();
});

test("images are sent with the prompt as image blocks of the one user message", async () => {
  const s = setup();
  const photo = join(dirname(s.recordFile), "photo.png");
  writeFileSync(photo, "PNGDATA");
  s.input["images"] = [{ path: photo, mediaType: "image/png" }];
  const run = await runFake(s, { steps: done });
  expect(run.exitCode).toBe(0);
  const user = run.record.find((entry) => "user" in entry)?.["user"] as { content: unknown };
  expect(user.content).toEqual([
    { type: "text", text: s.input["prompt"] },
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("PNGDATA").toString("base64") } },
  ]);
});

test("parseInput refuses an image that is not a path with an image media type", () => {
  const base = { prompt: "p", cwd: "/c" };
  expect(parseInput({ ...base, images: [{ path: "/a.png", mediaType: "image/png" }] }).ok).toBe(true);
  expect(parseInput({ ...base, images: [{ path: "/a.pdf", mediaType: "application/pdf" }] }).ok).toBe(false);
  expect(parseInput({ ...base, images: "x" }).ok).toBe(false);
});
