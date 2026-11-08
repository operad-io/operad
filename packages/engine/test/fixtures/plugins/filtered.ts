import { definePlugin } from "../../../src/index.ts";

const views = {
  row: (object: { id: string; data: Record<string, unknown> }) => ({
    id: object.id,
    title: String(object.data.title ?? object.id),
    state: String(object.data.state ?? "open"),
  }),
  sections: () => [],
  load: () => ({ markdown: "" }),
};

/** A plugin whose `job` type has filters and whose `note` type has none. */
export default definePlugin({
  name: "filtered",
  kind: "domain",
  version: "0.0.1",
  objects: [
    {
      name: "job",
      index: ["repository"],
      filters: [
        { name: "active", states: ["open"], default: true },
        { name: "done", states: ["merged"] },
      ],
    },
    { name: "note" },
  ],
  views: { job: views, note: views },
});
