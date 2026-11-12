import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DevError } from "../src/model.ts";
import { withRepositoryLock } from "../src/lock.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

describe("the repository lock", () => {
  test("a live holder past the deadline is a dev lock error naming its pid", async () => {
    const root = await tempRoot();
    const repositoryPath = await makeGitRepository(root);
    mkdirSync(join(repositoryPath, ".operad"), { recursive: true });
    writeFileSync(
      join(repositoryPath, ".operad", "dev.lock"),
      JSON.stringify({ pid: process.pid, startedAt: null, nonce: "held" }),
      "utf8",
    );
    let tick = 0;
    const failure = await withRepositoryLock(repositoryPath, () => undefined, {
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

  test("the lock lives at .operad/dev.lock and is gone afterwards", async () => {
    const root = await tempRoot();
    const repositoryPath = await makeGitRepository(root);
    const lock = join(repositoryPath, ".operad", "dev.lock");
    let existed = false;
    await withRepositoryLock(repositoryPath, () => {
      existed = existsSync(lock);
    });
    expect(existed).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});
