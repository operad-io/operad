/**
 * The harness plugin's `signedIn`: it answers from `claude auth status`, keeps
 * the answer for a short time, and is absent when claude cannot be asked.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "../../process/test/support.ts";
import { SIGNED_IN_CACHE_MS, createClaudeHarnessPlugin } from "../src/index.ts";

afterAll(cleanupTempRoots);

/** Writes an executable claude stand-in that runs `body` as a shell script. */
function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("claude's signedIn answer", () => {
  test("is true when claude auth status says loggedIn true", async () => {
    const root = await tempRoot();
    const command = join(root, "claude");
    script(command, `printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai"}'`);
    const plugin = createClaudeHarnessPlugin();
    expect(await plugin.signedIn?.({ command })).toBe(true);
  });

  test("is false when claude auth status says loggedIn false", async () => {
    const root = await tempRoot();
    const command = join(root, "claude");
    script(command, `printf '%s\\n' '{"loggedIn":false}'\nexit 1`);
    const plugin = createClaudeHarnessPlugin();
    expect(await plugin.signedIn?.({ command })).toBe(false);
  });

  test("is absent when claude is missing or the answer cannot be read", async () => {
    const root = await tempRoot();
    const missing = join(root, "no-claude");
    const malformed = join(root, "claude");
    script(malformed, `printf '%s\\n' 'not json'`);
    const plugin = createClaudeHarnessPlugin();
    expect(await plugin.signedIn?.({ command: missing })).toBeUndefined();
    expect(await plugin.signedIn?.({ command: malformed })).toBeUndefined();
  });

  test("asks claude once per short cache period", async () => {
    const root = await tempRoot();
    const command = join(root, "claude");
    const counter = join(root, "count");
    script(command, `printf '%s\\n' '{"loggedIn":true}'\nprintf x >> ${JSON.stringify(counter)}`);
    let clock = 1_000;
    const plugin = createClaudeHarnessPlugin({ now: () => clock });
    expect(await plugin.signedIn?.({ command })).toBe(true);
    expect(await plugin.signedIn?.({ command })).toBe(true);
    expect(existsSync(counter)).toBe(true);
    expect(readFileSync(counter, "utf8").length).toBe(1);
    clock += SIGNED_IN_CACHE_MS + 1;
    expect(await plugin.signedIn?.({ command })).toBe(true);
    expect(readFileSync(counter, "utf8").length).toBe(2);
  });
});
