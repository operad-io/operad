import { describe, expect, test } from "bun:test";
import { MemoryPluginStore, PluginRegistry, definePlugin } from "@operad-io/engine";

function plugin() {
  return definePlugin({
    name: "edit",
    kind: "domain",
    version: "0.0.0",
    objects: [{ name: "note" }],
    steps: [
      {
        name: "prepare",
        results: ["done", "failed"],
        run(ctx, params) {
          return {
            result: "done",
            data: {
              object: ctx.object === undefined ? null : `${ctx.object.type}:${ctx.object.id}`,
              params: params as Record<string, unknown>,
            },
          };
        },
      },
    ],
    actions: [
      {
        name: "change",
        on: "note",
        when: () => true,
        async run(ctx) {
          if (ctx.runStep === undefined) return "no step";
          const outcome = await ctx.runStep(
            "edit/prepare",
            { level: "edits" },
            { runId: "action-run", object: ctx.object },
          );
          return outcome;
        },
      },
    ],
  });
}

const options = {
  object: { type: "note", id: "n1", data: {} },
  actor: { via: "cli", id: "me" },
} as const;

describe("ctx.runStep in an action", () => {
  test("runs a loaded step for the action's object, with the params and run id it gives", async () => {
    const registry = new PluginRegistry([plugin()], {
      home: "/tmp/operad-test-home",
      store: new MemoryPluginStore({ root: "/tmp/operad-test-store" }),
      onLog: () => undefined,
    });
    expect((await registry.runAction("edit/change", {}, options)).value).toEqual({
      result: "done",
      data: { object: "note:n1", params: { level: "edits" } },
    });
  });
});
