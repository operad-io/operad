import { definePlugin } from "../../../src/index.ts";

// A plugin with a flow of its own, listed beside the flows of the home.
export default definePlugin({
  name: "own-flow",
  kind: "domain",
  version: "0.0.1",
  steps: [{ name: "touch", results: ["ok"], run: () => ({ result: "ok" }) }],
  flows: [
    {
      name: "builtin-touch",
      entry: "one",
      steps: [
        { id: "one", kind: "plugin", params: { use: "own-flow/touch", params: {} }, replay: "safe", next: { ok: "end" } },
      ],
    },
  ],
});
