import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_POLL_MS,
  resolveSubscriptionWatch,
  watchDirectory,
} from "../../src/platform/index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the injected watch, timer and period replace the defaults", () => {
  const stop = (): void => undefined;
  const watch = (): (() => void) => stop;
  const repeat = (): (() => void) => stop;
  const resolved = resolveSubscriptionWatch({ pollMs: 7, repeat, watch });
  expect(resolved.pollMs).toBe(7);
  expect(resolved.repeat).toBe(repeat);
  expect(resolved.watch).toBe(watch);
});

test("without options the real watch and the default period are used", () => {
  const resolved = resolveSubscriptionWatch({});
  expect(resolved.pollMs).toBe(DEFAULT_POLL_MS);
  expect(resolved.watch).toBe(watchDirectory);
});

test("a change in the directory is reported with its entry name", async () => {
  const directory = mkdtempSync(join(tmpdir(), "operad-watch-test-"));
  directories.push(directory);
  // The platform may start delivering events a moment after `watch` returns,
  // so the entry is rewritten until the first event arrives.
  const changed = new Promise<string | null>((resolve) => {
    let writes = 0;
    const writer = setInterval(() => {
      writeFileSync(join(directory, "entry.txt"), String((writes += 1)));
    }, 20);
    const stop = watchDirectory(directory, (name) => {
      clearInterval(writer);
      stop();
      resolve(name);
    });
  });
  expect(await changed).toBe("entry.txt");
});

test("watching a missing directory does nothing and can be stopped", () => {
  const stop = watchDirectory(join(tmpdir(), "operad-no-such-directory-xyz"), () => {
    throw new Error("unexpected change");
  });
  expect(() => stop()).not.toThrow();
});
