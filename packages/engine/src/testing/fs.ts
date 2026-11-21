/** Scratch directories, file and process waits, and a free port, for a test only. */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { waitForChange } from "../platform/index.ts";

const roots: string[] = [];

/** Whether a scratch directory is removed by `cleanupTempRoots`. */
export interface TempRootOptions {
  /** Register it for cleanup; true by default. A test that removes its own root sets false. */
  readonly track?: boolean | undefined;
}

/**
 * A scratch directory under the OS temporary directory, removed by
 * `cleanupTempRoots`. It is outside the repository, so a file a test leaves
 * behind is never in a tree that tools search.
 */
export async function tempRoot(
  prefix = "operad-test-",
  options: TempRootOptions = {},
): Promise<string> {
  const root = await mkdtemp(`${realpathSync(tmpdir())}/${prefix}`);
  if (options.track !== false) roots.push(root);
  return root;
}

/** A second name for a scratch directory under the OS temporary directory. */
export function osTempRoot(prefix = "operad-test-"): Promise<string> {
  return tempRoot(prefix);
}

/** Every scratch directory this test process made and has not cleaned. */
export function tempRoots(): readonly string[] {
  return [...roots];
}

async function unlock(path: string): Promise<void> {
  try {
    await chmod(path, 0o700);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await unlock(`${path}/${entry.name}`);
    }
  } catch {
    // The path may already be gone, or not be a directory.
  }
}

/** Removes every scratch directory made by `tempRoot`. */
export async function cleanupTempRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // A test that timed out can leave a directory it locked; unlock and retry.
      await unlock(root);
      await rm(root, { recursive: true, force: true });
    }
  }
}

/**
 * Resolves when the file exists. A directory watch is the fast path; a look
 * every 100 ms besides covers an event a watch missed while it was starting.
 * With a deadline, throws once the time is past instead of waiting forever.
 */
export async function waitForFile(
  path: string,
  deadline?: number,
): Promise<void> {
  while (!existsSync(path)) {
    if (deadline !== undefined && Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await waitForChange(dirname(path), basename(path), 100);
  }
}

/** True for a pid a test may signal: a finite integer above 1 (never 0, 1 or a group). */
export function signalable(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1;
}

/** The pid a file holds, when it holds one a test may signal. */
export function pidValue(text: string): number | undefined {
  const pid = Number(text.trim());
  return signalable(pid) ? pid : undefined;
}

/**
 * Resolves with the pid a process wrote to `path`, once the file holds one.
 * The file may exist empty before its write, so existence is not enough.
 */
export async function waitForPid(path: string): Promise<number> {
  for (;;) {
    try {
      const pid = pidValue(readFileSync(path, "utf8"));
      if (pid !== undefined) return pid;
    } catch {
      // Not there yet.
    }
    await waitForChange(dirname(path), basename(path), 100);
  }
}

/** True while `kill -0` finds the pid: a zombie its parent has not reaped still counts. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves when the pid is gone. There is no pid event to wait on, so this
 * looks on a short bound. On timeout it throws with `ps -o stat,ppid`, so a
 * zombie is told from a live process.
 */
export async function waitForGone(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) {
      const ps = Bun.spawnSync(["ps", "-o", "stat,ppid", "-p", String(pid)]);
      throw new Error(
        `pid ${pid} still present after ${timeoutMs} ms; ps -o stat,ppid: ${ps.stdout.toString().trim()}`,
      );
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
  }
}

/**
 * Resolves when `predicate` holds, without waiting out a fixed sleep. The
 * timer only bounds the wait; it never decides when to look again.
 */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for a condition");
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, stepMs));
  }
}

/** A port no listener held when the probe closed, for a server under test. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("the free-port probe bound no port");
  return port;
}

/** Makes a directory and every parent, for a test that writes a file next. */
export async function makeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
