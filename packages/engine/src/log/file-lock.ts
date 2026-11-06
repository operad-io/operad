import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const LOCK_EX = 2;

type Flock = (fd: number, operation: number) => number;

let flockFunction: Flock | undefined;

function loadFlock(): Flock {
  if (flockFunction) return flockFunction;

  const candidates =
    process.platform === "darwin"
      ? ["libc.dylib"]
      : process.platform === "linux"
        ? ["libc.so.6", "libc.so", `libc.musl-${process.arch}.so.1`]
        : [];

  for (const library of candidates) {
    try {
      const { symbols } = dlopen(library, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      const symbol = symbols.flock;
      if (symbol) {
        flockFunction = (fd, operation) => symbol(fd, operation);
        return flockFunction;
      }
    } catch {
      // Try the next library name.
    }
  }

  throw new Error(
    `the jsonl log backend needs flock(2), which is not available on ${process.platform}`,
  );
}

/**
 * Run `fn` while holding an exclusive advisory lock on `path`.
 *
 * The lock lives on the open file, so the kernel releases it when the process
 * dies, even with SIGKILL. The lock file itself may stay behind; that is fine.
 */
export function withFileLock<T>(path: string, fn: () => T): T {
  const fd = openSync(path, "a+");
  try {
    if (loadFlock()(fd, LOCK_EX) !== 0) {
      throw new Error(`could not lock ${path}`);
    }
    return fn();
  } finally {
    // Closing the descriptor releases the flock.
    closeSync(fd);
  }
}
