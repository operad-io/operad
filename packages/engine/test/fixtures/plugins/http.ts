import { definePlugin } from "../../../src/index.ts";

/** A plugin for the HTTP tests: views, a note action, a confirm action and failures. */
export default definePlugin({
  name: "webtest",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "item", index: ["state"] }],
  views: {
    item: {
      row(object) {
        const note = object.data.note;
        return {
          id: object.id,
          title: String(object.data.title ?? ""),
          state: String(object.data.state ?? "new"),
          ...(typeof note === "string" ? { note } : {}),
        };
      },
      sections() {
        return [
          { id: "info", title: "Info" },
          { id: "pages", title: "Pages", live: true },
          { id: "hang", title: "Hang" },
        ];
      },
      async load(_ctx, object, sectionId, { cursor }) {
        if (sectionId === "info") {
          return { markdown: "# Item\n\nSome **text**." };
        }
        if (sectionId === "pages") {
          return cursor === undefined
            ? { markdown: "page one", next: "two" }
            : { markdown: `page ${cursor}` };
        }
        if (sectionId === "hang") {
          await new Promise<never>(() => undefined);
          return { markdown: "never" };
        }
        return { markdown: String(object.data.title ?? "") };
      },
    },
  },
  actions: [
    {
      name: "approve",
      on: "item",
      args: {
        type: "object",
        properties: {
          note: {
            type: "string",
            role: "note",
            description: "Why this is approved",
          },
        },
        required: ["note"],
        additionalProperties: false,
      },
      when: (state) => state.approved !== true,
      async run(ctx, args) {
        const note =
          typeof args === "object" && args !== null && "note" in args
            ? String((args as { note?: unknown }).note ?? "")
            : "";
        const current = await ctx.store.get("item", ctx.object.id);
        await ctx.store.put(
          "item",
          ctx.object.id,
          {
            ...(current?.data ?? {}),
            approved: true,
            state: "approved",
            approvedNote: note,
            approvedBy: ctx.actor.id,
          },
          "approve",
        );
      },
    },
    {
      name: "drop",
      on: "item",
      confirm: true,
      when: (state) => state.dropped !== true,
      async run(ctx) {
        const current = await ctx.store.get("item", ctx.object.id);
        await ctx.store.put(
          "item",
          ctx.object.id,
          { ...(current?.data ?? {}), dropped: true, state: "dropped" },
          "drop",
        );
      },
    },
    {
      name: "hidden",
      on: "item",
      when: () => false,
      run() {
        // Never available.
      },
    },
    {
      name: "fail",
      on: "item",
      when: () => true,
      run() {
        throw new Error("the plugin refused");
      },
    },
  ],
  keys: { m: "webtest:approve" },
});
