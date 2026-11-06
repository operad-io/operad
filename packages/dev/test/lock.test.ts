import { afterAll, describe, expect, test } from "bun:test";
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
import { lockTestHooks, openLockHandleCount, withRepositoryLock } from "../src/lock.ts";
import { cleanupTempRoots, makeGitRepository, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const HOLDER = fileURLToPath(
  new URL("./fixtures/lock-holder.ts", import.meta.url),
);

async function setup(): Promise<{ readonly root: string; readonly repositoryPath: string }> {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
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
  return join(repositoryPath, ".operad", "dev.lock");
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
    name.startsWith("dev.lock.stale."),
  );
}

describe("the repository lock", () => {
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
        cmd: [process.execPath, HOLDER, repositoryPath, result],
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
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
  });

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
        name.startsWith("dev.lock.release."),
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
    ).rejects.toThrow(new RegExp(`pid ${process.pid}`));
    expect(existsSync(lock)).toBe(true);
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
      expect(openLockHandleCount()).toBe(2);
    } finally {
      release();
      await Promise.all([holder, waiter]);
    }
    expect(openLockHandleCount()).toBe(0);
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
