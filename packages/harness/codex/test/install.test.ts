import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "../../process/test/support.ts";
import { CODEX_EFFORTS, CODEX_MODELS, createCodexHarnessPlugin } from "../src/index.ts";
import { codexCommand, commandOf, defaultCommand } from "../src/install.ts";

afterAll(cleanupTempRoots);

async function pathWith(...names: string[]): Promise<{ root: string; bin: string }> {
  const root = await tempRoot();
  for (const name of names) {
    writeFileSync(join(root, name), "#!/usr/bin/env node\n");
    chmodSync(join(root, name), 0o755);
  }
  return { root, bin: root };
}

describe("the command that starts codex-acp", () => {
  test("by default the bun of PATH runs the real path of the codex-acp of PATH", async () => {
    const { root } = await pathWith("bun", "real-acp.js");
    symlinkSync(join(root, "real-acp.js"), join(root, "codex-acp"));
    const command = defaultCommand(root);
    expect(command[0]).toBe(join(root, "bun"));
    // The symlink is resolved: the script's own shebang is never run.
    expect(command[1]).toBe(realpathSync(join(root, "real-acp.js")));
  });

  test("a missing bun or codex-acp is refused with what to do", async () => {
    const onlyBun = await pathWith("bun");
    expect(() => defaultCommand(onlyBun.root)).toThrow("no `codex-acp` was found on PATH");
    const empty = await pathWith();
    expect(() => defaultCommand(empty.root)).toThrow("no `bun` was found on PATH");
  });

  test("the command setting replaces the default and must be a list of strings", () => {
    expect(commandOf(["/opt/homebrew/bin/bun", "/Users/hai/.bun/bin/codex-acp"])).toEqual([
      "/opt/homebrew/bin/bun",
      "/Users/hai/.bun/bin/codex-acp",
    ]);
    expect(() => commandOf("codex-acp")).toThrow("settings.command");
    expect(() => commandOf([])).toThrow("settings.command");
    expect(() => commandOf(["bun", 3])).toThrow("settings.command");
  });

  test("a codex script with a node shebang is run by bun; none on PATH is unknown", async () => {
    const { root } = await pathWith("codex");
    expect(codexCommand("/bun", root)).toEqual(["/bun", realpathSync(join(root, "codex"))]);
    const empty = await pathWith();
    expect(codexCommand("/bun", empty.root)).toBeUndefined();
  });
});

describe("what a chat may pick", () => {
  test("none: codex is a worker; it declares no models and no efforts", () => {
    const { models, efforts } = createCodexHarnessPlugin();
    expect(models).toEqual(CODEX_MODELS);
    expect(efforts.list).toEqual([]);
    expect(efforts.flag).toBe(CODEX_EFFORTS.flag);
  });
});
