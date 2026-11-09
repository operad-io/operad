import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inboxOf, messageLine, messageText, runAgent, type Clock } from "../src/index.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "operad-harness-process-test-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** Resolves when the file exists, watching the directory instead of polling. */
function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

interface ManualClock extends Clock {
  fireTimers(): number;
  when(predicate: () => boolean): Promise<void>;
  readonly pending: number;
  readonly sleeps: number;
}

/** A clock a test drives: the run never waits a real second for the drain. */
function manualClock(): ManualClock {
  const timers = new Set<{ readonly handler: () => void }>();
  const waiters: Array<{ readonly predicate: () => boolean; readonly resolve: () => void }> = [];
  let sleeps = 0;

  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.predicate()) continue;
      waiters.splice(index, 1);
      waiter.resolve();
    }
  };

  return {
    setTimeout(handler) {
      const timer = { handler };
      timers.add(timer);
      notify();
      return timer;
    },
    clearTimeout(handle) {
      timers.delete(handle as { readonly handler: () => void });
      notify();
    },
    sleep() {
      sleeps += 1;
      return Promise.resolve();
    },
    fireTimers() {
      const due = [...timers];
      timers.clear();
      for (const timer of due) timer.handler();
      notify();
      return due.length;
    },
    when(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
    get pending() {
      return timers.size;
    },
    get sleeps() {
      return sleeps;
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True for a pid a test may signal: a finite integer above 1. */
function signalable(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1;
}

/** Resolves with the pid a shell wrote to `path`; the file starts out empty. */
function waitForPid(path: string): Promise<number> {
  const read = (): number | undefined => {
    try {
      const pid = Number(readFileSync(path, "utf8").trim());
      return signalable(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  const first = read();
  if (first !== undefined) return Promise.resolve(first);
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      const pid = read();
      if (pid === undefined) return;
      watcher.close();
      resolve(pid);
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    const again = read();
    if (again !== undefined) {
      watcher.close();
      resolve(again);
    }
  });
}

/** A bounded poll for a process to go; there is no event for another's death. */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
}

describe("the harness process", () => {
  test("a harness still running when its host dies is stopped with its sentinel", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "harness.pid");
    const fixture = fileURLToPath(
      new URL("./fixtures/run-agent-orphan.ts", import.meta.url),
    );
    const host = Bun.spawn({
      cmd: [process.execPath, fixture, root, pidFile],
      stdout: "ignore",
      stderr: "ignore",
    });
    let sentinelPid: number | undefined;
    let harnessPid: number | undefined;
    try {
      harnessPid = await waitForPid(pidFile);
      sentinelPid = await waitForPid(`${pidFile}.sentinel`);
      // We started this host, so its death is ours to cause.
      process.kill(host.pid, "SIGKILL");
      await host.exited;
      await waitUntil(() => !alive(sentinelPid ?? 0) && !alive(harnessPid ?? 0));
      expect(alive(sentinelPid)).toBe(false);
      expect(alive(harnessPid)).toBe(false);
    } finally {
      try {
        process.kill(host.pid, "SIGKILL");
      } catch {
        // The host is gone.
      }
      if (signalable(sentinelPid) && alive(sentinelPid)) {
        try {
          process.kill(-sentinelPid, "SIGKILL");
        } catch {
          // The group ended after all.
        }
      }
    }
  }, 20_000);

  test("a child that leaves the group cannot hold the run open", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "escaped.pid");
    const clock = manualClock();
    const running = runAgent({
      command: "sh",
      args: ["-c", `set -m; sleep 60 & echo $! > '${pidFile}'`],
      cwd: root,
      wallMs: 0,
      stallMs: 0,
      signal: new AbortController().signal,
      clock,
      onLine() {},
    });

    // The drain grace comes from the injected clock, so the test ends it.
    await clock.when(() => clock.pending > 0);
    expect(clock.fireTimers()).toBe(1);

    const outcome = await running;
    const pid = await waitForPid(pidFile);
    try {
      expect(outcome.exitCode).toBe(0);
      expect(alive(pid)).toBe(true);
      // A finished command is stopped directly, without the KILL grace.
      expect(clock.sleeps).toBe(0);
    } finally {
      if (signalable(pid) && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

describe("runAgent with an interactive stdin", () => {
  const script = [
    "const reader = Bun.stdin.stream().getReader();",
    "let text = '';",
    "const next = async () => { for (;;) { const i = text.indexOf('\\n'); if (i !== -1) { const l = text.slice(0, i); text = text.slice(i + 1); return l; } const c = await reader.read(); if (c.done) { const rest = text; text = ''; return rest.length > 0 ? rest : null; } text += new TextDecoder().decode(c.value); } };",
    "const first = await next();",
    "console.log(JSON.stringify({ first }));",
    "const answer = await next();",
    "console.log(JSON.stringify({ answer }));",
    "process.exit(0);",
  ].join("\n");

  test("a line can be answered while stdin stays open", async () => {
    const lines: string[] = [];
    const outcome = await runAgent({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      stdin: "the prompt",
      interactive: true,
      wallMs: 30_000,
      stallMs: 30_000,
      signal: new AbortController().signal,
      onLine(line, reply) {
        lines.push(line);
        if (line.includes('"first"')) reply("the reply");
      },
    });
    expect(outcome.exitCode).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { first: "the prompt" },
      { answer: "the reply" },
    ]);
  });

  test("without interactive, stdin ends after the prompt and a reply is dropped", async () => {
    const lines: string[] = [];
    const outcome = await runAgent({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      stdin: "the prompt",
      wallMs: 30_000,
      stallMs: 30_000,
      signal: new AbortController().signal,
      onLine(line, reply) {
        lines.push(line);
        reply("ignored");
      },
    });
    expect(outcome.exitCode).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ first: "the prompt" }, { answer: null }]);
  });
});

describe("runAgent with an inbox", () => {
  const script = [
    "const reader = Bun.stdin.stream().getReader();",
    "let text = '';",
    "const next = async () => { for (;;) { const i = text.indexOf('\\n'); if (i !== -1) { const l = text.slice(0, i); text = text.slice(i + 1); return l; } const c = await reader.read(); if (c.done) return null; text += new TextDecoder().decode(c.value); } };",
    "await next();",
    "console.log(JSON.stringify({ ready: true }));",
    "console.log(JSON.stringify({ got: await next() }));",
    "process.exit(0);",
  ].join("\n");

  test("a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end", async () => {
    const lines: string[] = [];
    let stopped = 0;
    let send: (text: string) => void = () => undefined;
    const inbox = {
      listen(handler: (text: string) => void): () => void {
        send = handler;
        return () => {
          stopped += 1;
        };
      },
    };
    const outcome = await runAgent({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      stdin: "the prompt",
      interactive: true,
      inbox,
      wallMs: 30_000,
      stallMs: 30_000,
      signal: new AbortController().signal,
      onLine(line) {
        lines.push(line);
        if (line.includes("ready")) send("wrap up");
      },
    });
    expect(outcome.exitCode).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { ready: true },
      { got: JSON.stringify({ type: "message", text: "wrap up" }) },
    ]);
    expect(stopped).toBe(1);
  });

  test("inboxOf reads only an object with a listen method; messageText only a message line", () => {
    expect(inboxOf({ inbox: { listen: () => () => undefined } })).toBeDefined();
    expect(inboxOf({ inbox: {} })).toBeUndefined();
    expect(inboxOf({})).toBeUndefined();
    expect(inboxOf(undefined)).toBeUndefined();
    expect(messageText(messageLine("hi"))).toBe("hi");
    expect(messageText('{"type":"grant_ack","id":1,"used":true}')).toBeUndefined();
    expect(messageText("not json")).toBeUndefined();
  });
});
