import { definePlugin } from "../../../src/index.ts";

// One step a flow file of the home calls.
export default definePlugin({
  name: "home-steps",
  kind: "domain",
  version: "0.0.1",
  steps: [{ name: "touch", results: ["ok"], run: () => ({ result: "ok" }) }],
});
