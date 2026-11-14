import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  LockTimeoutError,
  lockTestHooks,
  openWaitHandleCount,
  withLockFile,
} from "../../src/platform/index.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "operad-lock-test-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

afterEach(() => {
  expect(openWaitHandleCount()).toBe(0);
});

/** The lock under test, in a directory of its own like a plugin's state. */
function withRepositoryLock<T>(
  directory: string,
  work: () => Promise<T> | T,
  options: { clock?: () => number; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  return withLockFile(lockPathOf(directory), work, options);
}

const HOLDER = fileURLToPath(
  new URL("../fixtures/lock-holder.ts", import.meta.url),
);

async function setup(): Promise<{ readonly root: string; readonly repositoryPath: string }> {
  const root = await tempRoot();
  const repositoryPath = join(root, "state");
  mkdirSync(repositoryPath, { recursive: true });
  return { root, repositoryPath };
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", "0"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const pid = child.pid;
  await child.exited;
  return pid;
}

function lockPathOf(repositoryPath: string): string {
  return join(repositoryPath, ".operad", "work.lock");
}

function leaveLock(
  repositoryPath: string,
  pid: number,
  nonce = "dead-nonce",
): string {
  mkdirSync(join(repositoryPath, ".operad"), { recursive: true });
  const path = lockPathOf(repositoryPath);
  writeFileSync(
    path,
    JSON.stringify({ pid, startedAt: null, nonce }),
    "utf8",
  );
  return path;
}

function staleFiles(repositoryPath: string): readonly string[] {
  const directory = join(repositoryPath, ".operad");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) =>
    name.startsWith("work.lock.stale."),
  );
}

interface StartWaiter {
  readonly resolve: (pid: number) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Reads `start <pid>` lines from the holders' pipes in the order they acquire
 * the lock. A pipe is an event stream, so no line falls between a file check
 * and a watcher registration.
 */
function startQueue(
  children: readonly { readonly stdout: ReadableStream<Uint8Array> }[],
): () => Promise<number> {
  const starts: number[] = [];
  const waiting: StartWaiter[] = [];
  const fail = (error: Error): void => {
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };
  for (const child of children) {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let sawStart = false;
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (value !== undefined) text += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = text.indexOf("\n");
          if (newline < 0) break;
          const line = text.slice(0, newline);
          text = text.slice(newline + 1);
          if (!line.startsWith("start ")) continue;
          sawStart = true;
          const pid = Number(line.slice("start ".length));
          const waiter = waiting.shift();
          if (waiter === undefined) starts.push(pid);
          else waiter.resolve(pid);
        }
        if (done) {
          reader.releaseLock();
          if (!sawStart) fail(new Error("a holder ended before it acquired the lock"));
          return;
        }
      }
    })();
  }
  return () => {
    const pid = starts.shift();
    if (pid !== undefined) return Promise.resolve(pid);
    return new Promise<number>((resolve, reject) => {
      waiting.push({ resolve, reject });
    });
  };
}

describe("the lock file", () => {
  test("a crash between the tmp write and the link leaves no lock", async () => {
    const { repositoryPath } = await setup();
    lockTestHooks.beforeLink = () => {
      throw new Error("crash");
    };
    try {
      await expect(
        withRepositoryLock(repositoryPath, () => undefined),
      ).rejects.toThrow("crash");
    } finally {
      lockTestHooks.beforeLink = undefined;
    }
    expect(existsSync(lockPathOf(repositoryPath))).toBe(false);
  });

  test("a lock left by a dead pid is taken over", async () => {
    const { repositoryPath } = await setup();
    leaveLock(repositoryPath, await deadPid());
    let ran = false;
    await withRepositoryLock(repositoryPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(existsSync(lockPathOf(repositoryPath))).toBe(false);
    expect(staleFiles(repositoryPath)).toEqual([]);
  });

  test("exactly one of five spawned waiters holds the lock at a time", async () => {
    const { root, repositoryPath } = await setup();
    leaveLock(repositoryPath, await deadPid());
    const result = join(root, "holders.txt");
    const children = Array.from({ length: 5 }, () =>
      Bun.spawn({
        cmd: [process.execPath, HOLDER, lockPathOf(repositoryPath), result],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    try {
      // Each holder holds the section until the test acknowledges its start:
      // the test decides the order and the duration, not a fixed sleep.
      const nextStart = startQueue(children);
      for (let index = 0; index < children.length; index += 1) {
        const pid = await nextStart();
        const child = children.find((item) => item.pid === pid);
        if (child === undefined) throw new Error(`no holder has pid ${pid}`);
        child.stdin.write("go\n");
        await child.stdin.end();
      }
      const codes = await Promise.all(children.map((child) => child.exited));
      expect(codes).toEqual([0, 0, 0, 0, 0]);

      const lines = readFileSync(result, "utf8").trim().split("\n");
      expect(lines).toHaveLength(10);
      let active = 0;
      for (const line of lines) {
        if (line.startsWith("start ")) {
          active += 1;
          expect(active).toBe(1);
        } else {
          active -= 1;
          expect(active).toBe(0);
        }
      }
      expect(staleFiles(repositoryPath)).toEqual([]);
    } finally {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The holder already exited.
        }
      }
    }
  }, 30_000);

  test("a newer live lock renamed during a takeover is put back", async () => {
    const { repositoryPath } = await setup();
    const lock = leaveLock(repositoryPath, await deadPid(), "dead-nonce");
    lockTestHooks.beforeTakeoverRename = (path) => {
      lockTestHooks.beforeTakeoverRename = undefined;
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, startedAt: null, nonce: "new-live" }),
        "utf8",
      );
    };
    let tick = 0;
    try {
      await expect(
        withRepositoryLock(repositoryPath, () => undefined, {
          clock: () => (tick === 0 ? 0 : 10_001),
          wait: async () => {
            tick += 1;
          },
        }),
      ).rejects.toThrow(new RegExp(`pid ${process.pid}`));
    } finally {
      lockTestHooks.beforeTakeoverRename = undefined;
    }
    const record = JSON.parse(readFileSync(lock, "utf8")) as { nonce: string };
    expect(record.nonce).toBe("new-live");
    expect(staleFiles(repositoryPath)).toEqual([]);
  });

  test("an unparsable lock is live until its mtime is 30 seconds old", async () => {
    const { repositoryPath } = await setup();
    const lock = leaveLock(repositoryPath, 0);
    writeFileSync(lock, "not json", "utf8");
    const mtime = statSync(lock).mtimeMs;
    let tick = 0;
    const clock = (): number => mtime + (tick >= 2 ? 30_001 : 0);
    let ran = false;
    await withRepositoryLock(
      repositoryPath,
      () => {
        ran = true;
      },
      {
        clock,
        wait: async () => {
          expect(existsSync(lock)).toBe(true);
          tick += 1;
        },
      },
    );
    expect(ran).toBe(true);
    expect(tick).toBeGreaterThanOrEqual(2);
  });

  test("release never deletes another process's lock", async () => {
    const { repositoryPath } = await setup();
    const lock = lockPathOf(repositoryPath);
    await withRepositoryLock(repositoryPath, () => {
      writeFileSync(
        lock,
        JSON.stringify({ pid: process.pid, startedAt: null, nonce: "other" }),
        "utf8",
      );
    });
    const record = JSON.parse(readFileSync(lock, "utf8")) as { nonce: string };
    expect(record.nonce).toBe("other");
    expect(
      readdirSync(join(repositoryPath, ".operad")).filter((name) =>
        name.startsWith("work.lock.release."),
      ),
    ).toEqual([]);
  });

  test("a live holder blocks until the deadline and names its pid", async () => {
    const { repositoryPath } = await setup();
    const lock = leaveLock(repositoryPath, process.pid);
    let tick = 0;
    await expect(
      withRepositoryLock(repositoryPath, () => undefined, {
        clock: () => (tick === 0 ? 0 : 10_001),
        wait: async () => {
          tick += 1;
        },
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(existsSync(lock)).toBe(true);
  });

  test("a waiter given a longer timeout outlasts the default one (T-0440)", async () => {
    const { repositoryPath } = await setup();
    const lock = join(repositoryPath, ".operad", "long.lock");
    mkdirSync(join(repositoryPath, ".operad"), { recursive: true });
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: null, nonce: "holder" }),
      "utf8",
    );
    let now = 0;
    let waits = 0;
    await expect(
      withLockFile(lock, () => undefined, {
        timeoutMs: 60_000,
        clock: () => now,
        wait: async () => {
          waits += 1;
          now += waits === 1 ? 20_000 : 60_000;
        },
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    // Past the default 10 s it kept waiting; only the longer limit ended it.
    expect(waits).toBe(2);
  });

  test("a failed job releases the lock", async () => {
    const { repositoryPath } = await setup();
    await expect(
      withRepositoryLock(repositoryPath, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPathOf(repositoryPath))).toBe(false);
  });

  test("a real wait closes its watch and its timer", async () => {
    const { repositoryPath } = await setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      reportEntered = resolve;
    });

    const holder = withRepositoryLock(repositoryPath, async () => {
      reportEntered();
      await held;
    });
    await entered;
    // The default wait opens a directory watch and its fallback timer.
    const waiter = withRepositoryLock(repositoryPath, () => undefined);
    try {
      expect(openWaitHandleCount()).toBe(2);
    } finally {
      release();
      await Promise.all([holder, waiter]);
    }
    expect(openWaitHandleCount()).toBe(0);
  });

  test("two waiters on a dead holder never enter together", async () => {
    const { repositoryPath } = await setup();
    leaveLock(repositoryPath, await deadPid());

    let active = 0;
    let most = 0;
    let done = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportWaiting: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      reportWaiting = resolve;
    });
    let reportEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      reportEntered = resolve;
    });

    const first = withRepositoryLock(repositoryPath, async () => {
      active += 1;
      most = Math.max(most, active);
      reportEntered();
      await held;
      active -= 1;
      done += 1;
    });
    await entered;
    // The first call holds the lock; the second reports through `wait` that it
    // is waiting, and only that releases the first. No timer decides the order.
    const second = withRepositoryLock(
      repositoryPath,
      async () => {
        active += 1;
        most = Math.max(most, active);
        active -= 1;
        done += 1;
      },
      {
        wait: async () => {
          reportWaiting();
          await held;
        },
      },
    );
    await waiting;
    expect(active).toBe(1);
    expect(done).toBe(0);
    release();
    await Promise.all([first, second]);
    expect(done).toBe(2);
    expect(most).toBe(1);
  });
});
