import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FilePluginStore,
  PluginRegistry,
} from "../../src/index.ts";
import shell from "../../src/plugin/builtin/shell.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

async function registry(): Promise<{ registry: PluginRegistry; root: string }> {
  const root = await tempRoot();
  return {
    root,
    registry: new PluginRegistry([shell], {
      home: root,
      cwd: root,
      store: new FilePluginStore({ root: join(root, "plugins") }),
    }),
  };
}

describe("the base shell plugin", () => {
  test("runs a command and keeps its output in a file", async () => {
    const { registry: loaded } = await registry();
    const result = await loaded.runStep(
      "shell/command",
      { command: "echo hello" },
      { runId: "run_1" },
    );
    expect(result.result).toBe("ok");
    const log = (result.data as { log: string }).log;
    expect(readFileSync(log, "utf8")).toContain("hello");
  });

  test("a command that exits non-zero is a failed result", async () => {
    const { registry: loaded } = await registry();
    const result = await loaded.runStep(
      "shell/command",
      { command: "exit 3" },
      { runId: "run_1" },
    );
    expect(result.result).toBe("failed");
    expect(String((result.data as { reason: string }).reason)).toContain(
      "exited 3",
    );
  });

  test("checks ready", async () => {
    const { registry: loaded } = await registry();
    const checks = await loaded.checks();
    expect(checks).toEqual([
      { plugin: "shell", ok: true, message: "ready" },
    ]);
  });
});
