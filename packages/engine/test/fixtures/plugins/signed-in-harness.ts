import { definePlugin } from "../../../src/index.ts";

/**
 * A harness whose login answer a test sets through its settings, so the plugin
 * list's `signedIn` field can be checked without a real agent.
 */
export default definePlugin({
  name: "signed",
  kind: "harness",
  version: "1.0.0",
  settings: {
    type: "object",
    properties: { answer: { type: "boolean", default: false } },
  },
  signedIn: (settings) => settings.answer === true,
  steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
});
