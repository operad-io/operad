import { definePlugin } from "@operad-io/engine";

/** A plugin whose objects belong under settings, such as a bot. */
export default definePlugin({
  name: "shelf",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "book" }],
  objectsUnderSettings: true,
  views: {
    book: {
      row: (object) => ({
        id: object.id,
        title: String(object.data.title ?? object.id),
        state: String(object.data.state ?? "open"),
      }),
      sections: () => [],
      load: () => ({ markdown: "" }),
    },
  },
});
