import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { holdUntilReleased } from "../fixtures/hold.ts";
import { cleanupTempRoots, osTempRoot } from "../support.ts";

afterAll(cleanupTempRoots);

/** dash is what `/bin/sh` is on the check host; use it when this machine has it. */
const POSIX_SHELL = Bun.which("dash") ?? "sh";

function fifo(path: string): void {
  const made = Bun.spawnSync(["mkfifo", path]);
  if (made.exitCode !== 0) throw new Error(`mkfifo failed for ${path}`);
}

function start(line: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([POSIX_SHELL, "-c", line], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** The first line the hold writes before it waits; the test waits for this event. */
async function ready(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("\n")) {
    const read = await reader.read();
    if (read.done) throw new Error(`the hold ended before it was ready: ${seen}`);
    seen += decoder.decode(read.value, { stream: true });
  }
  reader.releaseLock();
  expect(seen).toContain("ready");
}

/** Writes a line to the fifo; opening it read-write never blocks. */
async function release(path: string): Promise<void> {
  await Bun.spawn(["sh", "-c", `exec 3<>'${path}'; echo go >&3`], { stdin: "ignore" }).exited;
}

describe("the hold fixture", () => {
  test("blocks under POSIX sh until the release line arrives", async () => {
    const dir = await osTempRoot();
    const path = join(dir, "release");
    const done = join(dir, "done");
    fifo(path);
    const child = start(`echo ready; ${holdUntilReleased(path)}; echo done > '${done}'`);
    try {
      await ready(child);
      // It is still holding: the release line has not been written.
      expect(existsSync(done)).toBe(false);
      await release(path);
      expect(await child.exited).toBe(0);
      expect(existsSync(done)).toBe(true);
    } finally {
      await release(path);
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 30_000);

  test("ends when its owner is gone, without a release line", async () => {
    const dir = await osTempRoot();
    const path = join(dir, "release");
    const done = join(dir, "done");
    fifo(path);
    const owner = Bun.spawn(["sleep", "300"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const child = start(
      `echo ready; ${holdUntilReleased(path, owner.pid, 3)}; echo done > '${done}'`,
    );
    try {
      await ready(child);
      owner.kill("SIGKILL");
      await owner.exited;
      expect(await child.exited).toBe(0);
      expect(existsSync(done)).toBe(true);
      // The owner check ended it, not the lifetime backstop.
      expect(await new Response(child.stderr).text()).toContain("owner gone");
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
      await release(path);
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 30_000);

  test("ends at its lifetime even when its owner lives", async () => {
    const dir = await osTempRoot();
    const path = join(dir, "release");
    const done = join(dir, "done");
    fifo(path);
    const child = start(
      `echo ready; ${holdUntilReleased(path, process.pid, 1)}; echo done > '${done}'`,
    );
    try {
      await ready(child);
      expect(await child.exited).toBe(0);
      expect(existsSync(done)).toBe(true);
      // The lifetime backstop ended it; no release was written.
      expect(await new Response(child.stderr).text()).toContain("lifetime");
    } finally {
      await release(path);
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 30_000);
});
