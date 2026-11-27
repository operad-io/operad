import { definePlugin } from "../../../src/index.ts";

// Steps a flow file of the home calls.
export default definePlugin({
  name: "home-steps",
  kind: "domain",
  version: "0.0.1",
  steps: [
    { name: "touch", results: ["ok"], run: () => ({ result: "ok" }) },
    // Gives back the params the run started with.
    { name: "echo", results: ["ok"], run: (ctx) => ({ result: "ok", data: { given: ctx.params ?? null } }) },
    // Calls a step no plugin of the test declares, so its flows cannot start.
    { name: "needs", results: ["ok"], calls: ["absent/step"], run: () => ({ result: "ok" }) },
  ],
});
