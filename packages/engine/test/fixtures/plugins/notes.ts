import { definePlugin } from "../../../src/index.ts";

function textOf(params: unknown): string {
  if (
    typeof params === "object" &&
    params !== null &&
    "text" in params &&
    typeof params.text === "string"
  ) {
    return params.text;
  }
  return "";
}

/**
 * The test plugin: one object (`note`), one action (`archive`), one step
 * (`write`) and one command (`add`). It uses the whole step context so the
 * registry tests can check run id, object, working directory, signal, facts
 * and the logger.
 */
export default definePlugin({
  name: "notes",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "note" }],
  actions: [
    {
      name: "archive",
      on: "note",
      when: (state) => state.archived !== true,
      async run(ctx, args) {
        const id = typeof args === "string" ? args : ctx.object.id;
        const note = await ctx.store.get("note", id);
        await ctx.store.put(
          "note",
          id,
          { ...(note?.data ?? {}), archived: true },
          `archive ${id}`,
        );
        await ctx.facts.append({
          type: "note.archived",
          object: { type: "note", id },
          data: { by: ctx.runId ?? "command" },
        });
      },
    },
  ],
  steps: [
    {
      name: "write",
      results: ["ok", "failed"],
      async run(ctx, params) {
        if (ctx.signal.aborted) {
          return { result: "failed", data: { reason: "aborted" } };
        }
        const text = textOf(params);
        const path = await ctx.logger.write(`${ctx.runId}: ${text}`);
        const object =
          ctx.object === undefined
            ? undefined
            : { type: ctx.object.type, id: ctx.object.id };
        await ctx.facts.append({
          type: "note.written",
          data: { path, cwd: ctx.cwd, plugin: ctx.plugin },
          ...(object === undefined ? {} : { object }),
        });
        const id = ctx.object?.id ?? "note";
        const existing = await ctx.store.get("note", id);
        await ctx.store.put(
          "note",
          id,
          { ...(existing?.data ?? {}), text, path },
          `step ${ctx.runId}`,
        );
        return { result: "ok", data: { path } };
      },
    },
  ],
  commands: [
    {
      name: "add",
      args: "<text>",
      async run(ctx, argv) {
        const text = argv.join(" ");
        await ctx.store.put("note", "n1", { text }, "command add");
        return ctx.store.get("note", "n1");
      },
    },
  ],
});
