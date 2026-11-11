import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin } from "../../src/index.ts";
import type { PluginDefinition, PluginShape } from "../../src/index.ts";

const roots: string[] = [];

/** A scratch directory under `.radian/`, removed by `cleanupTempRoots`. */
export async function tempRoot(): Promise<string> {
  const base = join(process.cwd(), ".radian", "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "plugin-test-"));
  roots.push(root);
  return root;
}

export async function cleanupTempRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}

/** A plugin definition with the boring fields filled in. */
export function def(
  overrides: Partial<PluginShape> & { readonly name: string },
): PluginDefinition {
  return definePlugin({
    kind: "domain",
    version: "0.0.1",
    ...overrides,
  });
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
 * Resolves when the pid is gone. The stop path signals the group and returns;
 * the kernel takes the processes down, and a parent reaps them, a moment later.
 * There is no pid event to wait on (macOS has none in Bun), so this looks on a
 * short bound. On timeout it throws with `ps -o stat,ppid`, so a zombie (stat
 * Z, not yet reaped) is told from a live process (a product race).
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
