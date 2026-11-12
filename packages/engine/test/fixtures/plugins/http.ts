import { definePlugin } from "../../../src/index.ts";

/** A plugin for the HTTP tests: views, a note action, a confirm action and failures. */
export default definePlugin({
  name: "webtest",
  kind: "domain",
  version: "0.0.1",
  settings: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, default: 2, description: "Items at once.", editable: true },
      mode: { type: "string", default: "a", editable: true, confirm: true },
      fixed: { type: "string", default: "x" },
    },
  },
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
          { id: "live", title: "Live", live: true },
          { id: "pages", title: "Pages", live: true },
          { id: "hang", title: "Hang" },
        ];
      },
      async load(_ctx, object, sectionId, { cursor, after }) {
        if (sectionId === "info") {
          return { markdown: "# Item\n\nSome **text**." };
        }
        if (sectionId === "live") {
          if (after === undefined) {
            return { markdown: "line 1", mark: "1", tail: "tail 1" };
          }
          const next = Number(after) + 1;
          return {
            markdown: `line ${next}`,
            mark: String(next),
            tail: `tail ${next}`,
            delta: true,
          };
        }
        if (sectionId === "pages") {
          return cursor === undefined
            ? { markdown: "page one", next: "two", pages: [{ label: "one" }, { label: "two", cursor: "two" }] }
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
      name: "limit",
      on: "item",
      when: () => true,
      run: (ctx) => ctx.settings.limit,
    },
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
      name: "make",
      on: "item",
      creates: "item",
      args: {
        type: "object",
        properties: { opens: { type: "string" } },
        additionalProperties: false,
      },
      when: () => true,
      run(_ctx, args) {
        const opens = (args as { readonly opens?: string }).opens;
        return opens === undefined ? "made nothing" : { text: "made it", opens };
      },
    },
    {
      name: "attach",
      on: "item",
      args: {
        type: "object",
        properties: {
          file: { type: "string", format: "file", description: "The file." },
          more: { type: "array", items: { type: "string", format: "file" } },
        },
        required: ["file"],
        additionalProperties: false,
      },
      when: () => true,
      run(_ctx, args) {
        const { file, more } = args as { readonly file: string; readonly more?: readonly string[] };
        return { text: "attached", file, more: more ?? [] };
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
