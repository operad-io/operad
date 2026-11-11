import { definePlugin } from "@operad-io/engine";
import type { ObjectRow } from "@operad-io/engine";

/** Two object types with pure rows, for the channel's baseline and filter. */
export default definePlugin({
  name: "channel-demo",
  kind: "domain",
  version: "0.0.1",
  objects: [
    {
      name: "task",
      index: ["phase"],
      // A wait the plugin answers itself, for the channel's quiet waits.
      answeredAutomatically: (data) => data.auto === true,
    },
    { name: "note" },
  ],
  // Every proposed task is pending; only one the plugin opened itself is announced.
  async standing(ctx) {
    const page = await ctx.store.list("task", { limit: 100 });
    return page.objects
      .filter((object) => object.data.phase === "proposed")
      .map((object) => ({
        id: `task:${object.id}`,
        prompt: `${object.id} is proposed`,
        object: { type: "task", id: object.id },
        announce: object.data.by === "dev",
      }));
  },
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
          // A proposed task waits for a person without a run.
          ...(object.data.phase === "proposed" ? { waiting: true } : {}),
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
