import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, MemoryPluginStore, PluginRegistry } from "../../src/index.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("a step's line receiver", () => {
  test("the receiver a caller gives reaches the step, and a call without one has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "receiver-"));
    roots.push(root);
    const plugin = definePlugin({
      name: "talk",
      kind: "domain",
      version: "0.0.0",
      steps: [
        {
          name: "say",
          results: ["done"],
          async run(ctx) {
            ctx.receiver?.("a line");
            return { result: "done", data: { had: ctx.receiver !== undefined } };
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
    const got: string[] = [];
    const given = await registry.runStep("talk/say", {}, { runId: "run-1", receiver: (line) => got.push(line) });
    expect(got).toEqual(["a line"]);
    expect(given.data).toEqual({ had: true });
    const without = await registry.runStep("talk/say", {}, { runId: "run-2" });
    expect(without.data).toEqual({ had: false });
  });
});
