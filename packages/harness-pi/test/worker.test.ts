import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInput, THINKING_LEVELS } from "../src/protocol.ts";

const REAL_WORKER = join(import.meta.dir, "..", "src", "worker.ts");
const FAKE_WORKER = join(import.meta.dir, "fake-worker.ts");
/** The devDependency copy of pi, reached the way a user's `pi` is: through its bin link. */
export const DEV_PI = join(import.meta.dir, "..", "node_modules", ".bin", "pi");

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-pi-worker-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Setup {
  dir: string;
  home: string;
  input: Record<string, unknown>;
}

function setup(): Setup {
  const dir = tempDir();
  const home = join(dir, "home");
  mkdirSync(home);
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  return {
    dir,
    home,
    input: {
      prompt: "hello",
      piCommand: DEV_PI,
      cwd,
      model: "fake/fake-model",
      authPath: join(dir, "agent", "auth.json"),
      modelsPath: join(dir, "agent", "models.json"),
      agentDir: join(dir, "agent"),
      sessionDir: join(dir, "sessions"),
    },
  };
}

interface Run {
  lines: Array<Record<string, unknown>>;
  raw: string[];
  stderr: string;
  exitCode: number;
}

class Child {
  readonly #process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #stderrText: Promise<string>;
  readonly #stdoutText: Promise<string>;
  readonly #waiters = new Set<() => void>();
  #stderr = "";

  constructor(file: string, home: string, env: Record<string, string>) {
    this.#process = Bun.spawn(["bun", file], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, ...env },
    });
    this.#stdoutText = new Response(this.#process.stdout).text();
    this.#stderrText = this.#readStderr(this.#process.stderr);
  }

  async #readStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.#stderr += decoder.decode(chunk, { stream: true });
      for (const wake of this.#waiters) wake();
      this.#waiters.clear();
    }
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
    return this.#stderr;
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
    while (!this.#stderr.includes(text)) {
      if (ended) throw new Error(`the child ended before "${text}": ${this.#stderr}`);
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }

  signal(name: NodeJS.Signals): void {
    this.#process.kill(name);
  }

  async finish(): Promise<Run> {
    const exitCode = await this.#process.exited;
    const out = await this.#stdoutText;
    const stderr = await this.#stderrText;
    const raw = out.split("\n").filter((line) => line.length > 0);
    return { lines: raw.map((line) => JSON.parse(line) as Record<string, unknown>), raw, stderr, exitCode };
  }
}

async function runFake(
  s: Setup,
  script: unknown[],
  input: Record<string, unknown> = s.input,
  env: Record<string, string> = {},
): Promise<Run> {
  const child = new Child(FAKE_WORKER, s.home, { FAKE_SCRIPT: JSON.stringify(script), ...env });
  child.send(JSON.stringify(input));
  return child.finish();
}

function kinds(run: Run): unknown[] {
  return run.lines.map((line) => line["type"]);
}

function last(run: Run): Record<string, unknown> {
  const line = run.lines.at(-1);
  if (line === undefined) throw new Error("the program wrote no line");
  return line;
}

test("a prompt that ends writes the lines in order and a Result with usage, cost and sessionId", async () => {
  const s = setup();
  const run = await runFake(s, [{ text: "ANSWER", cost: 0.0015 }]);

  expect(run.exitCode).toBe(0);
  expect(kinds(run)).toEqual(["message_end", "agent_settled", "result"]);
  expect(run.lines[0]).toEqual({
    type: "message_end",
    role: "assistant",
    stopReason: "stop",
    usage: { input: 12, output: 6, cache_read: 3, cache_write: 2 },
    cost: { total: 0.0015 },
  });
  expect(run.lines[1]).toEqual({ type: "agent_settled", aborted: false });

  const result = last(run);
  expect(result["result"]).toBe("done");
  expect(result["usage"]).toEqual({ input: 12, output: 6, cache_read: 3, cache_write: 2 });
  expect(result["cost"]).toEqual({ micros: 1500 });
  expect(result["finalMessage"]).toBe("ANSWER");
  const sessionId = result["sessionId"];
  expect(typeof sessionId).toBe("string");
  expect(String(sessionId).startsWith(String(s.input["sessionDir"]))).toBe(true);
  expect(existsSync(String(sessionId))).toBe(true);
  expect(Object.keys(result).sort()).toEqual(["cost", "finalMessage", "result", "sessionId", "type", "usage"]);
});

test("usage and cost are summed over every message_end, with a tool call between", async () => {
  const s = setup();
  const note = join(s.dir, "note.txt");
  writeFileSync(note, "x\n");
  const run = await runFake(s, [
    { text: "", cost: 0.000001, toolCall: { name: "read", arguments: { path: note } } },
    { text: "finished", cost: 0.000002 },
  ]);

  expect(kinds(run)).toEqual([
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "message_end",
    "agent_settled",
    "result",
  ]);
  expect(run.lines[1]).toMatchObject({ toolName: "read" });
  expect(run.lines[2]).toMatchObject({ toolName: "read", isError: false });
  const result = last(run);
  expect(result["usage"]).toEqual({ input: 24, output: 16, cache_read: 6, cache_write: 4 });
  expect(result["cost"]).toEqual({ micros: 3 });
  expect(run.stderr).toContain("tool_call read");
});

test("a denied bash call is blocked, a blocked line is written, the model gets the reason and the run ends done", async () => {
  const s = setup();
  const marker = join(s.dir, "marker");
  const contexts = join(s.dir, "contexts.jsonl");
  const run = await runFake(
    s,
    [
      { text: "", toolCall: { name: "bash", arguments: { command: `echo hi && touch ${marker}` } } },
      { text: "I was refused" },
    ],
    { ...s.input, access: { denyCommands: ["touch"] } },
    { FAKE_CONTEXT_FILE: contexts },
  );

  const reason = `part "touch ${marker}" is refused by denyCommands rule "touch"`;
  expect(run.exitCode).toBe(0);
  expect(run.lines.filter((line) => line["type"] === "blocked")).toEqual([
    { type: "blocked", toolName: "bash", reason },
  ]);
  expect(existsSync(marker)).toBe(false);
  expect(run.lines.find((line) => line["type"] === "tool_execution_end")).toMatchObject({ toolName: "bash", isError: true });
  expect(last(run)).toMatchObject({ result: "done", finalMessage: "I was refused" });
  const calls = readFileSync(contexts, "utf-8").split("\n").filter((line) => line.length > 0);
  expect(calls.length).toBe(2);
  expect(calls[1]).toContain(reason.replaceAll('"', '\\"'));
});

test("a read of a denied path is blocked; an allowed read runs", async () => {
  const s = setup();
  const secrets = join(s.dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "key"), "k\n");
  const note = join(s.dir, "note.txt");
  writeFileSync(note, "x\n");
  const run = await runFake(
    s,
    [
      { text: "", toolCall: { name: "read", arguments: { path: join(secrets, "key") } } },
      { text: "", toolCall: { name: "read", arguments: { path: note } } },
      { text: "finished" },
    ],
    { ...s.input, access: { denyPaths: [secrets] } },
  );

  expect(run.lines.filter((line) => line["type"] === "blocked")).toEqual([
    {
      type: "blocked",
      toolName: "read",
      reason: `path "${join(secrets, "key")}" is under denyPaths entry "${secrets}"`,
    },
  ]);
  expect(run.lines.filter((line) => line["type"] === "tool_execution_end")).toMatchObject([
    { toolName: "read", isError: true },
    { toolName: "read", isError: false },
  ]);
  expect(last(run)).toMatchObject({ result: "done", finalMessage: "finished" });
});

test("without a profile nothing is blocked", async () => {
  const s = setup();
  const run = await runFake(s, [
    { text: "", toolCall: { name: "bash", arguments: { command: "echo hi; bash -c true" } } },
    { text: "finished" },
  ]);
  expect(run.lines.some((line) => line["type"] === "blocked")).toBe(false);
  expect(last(run)).toMatchObject({ result: "done", finalMessage: "finished" });
});

test("an access profile with a bad denyPaths is invalid input naming access.denyPaths", async () => {
  const s = setup();
  const child = new Child(REAL_WORKER, s.home, {});
  child.send(JSON.stringify({ ...s.input, access: { denyPaths: "~/.ssh" } }));
  const run = await child.finish();
  expect(run.exitCode).toBe(2);
  expect(String(last(run)["message"])).toContain("access.denyPaths");
});

test("a model with no price has cost.micros null", async () => {
  const s = setup();
  const run = await runFake(s, [{ text: "ANSWER", noPrice: true }]);

  expect(run.exitCode).toBe(0);
  expect(run.lines[0]).toMatchObject({ type: "message_end", cost: null });
  expect(last(run)).toMatchObject({ result: "done", cost: null, finalMessage: "ANSWER" });
});

test("a run where one message had no price reports the priced part as incomplete", async () => {
  const s = setup();
  const note = join(s.dir, "note.txt");
  writeFileSync(note, "x");
  const run = await runFake(s, [
    { text: "", cost: 0.000001, toolCall: { name: "read", arguments: { path: note } } },
    { text: "finished", noPrice: true },
  ]);
  expect(run.exitCode).toBe(0);
  expect(last(run)["cost"]).toEqual({ micros: 1, incomplete: true });
});

test("a free model that reports 0 is cost 0, not unknown", async () => {
  const s = setup();
  const run = await runFake(s, [{ text: "ANSWER" }]);
  expect(last(run)["cost"]).toEqual({ micros: 0 });
});

test("resume: the second run sees the first answer in the context the fake model receives", async () => {
  const s = setup();
  const contexts = join(s.dir, "contexts.jsonl");
  const env = { FAKE_CONTEXT_FILE: contexts };

  const first = await runFake(s, [{ text: "FIRST_ANSWER" }], { ...s.input, prompt: "FIRST_MARKER" }, env);
  const sessionId = last(first)["sessionId"];
  expect(typeof sessionId).toBe("string");

  const second = await runFake(
    s,
    [{ text: "SECOND_ANSWER" }],
    { ...s.input, prompt: "SECOND_MARKER", resumeSession: sessionId },
    env,
  );
  expect(second.exitCode).toBe(0);
  expect(last(second)).toMatchObject({ result: "done", sessionId, finalMessage: "SECOND_ANSWER" });

  const calls = readFileSync(contexts, "utf-8").split("\n").filter((line) => line.length > 0);
  expect(calls.length).toBe(2);
  expect(calls[0]).not.toContain("SECOND_MARKER");
  expect(calls[1]).toContain("FIRST_MARKER");
  expect(calls[1]).toContain("FIRST_ANSWER");
  expect(calls[1]).toContain("SECOND_MARKER");
  // The session file is the same one; no second file was made.
  expect(readdirSync(String(s.input["sessionDir"])).length).toBe(1);
});

test("the worker logs the pi version it loaded and where from", async () => {
  const s = setup();
  const run = await runFake(s, [{ text: "ok" }]);
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toMatch(/pi \d+\.\d+\.\d+\S* loaded from .*pi-coding-agent/);
});

test("without a pi the worker fails with the model_error reason and says what is missing", async () => {
  const s = setup();
  const run = await runFake(s, [], { ...s.input, piCommand: join(s.dir, "no-such-pi") });
  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ result: "failed", reason: "model_error" });
  expect(String(last(run)["message"])).toContain("no-such-pi");
});

test("a missing session file is failed and names the path", async () => {
  const s = setup();
  const missing = join(s.dir, "sessions", "nope.jsonl");
  const run = await runFake(s, [{ text: "unused" }], { ...s.input, resumeSession: missing });

  expect(run.exitCode).toBe(1);
  expect(run.lines.length).toBe(1);
  expect(last(run)).toMatchObject({ type: "result", result: "failed", reason: "session_missing" });
  expect(String(last(run)["message"])).toContain(missing);
});

test("an unknown model is failed and names the model", async () => {
  const s = setup();
  const run = await runFake(s, [], { ...s.input, model: "fake/other" });
  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ result: "failed", reason: "model_missing" });
  expect(String(last(run)["message"])).toContain("fake/other");
});

test("a model error is failed with its message", async () => {
  const s = setup();
  // No response is queued, so the fake model ends with stopReason "error".
  const run = await runFake(s, []);
  expect(run.exitCode).toBe(1);
  expect(last(run)).toMatchObject({ result: "failed", reason: "model_error" });
  expect(String(last(run)["message"])).toContain("No more fake responses");
});

// Each case names the field the Result must name.
const INVALID: Array<[string, (input: Record<string, unknown>) => unknown]> = [
  ["prompt", ({ prompt: _, ...rest }) => rest],
  ["cwd", (input) => ({ ...input, cwd: 3 })],
  ["authPath", (input) => ({ ...input, authPath: "" })],
  ["modelsPath", ({ modelsPath: _, ...rest }) => rest],
  ["agentDir", (input) => ({ ...input, agentDir: null })],
  ["sessionDir", ({ sessionDir: _, ...rest }) => rest],
  ["resumeSession", (input) => ({ ...input, resumeSession: 7 })],
  ["model", (input) => ({ ...input, model: "no-slash" })],
  ["thinkingLevel", (input) => ({ ...input, thinkingLevel: "loud" })],
  ["access", (input) => ({ ...input, access: "deny" })],
];

for (const [field, break_] of INVALID) {
  test(`invalid stdin: a bad ${field} is one failed Result naming it, exit 2`, async () => {
    const s = setup();
    const child = new Child(REAL_WORKER, s.home, {});
    child.send(JSON.stringify(break_(s.input)));
    const run = await child.finish();

    expect(run.exitCode).toBe(2);
    expect(run.lines.length).toBe(1);
    expect(last(run)).toMatchObject({ type: "result", result: "failed", reason: "invalid_input" });
    expect(String(last(run)["message"])).toContain(field);
  });
}

test("invalid stdin: text that is not JSON, and JSON that is not an object", async () => {
  const s = setup();
  for (const text of ["not json", "[1]", "null", ""]) {
    const child = new Child(REAL_WORKER, s.home, {});
    child.send(text);
    const run = await child.finish();
    expect(run.exitCode).toBe(2);
    expect(run.lines.length).toBe(1);
    expect(last(run)).toMatchObject({ result: "failed", reason: "invalid_input" });
  }
});

test("parseInput accepts every documented field and every thinking level", () => {
  const s = setup();
  for (const level of THINKING_LEVELS) {
    const parsed = parseInput({
      ...s.input,
      resumeSession: "/some/file.jsonl",
      thinkingLevel: level,
      access: { denyCommands: ["rm"] },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.thinkingLevel).toBe(level);
  }
});

test("SIGTERM during a slow fake stream writes a cancelled Result and exits 143", async () => {
  const s = setup();
  const child = new Child(FAKE_WORKER, s.home, { FAKE_SCRIPT: JSON.stringify([{ text: "never", hang: true }]) });
  child.send(JSON.stringify(s.input));
  await child.stderrHas("fake-stream-started");
  child.signal("SIGTERM");
  const run = await child.finish();

  expect(run.exitCode).toBe(143);
  expect(last(run)).toMatchObject({ type: "result", result: "cancelled", finalMessage: null });
  expect(typeof last(run)["sessionId"]).toBe("string");
  expect(kinds(run).filter((kind) => kind === "result").length).toBe(1);
  expect(kinds(run).at(-1)).toBe("result");
});

test("nothing under the fake HOME .pi is read or created", async () => {
  const s = setup();
  const agent = join(s.home, ".pi", "agent");
  mkdirSync(join(agent, "skills"), { recursive: true });
  const files = ["auth.json", "models.json", "settings.json", "AGENTS.md", join("skills", "x.md")].map((name) =>
    join(agent, name),
  );
  // A read moves a file's access time only when it is older than its
  // modification time, so give every file an access time well before it.
  const long = new Date("2020-01-01T00:00:00Z");
  const recent = new Date("2021-01-01T00:00:00Z");
  for (const file of files) {
    writeFileSync(file, file.endsWith(".json") ? "{}" : "SHOULD_NOT_BE_READ");
    utimesSync(file, long, recent);
  }
  const before = files.map((file) => statSync(file).atimeMs);
  const run = await runFake(s, [{ text: "ANSWER" }]);

  expect(run.exitCode).toBe(0);
  expect(last(run)).toMatchObject({ result: "done" });
  expect(files.map((file) => statSync(file).atimeMs)).toEqual(before);
  // Bun's own transpiler cache makes Library/ under HOME; it is not pi's.
  expect(readdirSync(s.home).filter((name) => name !== "Library")).toEqual([".pi"]);
  expect(readdirSync(join(s.home, ".pi")).sort()).toEqual(["agent"]);
  expect(readdirSync(agent).sort()).toEqual(["AGENTS.md", "auth.json", "models.json", "settings.json", "skills"]);
});

/**
 * Runs the fake worker with a host that answers `grant_use` lines: the worker
 * keeps stdin open, writes a line, and waits for the host's acknowledgement.
 * `decide` sees each request before the answer goes back.
 */
async function runGranting(
  s: Setup,
  script: unknown[],
  input: Record<string, unknown>,
  decide: (waitId: string) => boolean,
): Promise<Run> {
  const child = Bun.spawn(["bun", FAKE_WORKER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: s.home, FAKE_SCRIPT: JSON.stringify(script) },
  });
  child.stdin.write(`${JSON.stringify(input)}\n`);
  void child.stdin.flush();
  const raw: string[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of child.stdout) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      raw.push(line);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["type"] === "grant_use") {
        const used = decide(String(parsed["waitId"]));
        child.stdin.write(`${JSON.stringify({ type: "grant_ack", id: parsed["id"], used })}\n`);
        void child.stdin.flush();
      }
    }
  }
  const exitCode = await child.exited;
  const stderr = await new Response(child.stderr).text();
  return { lines: raw.map((line) => JSON.parse(line) as Record<string, unknown>), raw, stderr, exitCode };
}

test("a granted call runs once after the host used the grant; the same call again and another call are blocked", async () => {
  const s = setup();
  const marker = join(s.dir, "marker");
  const other = join(s.dir, "other");
  const grants = [{ waitId: "w1", kind: "command", value: `touch ${marker}` }];
  const used = new Set<string>();
  let markerSeenAtGrant: boolean | undefined;
  const run = await runGranting(
    s,
    [
      { text: "", toolCall: { name: "bash", arguments: { command: `touch ${marker}` } } },
      { text: "", toolCall: { name: "bash", arguments: { command: `touch ${marker}` } } },
      { text: "", toolCall: { name: "bash", arguments: { command: `touch ${other}` } } },
      { text: "finished" },
    ],
    { ...s.input, access: { denyCommands: ["touch"], grants } },
    (waitId) => {
      // The host's fact is written before the call: the file is not there yet.
      markerSeenAtGrant ??= existsSync(marker);
      if (used.has(waitId)) return false;
      used.add(waitId);
      return true;
    },
  );

  expect(run.exitCode).toBe(0);
  expect(markerSeenAtGrant).toBe(false);
  expect(existsSync(marker)).toBe(true);
  expect(existsSync(other)).toBe(false);
  // Two calls asked for the grant; only the first got it. The other command
  // matched no grant and never asked.
  expect(run.lines.filter((line) => line["type"] === "grant_use")).toHaveLength(2);
  expect(run.lines.filter((line) => line["type"] === "blocked")).toHaveLength(2);
  expect(last(run)).toMatchObject({ result: "done", finalMessage: "finished" });
});

test("a grant the host cannot confirm lets nothing through", async () => {
  const s = setup();
  const marker = join(s.dir, "marker");
  const run = await runFake(
    s,
    [
      { text: "", toolCall: { name: "bash", arguments: { command: `touch ${marker}` } } },
      { text: "finished" },
    ],
    {
      ...s.input,
      access: {
        denyCommands: ["touch"],
        grants: [{ waitId: "w1", kind: "command", value: `touch ${marker}` }],
      },
    },
  );
  // stdin ended: nobody can write the fact, so the grant does not apply.
  expect(existsSync(marker)).toBe(false);
  expect(run.lines.filter((line) => line["type"] === "blocked")).toHaveLength(1);
});
