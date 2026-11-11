import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  definePlugin,
  MemoryPluginStore,
  PluginRegistry,
  type StepEvent,
} from "../../src/index.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("a step's events", () => {
  test("a caller that observes a step sees its events besides the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "observe-"));
    roots.push(root);
    const plugin = definePlugin({
      name: "noisy",
      kind: "domain",
      version: "0.0.0",
      steps: [
        {
          name: "speak",
          results: ["done"],
          async run(ctx) {
            await ctx.emit({ type: "noisy.said", key: "k", summary: "said", data: {} });
            return { result: "done" };
          },
        },
      ],
    });
    const registry = new PluginRegistry([plugin], {
      home: join(root, "home"),
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      onLog: () => undefined,
    });
    const seen: string[] = [];
    const delivered: string[] = [];
    await registry.runStep("noisy/speak", {}, {
      runId: "run-1",
      observe: (_plugin: string, event: StepEvent) => {
        seen.push(event.type);
      },
      emit: (_plugin: string, event: StepEvent) => {
        delivered.push(event.type);
      },
    });
    expect(seen).toEqual(["noisy.said"]);
    expect(delivered).toEqual(["noisy.said"]);
  });
});
