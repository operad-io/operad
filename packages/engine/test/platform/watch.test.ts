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
  const changed = new Promise<string | null>((resolve) => {
    const stop = watchDirectory(directory, (name) => {
      stop();
      resolve(name);
    });
    writeFileSync(join(directory, "entry.txt"), "x");
  });
  expect(await changed).toBe("entry.txt");
});

test("watching a missing directory does nothing and can be stopped", () => {
  const stop = watchDirectory(join(tmpdir(), "operad-no-such-directory-xyz"), () => {
    throw new Error("unexpected change");
  });
  expect(() => stop()).not.toThrow();
});
