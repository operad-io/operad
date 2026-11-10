import { definePlugin } from "../../../engine/src/index.ts";

/** A plugin that shows one object type, for tests that compare what views answer. */
export default definePlugin({
  name: "cards",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "card" }],
  views: {
    card: {
      row: (object) => ({
        id: object.id,
        title: String(object.data.title ?? ""),
        state: String(object.data.state ?? "new"),
      }),
      sections: () => [],
      load: (_ctx, object) => ({ markdown: `# ${String(object.data.title ?? "")}` }),
    },
  },
});
