import { definePlugin } from "@operad-io/engine";
import type { ObjectRow } from "@operad-io/engine";

/** Two object types with pure rows, for the channel's baseline and filter. */
export default definePlugin({
  name: "channel-demo",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "task", index: ["phase"] }, { name: "note" }],
  views: {
    task: {
      row(object): ObjectRow {
        const note = object.data.note;
        return {
          id: object.id,
          title: String(object.data.title ?? ""),
          state: String(object.data.phase ?? "new"),
          ...(typeof note === "string" ? { note } : {}),
          final: object.data.phase === "merged",
        };
      },
      sections() {
        return [];
      },
      load(_ctx, object) {
        return { markdown: String(object.data.title ?? "") };
      },
    },
    note: {
      row(object): ObjectRow {
        return {
          id: object.id,
          title: String(object.data.title ?? ""),
          state: String(object.data.state ?? "new"),
          final: object.data.state === "finished",
        };
      },
      sections() {
        return [];
      },
      load(_ctx, object) {
        return { markdown: String(object.data.title ?? "") };
      },
    },
  },
});
