import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DevError } from "../../src/model.ts";
import { repositoryLockPath, withRepositoryLock } from "../../src/lock.ts";
import { updateMainClone } from "../../src/mainclone.ts";
import { gitOrThrow } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const HOLDER = fileURLToPath(
  new URL("../fixtures/repository-lock-holder.ts", import.meta.url),
);

function legacyLockPath(repositoryPath: string): string {
  return join(repositoryPath, ".operad", "dev.lock");
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", "0"],
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = child.pid;
  await child.exited;
  return pid;
}

function leaveLegacyLock(repositoryPath: string, pid: number): void {
  const path = legacyLockPath(repositoryPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ pid, startedAt: null, nonce: "old" }),
    "utf8",
  );
}

/** Reads the first line of a child's pipe as soon as it arrives. */
function firstLine(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            reject(new Error(`the child ended without a start line: ${text}`));
            return;
          }
          text += decoder.decode(value, { stream: true });
          const end = text.indexOf("\n");
          if (end >= 0) {
            await reader.cancel();
            resolve(text.slice(0, end));
            return;
          }
        }
      } catch (error) {
        reject(error);
      } finally {
        reader.releaseLock();
      }
    })();
  });
}

/** Puts a commit on a new branch ahead of the repository's current branch. */
function branchAhead(repositoryPath: string): {
  branch: string;
  target: string;
} {
  const branch = gitOrThrow(repositoryPath, ["branch", "--show-current"]);
  gitOrThrow(repositoryPath, ["checkout", "-q", "-b", "next"]);
  writeFileSync(join(repositoryPath, "README.md"), "# test\nnext\n");
  gitOrThrow(repositoryPath, ["commit", "-qam", "next"]);
  const target = gitOrThrow(repositoryPath, ["rev-parse", "HEAD"]);
  gitOrThrow(repositoryPath, ["checkout", "-q", branch]);
  return { branch, target };
}

describe("the repository lock", () => {
  test("a live holder past the deadline is a dev lock error naming its pid", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const repositoryPath = await makeGitRepository(root);
    const lock = repositoryLockPath(repositoryPath, home);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: null, nonce: "held" }),
      "utf8",
    );
    let tick = 0;
    const failure = await withRepositoryLock(repositoryPath, () => undefined, {
      home,
      clock: () => (tick === 0 ? 0 : 10_001),
      wait: async () => {
        tick += 1;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DevError);
    expect((failure as DevError).message).toContain(`pid ${process.pid}`);
    expect((failure as DevError).message).toContain("another dev command holds");
    expect((failure as DevError).message).toContain("gave up after 10s");
  });

  test("the lock lives in the operad home, not the working tree, and is gone afterwards", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const repositoryPath = await makeGitRepository(root);
    const lock = repositoryLockPath(repositoryPath, home);
    const legacy = legacyLockPath(repositoryPath);
    let existed = false;
    let legacyExisted = true;
    await withRepositoryLock(
      repositoryPath,
      () => {
        existed = existsSync(lock);
        legacyExisted = existsSync(legacy);
      },
      { home },
    );
    expect(existed).toBe(true);
    expect(legacyExisted).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  test("a linked worktree shares its repository's lock", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const repositoryPath = await makeGitRepository(root);
    const worktree = join(root, "linked");
    gitOrThrow(repositoryPath, ["worktree", "add", "-q", "-b", "linked", worktree]);
    expect(repositoryLockPath(worktree, home)).toBe(
      repositoryLockPath(repositoryPath, home),
    );
  });

  test("a main clone whose lock dev holds is clean and fast-forwards", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const repositoryPath = await makeGitRepository(root);
    const { branch, target } = branchAhead(repositoryPath);
    await withRepositoryLock(
      repositoryPath,
      async () => {
        const status = gitOrThrow(repositoryPath, [
          "status",
          "--porcelain",
          "--untracked-files=normal",
        ]);
        expect(status).toBe("");
        const outcome = await updateMainClone(
          repositoryPath,
          branch,
          target,
          [],
          async () => ({ ok: true, out: "" }),
        );
        expect(outcome).toEqual({ updated: true });
        expect(gitOrThrow(repositoryPath, ["rev-parse", "HEAD"])).toBe(target);
      },
      { home },
    );
  });

  test("two processes still exclude each other", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const repositoryPath = await makeGitRepository(root);
    const child = Bun.spawn({
      cmd: [process.execPath, HOLDER, repositoryPath, home],
      env: { ...process.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(await firstLine(child.stdout)).toBe(`start ${child.pid}`);
      let entered = false;
      let tick = 0;
      const failure = await withRepositoryLock(
        repositoryPath,
        () => {
          entered = true;
        },
        {
          home,
          clock: () => (tick === 0 ? 0 : 10_001),
          wait: async () => {
            tick += 1;
          },
        },
      ).catch((error: unknown) => error);
      expect(entered).toBe(false);
      expect(failure).toBeInstanceOf(DevError);
      expect((failure as DevError).message).toContain(`pid ${child.pid}`);
    } finally {
      try {
        child.stdin.write("go\n");
        await child.stdin.end();
      } catch {
        // The child may already have ended; the exit below still settles it.
      }
      await child.exited;
    }
  });

  test("a legacy in-tree lock is removed when nobody holds it", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const repositoryPath = await makeGitRepository(root);
    leaveLegacyLock(repositoryPath, await deadPid());
    await withRepositoryLock(repositoryPath, () => undefined, { home });
    expect(existsSync(legacyLockPath(repositoryPath))).toBe(false);
  });

  test("a held legacy in-tree lock is left alone", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const repositoryPath = await makeGitRepository(root);
    leaveLegacyLock(repositoryPath, process.pid);
    await withRepositoryLock(repositoryPath, () => undefined, { home });
    expect(existsSync(legacyLockPath(repositoryPath))).toBe(true);
  });
});
