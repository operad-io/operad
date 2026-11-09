import { definePlugin } from "@operad-io/engine";

/** The repositories a test registers, as JSON in the environment: [{ name, path }]. */
export default definePlugin({
  name: "demo",
  kind: "domain",
  version: "0.0.1",
  settings: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, default: 2, description: "Items at once.", editable: true },
      mode: { type: "string", default: "a", editable: true, confirm: true },
      label: { type: "string", editable: true },
      fixed: { type: "string", default: "x" },
    },
  },
  projectSettings: {
    repositories: () => JSON.parse(process.env.OPERAD_TEST_REPOS ?? "[]"),
    files: [
      {
        name: "review",
        path: "review.json",
        schema: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["low", "high"], default: "low", editable: true },
          },
        },
      },
    ],
  },
});
