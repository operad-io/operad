import { definePlugin } from "../../../src/index.ts";

const views = {
  row: (object: { id: string; data: Record<string, unknown> }) => ({
    id: object.id,
    title: String(object.data.title ?? object.id),
    state: String(object.data.state ?? "open"),
    ...(typeof object.data.parent === "string" ? { parent: object.data.parent } : {}),
    ...(object.data.after === undefined ? {} : { after: object.data.after as readonly string[] }),
  }),
  sections: () => [],
  load: () => ({ markdown: "" }),
};

/** A parent type `group` and a child type `leaf` whose rows carry `parent`. */
export default definePlugin({
  name: "tree",
  kind: "domain",
  version: "0.0.1",
  objects: [
    { name: "group" },
    {
      name: "leaf",
      filters: [
        { name: "active", states: ["open"], default: true },
        { name: "done", states: ["merged"] },
      ],
    },
  ],
  views: { group: views, leaf: views },
});
