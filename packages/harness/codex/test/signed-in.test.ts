/**
 * The codex harness's `signedIn`: an answer from `codex login status`; absent
 * when codex is missing or cannot be asked. No account detail is read.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "../../process/test/support.ts";
import { SIGNED_IN_CACHE_MS, createCodexHarnessPlugin } from "../src/index.ts";

afterAll(cleanupTempRoots);

/** Writes an executable codex stand-in that runs `body` as a shell script. */
function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("codex's signedIn answer", () => {
  test("is true when codex login status exits 0", async () => {
    const root = await tempRoot();
    const codex = join(root, "codex");
    script(codex, `printf '%s\\n' 'Logged in using ChatGPT'\nexit 0`);
    const plugin = createCodexHarnessPlugin({ codex: [codex] });
    expect(await plugin.signedIn?.({})).toBe(true);
  });

  test("is false when codex login status exits non-zero", async () => {
    const root = await tempRoot();
    const codex = join(root, "codex");
    script(codex, `printf '%s\\n' 'Not logged in'\nexit 1`);
    const plugin = createCodexHarnessPlugin({ codex: [codex] });
    expect(await plugin.signedIn?.({})).toBe(false);
  });

  test("is absent when codex cannot be started", async () => {
    const root = await tempRoot();
    const plugin = createCodexHarnessPlugin({ codex: [join(root, "no-codex")] });
    expect(await plugin.signedIn?.({})).toBeUndefined();
  });

  test("two clients asking at once share one probe", async () => {
    const root = await tempRoot();
    const codex = join(root, "codex");
    const counter = join(root, "count");
    script(codex, `printf x >> ${JSON.stringify(counter)}\nexit 0`);
    const plugin = createCodexHarnessPlugin({ codex: [codex] });
    const answers = await Promise.all([
      plugin.signedIn?.({}),
      plugin.signedIn?.({}),
    ]);
    expect(answers).toEqual([true, true]);
    expect(readFileSync(counter, "utf8").length).toBe(1);
  });

  test("asks codex once per short cache period", async () => {
    const root = await tempRoot();
    const codex = join(root, "codex");
    const counter = join(root, "count");
    script(codex, `printf x >> ${JSON.stringify(counter)}\nexit 0`);
    let clock = 1_000;
    const plugin = createCodexHarnessPlugin({ codex: [codex], now: () => clock });
    expect(await plugin.signedIn?.({})).toBe(true);
    expect(await plugin.signedIn?.({})).toBe(true);
    expect(existsSync(counter)).toBe(true);
    expect(readFileSync(counter, "utf8").length).toBe(1);
    clock += SIGNED_IN_CACHE_MS + 1;
    expect(await plugin.signedIn?.({})).toBe(true);
    expect(readFileSync(counter, "utf8").length).toBe(2);
  });
});
