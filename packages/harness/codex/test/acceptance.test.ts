/**
 * A run against the real codex-acp and the user's own Codex login. It uses a
 * little of the plan's quota, so it runs only when `OPERAD_CODEX_ACCEPTANCE`
 * is set; every other test uses the fake in `fake-codex-acp.ts`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "@operad-io/harness-process/test-support";
import { createCodexHarnessPlugin } from "../src/index.ts";

afterAll(cleanupTempRoots);

describe("the real codex-acp", () => {
  test.skipIf(process.env.OPERAD_CODEX_ACCEPTANCE === undefined)(
    "a prompt runs to the end with the default command and an unknown cost",
    async () => {
      const root = await tempRoot();
      const registry = new PluginRegistry([createCodexHarnessPlugin()], {
        home: root,
        cwd: root,
        store: new MemoryPluginStore({ root: join(root, "store") }),
      });
      const check = (await registry.checks()).find((item) => item.plugin === "codex");
      expect(check?.ok).toBe(true);
      const result = await registry.runStep("codex/agent", { prompt: "Reply with the single word pong.", cwd: root }, { runId: "run-1" });
      expect(result.result).toBe("done");
      const data = (result.data ?? {}) as { usage: { costMicros: number | null; tokens: { output: number } }; finalMessage: string };
      expect(data.usage.costMicros).toBeNull();
      expect(data.usage.tokens.output).toBeGreaterThan(0);
      expect(data.finalMessage.toLowerCase()).toContain("pong");
    },
    300_000,
  );
});
