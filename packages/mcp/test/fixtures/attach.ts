import { definePlugin } from "@operad-io/engine";

/** An action with a file argument, for the test that the MCP tools cannot pass one. */
export default definePlugin({
  name: "filer",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "thing" }],
  actions: [
    {
      name: "attach",
      on: "thing",
      args: {
        type: "object",
        properties: {
          file: { type: "string", format: "file" },
          label: { type: "string" },
        },
        additionalProperties: false,
      },
      when: () => true,
      run: (_ctx, args) => `got ${JSON.stringify(args)}`,
    },
  ],
});
