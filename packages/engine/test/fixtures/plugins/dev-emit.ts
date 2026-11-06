import { defineFlow, definePlugin } from "../../../src/index.ts";

const good = defineFlow({
  name: "dev-good",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "dev/emit-good", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const bad = defineFlow({
  name: "dev-bad",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "dev/emit-bad", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

/** A fixture whose steps emit their own plugin's event and another's. */
export default definePlugin({
  name: "dev",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "emit-good",
      results: ["ok"],
      async run(ctx) {
        await ctx.emit({ type: "dev.ready", key: "ready" });
        return { result: "ok" };
      },
    },
    {
      name: "emit-bad",
      results: ["ok"],
      async run(ctx) {
        try {
          await ctx.emit({ type: "other.ready", key: "ready" });
          return { result: "ok", data: { error: "none" } };
        } catch (error) {
          return {
            result: "ok",
            data: {
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },
    },
  ],
  flows: [good, bad],
});
