import { definePlugin } from "@operad-io/engine";

/** An action that emits an event, and one that asks whether a run is active. */
export default definePlugin({
  name: "talk",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "thing" }],
  actions: [
    {
      name: "say",
      on: "thing",
      when: () => true,
      async run(ctx) {
        if (ctx.emit === undefined) return "no emit";
        await ctx.emit({
          source: "mcp",
          type: "said",
          key: "k1",
          object: `thing:${ctx.object.id}`,
        });
        return "sent";
      },
    },
    {
      name: "active",
      on: "thing",
      args: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
        additionalProperties: false,
      },
      when: () => true,
      async run(ctx, args) {
        const runId = String((args as { runId: string }).runId);
        return (await ctx.runs?.active?.(runId)) === true ? "active" : "idle";
      },
    },
  ],
});
