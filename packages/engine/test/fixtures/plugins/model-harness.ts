import { definePlugin } from "../../../src/index.ts";

/** A harness whose model descriptions a test reads from the plugin list. */
export default definePlugin({
  name: "models",
  kind: "harness",
  version: "1.0.0",
  models: {
    list: [
      {
        id: "fake-large",
        name: "Fake Large",
        provider: "fake",
        window: 200_000,
        capabilities: ["vision", "reasoning", "tools"],
      },
      { id: "fake-small", provider: "fake" },
      "fake-plain",
    ],
    default: "fake-large",
    windows: { "fake-large": 200_000 },
  },
  steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
});
