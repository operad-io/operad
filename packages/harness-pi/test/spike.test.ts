import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { FakeProvider } from "../spike/fake-provider.ts";
import {
  createSpikeModelRuntime,
  createSpikeSession,
  newFileSession,
  openFileSession,
} from "../spike/pi-session.ts";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-harness-pi-"));
  temps.push(dir);
  return dir;
}

function assistantUsage(events: AgentSessionEvent[]): Array<{ totalTokens: number; totalCost: number }> {
  const usages: Array<{ totalTokens: number; totalCost: number }> = [];
  for (const event of events) {
    if (event.type !== "message_end") continue;
    if (event.message.role !== "assistant") continue;
    usages.push({
      totalTokens: event.message.usage.totalTokens,
      totalCost: event.message.usage.cost.total,
    });
  }
  return usages;
}

async function withSession(
  dir: string,
  provider: FakeProvider,
  sessionManager: SessionManager,
  run: (session: Awaited<ReturnType<typeof createSpikeSession>>) => Promise<void>,
): Promise<void> {
  const runtime = await createSpikeModelRuntime({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
  provider.register(runtime);
  const model = runtime.getModel(provider.providerId, provider.modelId);
  if (model === undefined) throw new Error("the fake model is not registered");
  const session = await createSpikeSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    modelRuntime: runtime,
    model,
    sessionManager,
  });
  try {
    await run(session);
  } finally {
    session.dispose();
  }
}

type PipedProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

/** Lines a writer process printed, with waiters driven by the stream. */
class ChildWriter {
  readonly lines: string[] = [];
  readonly exited: Promise<number>;
  readonly #stderr: Promise<string>;
  readonly #consumed: Promise<void>;
  readonly #waiters = new Set<() => void>();
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #ended = false;

  constructor(process: PipedProcess) {
    this.exited = process.exited;
    this.#stderr = new Response(process.stderr).text();
    this.#consumed = this.#consume(process.stdout);
    void process.exited.then(() => {
      this.#ended = true;
      this.#wake();
    });
  }

  async #consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      this.#buffer += this.#decoder.decode(value, { stream: true });
      for (;;) {
        const index = this.#buffer.indexOf("\n");
        if (index < 0) break;
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.length === 0) continue;
        this.lines.push(line);
        this.#wake();
      }
    }
  }

  #wake(): void {
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  async waitFor(line: string): Promise<void> {
    for (;;) {
      if (this.lines.includes(line)) return;
      if (this.#ended) {
        await this.#consumed.catch(() => {});
        if (this.lines.includes(line)) return;
        const stderr = await this.#stderr;
        throw new Error(`the writer ended before "${line}": ${stderr}`);
      }
      const wait = new Promise<void>((resolve) => this.#waiters.add(resolve));
      // A line or the end may have arrived between the checks and the add.
      if (this.lines.includes(line) || this.#ended) this.#wake();
      await wait;
    }
  }
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prompt ends with the fixed answer and message_end carries usage", async () => {
  const dir = tempDir();
  const provider = new FakeProvider();
  provider.enqueue({ text: "SPIKE_ANSWER" });

  await withSession(dir, provider, SessionManager.inMemory(), async (session) => {
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.prompt("Say the fixed answer.");

    expect(session.getLastAssistantText()).toBe("SPIKE_ANSWER");
    const usages = assistantUsage(events);
    expect(usages.length).toBe(1);
    expect(usages[0]?.totalTokens).toBeGreaterThan(0);
    expect(usages[0]?.totalCost).toBe(0);
    expect(provider.contexts.length).toBe(1);
  });
});

test("a tool call to read runs", async () => {
  const dir = tempDir();
  const note = join(dir, "note.txt");
  writeFileSync(note, "hello from the spike\n");
  const provider = new FakeProvider();
  provider.enqueue({ text: "", toolCall: { name: "read", arguments: { path: note } } });
  provider.enqueue({ text: "read finished" });

  await withSession(dir, provider, SessionManager.inMemory(), async (session) => {
    const started: string[] = [];
    const ended: string[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") started.push(event.toolName);
      if (event.type === "tool_execution_end") ended.push(event.toolName);
    });

    await session.prompt("Read note.txt.");

    expect(started).toEqual(["read"]);
    expect(ended).toEqual(["read"]);
    expect(session.getLastAssistantText()).toBe("read finished");
  });
});

test("a session file reopens and a second prompt sees the first message", async () => {
  const dir = tempDir();
  const cwd = join(dir, "work");
  const sessionDir = join(dir, "sessions");
  mkdirSync(cwd);
  mkdirSync(sessionDir);

  const provider = new FakeProvider();
  provider.enqueue({ text: "first answer" });
  provider.enqueue({ text: "second answer" });

  let sessionFile: string | undefined;
  await withSession(dir, provider, newFileSession(cwd, sessionDir), async (session) => {
    await session.prompt("FIRST_MARKER");
    expect(session.getLastAssistantText()).toBe("first answer");
    sessionFile = session.sessionFile;
  });

  expect(sessionFile).toBeDefined();
  if (sessionFile === undefined) throw new Error("the session file is missing");
  expect(existsSync(sessionFile)).toBe(true);

  const reopened = openFileSession(sessionFile, sessionDir);
  const before = JSON.stringify(reopened.buildSessionContext().messages);
  expect(before).toContain("FIRST_MARKER");
  expect(before).toContain("first answer");

  await withSession(dir, provider, reopened, async (session) => {
    await session.prompt("SECOND_MARKER");
    expect(session.getLastAssistantText()).toBe("second answer");
  });

  const secondContext = provider.contexts[1];
  if (secondContext === undefined) throw new Error("the second prompt did not reach the model");
  const carried = JSON.stringify(secondContext.messages);
  expect(carried).toContain("FIRST_MARKER");
  expect(carried).toContain("first answer");
  expect(carried).toContain("SECOND_MARKER");

  const after = JSON.stringify(SessionManager.open(sessionFile, sessionDir).buildSessionContext().messages);
  expect(after).toContain("SECOND_MARKER");
  expect(after).toContain("second answer");
});

test("abort() during a slow fake stream returns", async () => {
  const dir = tempDir();
  const provider = new FakeProvider();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  provider.enqueue({ text: "this text must never finish", before: gate });

  await withSession(dir, provider, SessionManager.inMemory(), async (session) => {
    const aborted: boolean[] = [];
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        aborted.push(event.message.stopReason === "aborted");
      }
    });

    const promptRun = session.prompt("Wait forever.");
    await provider.started;
    await session.abort();
    await promptRun;

    expect(aborted).toContain(true);
    expect(session.getLastAssistantText()).toBeUndefined();
  });
  release?.();
});

test("auth.json locking blocks a second writer until the lock is released", async () => {
  const dir = tempDir();
  const authPath = join(dir, "auth.json");
  const modelsPath = join(dir, "models.json");
  const release = join(dir, "release");
  const script = join(import.meta.dir, "..", "spike", "auth-writer.ts");
  writeFileSync(authPath, "{}");

  const spawn = (mode: string, providerId: string) =>
    new ChildWriter(
      Bun.spawn(["bun", script, mode, authPath, modelsPath, release, providerId], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

  const holder = spawn("hold", "holder");
  await holder.waitFor("held");

  const writer = spawn("blocked-write", "writer");
  await writer.waitFor("blocked");
  await writer.waitFor("ready");
  expect(writer.lines).not.toContain("acquired-early");

  // The writer is at pi's read-modify-write and the lock is still held, so its
  // credential must not be on disk yet. Releasing it is the test's event.
  const beforeRelease = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
  expect(Object.keys(beforeRelease)).toEqual(["holder"]);
  writeFileSync(release, "release");
  await holder.waitFor("released");
  await writer.waitFor("wrote");

  expect(await holder.exited).toBe(0);
  expect(await writer.exited).toBe(0);
  expect(writer.lines).not.toContain("acquired-early");

  const stored = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
  expect(Object.keys(stored).sort()).toEqual(["holder", "writer"]);
}, 30_000);

test("the same read-modify-write without the lock loses a credential", async () => {
  const dir = tempDir();
  const authPath = join(dir, "auth.json");
  const modelsPath = join(dir, "models.json");
  const go = join(dir, "go");
  const script = join(import.meta.dir, "..", "spike", "auth-writer.ts");
  writeFileSync(authPath, "{}");

  const spawn = (mode: string, providerId: string) =>
    new ChildWriter(
      Bun.spawn(["bun", script, mode, authPath, modelsPath, go, providerId], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

  // The reader snapshots the empty file, the writer replaces it, and the
  // reader then writes its stale snapshot over the writer's credential.
  const reader = spawn("unlocked-read", "reader");
  await reader.waitFor("read");
  const writer = spawn("unlocked-write", "writer");
  await writer.waitFor("wrote");
  writeFileSync(go, "go");
  await reader.waitFor("wrote");

  expect(await reader.exited).toBe(0);
  expect(await writer.exited).toBe(0);

  const stored = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
  expect(Object.keys(stored)).toEqual(["reader"]);
  expect(Object.keys(stored)).not.toContain("writer");
}, 30_000);
