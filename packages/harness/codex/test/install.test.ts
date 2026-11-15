import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots, tempRoot, waitForFile } from "../../process/test/support.ts";
import { CODEX_EFFORTS, createCodexHarnessPlugin } from "../src/index.ts";
import {
  MODELS_EMPTY_RETRY_MS,
  codexCommand,
  codexModels,
  commandOf,
  defaultCommand,
  refreshCodexModels,
  versionAtLeast,
} from "../src/install.ts";

afterAll(cleanupTempRoots);

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  restores.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const FAKE = fileURLToPath(new URL("./fake-codex-app-server.ts", import.meta.url));

async function pathWith(...names: string[]): Promise<{ root: string; bin: string }> {
  const root = await tempRoot();
  for (const name of names) {
    writeFileSync(join(root, name), "#!/usr/bin/env node\n");
    chmodSync(join(root, name), 0o755);
  }
  return { root, bin: root };
}

describe("the command that starts codex app-server", () => {
  test("by default the bun of PATH runs the real path of the codex of PATH with app-server", async () => {
    const { root } = await pathWith("bun", "codex");
    const command = defaultCommand(root);
    expect(command).toEqual([join(root, "bun"), realpathSync(join(root, "codex")), "app-server"]);
  });

  test("without a bun on PATH this bun runs the codex script", async () => {
    const { root } = await pathWith("codex");
    const command = defaultCommand(root);
    expect(command).toEqual([process.execPath, realpathSync(join(root, "codex")), "app-server"]);
  });

  test("a missing codex is refused with what to do", async () => {
    const empty = await pathWith();
    expect(() => defaultCommand(empty.root)).toThrow("no `codex` was found on PATH");
  });

  test("the command setting replaces the default and must be a list of strings", () => {
    expect(commandOf(["/opt/homebrew/bin/codex", "app-server"])).toEqual([
      "/opt/homebrew/bin/codex",
      "app-server",
    ]);
    expect(() => commandOf("codex")).toThrow("settings.command");
    expect(() => commandOf([])).toThrow("settings.command");
    expect(() => commandOf(["codex", 3])).toThrow("settings.command");
  });

  test("a codex script with a node shebang is run by bun; none on PATH is unknown", async () => {
    const { root } = await pathWith("codex");
    expect(codexCommand("/bun", root)).toEqual(["/bun", realpathSync(join(root, "codex"))]);
    const empty = await pathWith();
    expect(codexCommand("/bun", empty.root)).toBeUndefined();
  });

  test("a version is compared against the floor it was built against", () => {
    expect(versionAtLeast("0.166.0", "0.166.0")).toBe(true);
    expect(versionAtLeast("0.167.1", "0.166.0")).toBe(true);
    expect(versionAtLeast("0.165.9", "0.166.0")).toBe(false);
    expect(versionAtLeast("9.9.9", "0.166.0")).toBe(true);
  });
});

describe("what a chat may pick", () => {
  test("the model list comes from the app-server without blocking the listing read", async () => {
    const root = await tempRoot();
    const release = join(root, "models-release");
    const marker = join(root, "models-marker");
    const command = [process.execPath, FAKE, "models-nonblocking"];
    setEnv("FAKE_CODEX_MODELS_RELEASE", release);
    setEnv("FAKE_CODEX_MODELS_MARKER", marker);
    // The first read answers at once, before the app-server can: the refresh
    // is a background child, not a blocking probe.
    expect(codexModels(command, 1_000)).toEqual({ list: [], default: null });
    await waitForFile(marker);
    writeFileSync(release, "go");
    expect(await refreshCodexModels(command, 1_000)).toEqual({
      list: ["gpt-fake", "gpt-other"],
      default: "gpt-fake",
    });
    expect(codexModels(command, 1_001)).toEqual({ list: ["gpt-fake", "gpt-other"], default: "gpt-fake" });
  });

  test("an empty answer is tried again after the short retry, not kept for 30s", async () => {
    const root = await tempRoot();
    const marker = join(root, "models-empty-marker");
    const command = [process.execPath, FAKE, "models-empty-retry"];
    setEnv("FAKE_CODEX_MODELS", "empty");
    expect(await refreshCodexModels(command, 5_000)).toEqual({ list: [], default: null });
    setEnv("FAKE_CODEX_MODELS", "full");
    setEnv("FAKE_CODEX_MODELS_MARKER", marker);
    expect(codexModels(command, 5_000 + MODELS_EMPTY_RETRY_MS + 1)).toEqual({ list: [], default: null });
    await waitForFile(marker);
    expect(await refreshCodexModels(command, 5_000 + MODELS_EMPTY_RETRY_MS + 1)).toEqual({
      list: ["gpt-fake", "gpt-other"],
      default: "gpt-fake",
    });
  });

  test("efforts are codex's own; a step still names one with --effort", () => {
    const { efforts } = createCodexHarnessPlugin();
    expect(efforts.list).toEqual([]);
    expect(efforts.flag).toBe(CODEX_EFFORTS.flag);
  });
});
