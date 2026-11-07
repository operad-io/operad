import { defineFlow, definePlugin } from "@operad-io/engine";

/** Writes the note the flow was started with, then asks whether to publish it. */
const review = defineFlow({
  name: "review",
  entry: "draft",
  steps: [
    {
      id: "draft",
      kind: "plugin",
      params: { use: "notes/draft", params: {} },
      replay: "safe",
      next: { ok: "approve", failed: "rejected" },
    },
    {
      id: "approve",
      kind: "wait_person",
      params: { prompt: "Publish this note?", choices: ["publish", "discard"] },
      replay: "safe",
      next: { publish: "published", discard: "rejected", interrupted: "rejected" },
    },
    { id: "published", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "rejected", kind: "end", params: { status: "cancelled" }, replay: "safe" },
  ],
});

export default definePlugin({
  name: "notes",
  kind: "domain",
  version: "0.1.0",
  objects: [{ name: "note" }],
  steps: [
    {
      name: "draft",
      results: ["ok", "failed"],
      run: async (ctx) => {
        const object = ctx.object;
        if (object === undefined) throw new Error("the review flow needs a note to work on");
        const text =
          typeof ctx.params === "object" && ctx.params !== null && !Array.isArray(ctx.params)
            ? ctx.params.text
            : undefined;
        if (typeof text !== "string" || text.length === 0) {
          throw new Error("the review flow needs a text");
        }
        await ctx.store.put("note", object.id, { text, published: false }, "notes/draft");
        return { result: "ok" };
      },
    },
  ],
  flows: [review],
});
