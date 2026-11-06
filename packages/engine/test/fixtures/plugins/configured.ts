import { definePlugin } from "../../../src/index.ts";

/** A plugin with a settings schema, used to prove a null section is refused. */
export default definePlugin({
  name: "configured",
  kind: "domain",
  version: "0.0.1",
  settings: {
    type: "object",
    properties: {
      token: { type: "string", default: "fallback" },
    },
    additionalProperties: false,
  },
  steps: [
    {
      name: "read",
      results: ["ok"],
      run() {
        return { result: "ok" };
      },
    },
  ],
});
