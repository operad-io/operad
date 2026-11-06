import { defineFlow } from "../../../src/index.ts";

export default defineFlow({
  name: "ghost-note",
  entry: "write",
  steps: [
    {
      id: "write",
      kind: "plugin",
      params: { use: "ghost/write", params: {} },
      replay: "safe",
      next: {},
    },
  ],
});
