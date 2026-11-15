import { appendFileSync } from "node:fs";
import { definePlugin } from "../../../src/index.ts";

/**
 * A harness whose model list is read like the codex one: the read itself is
 * cheap, but a test records each call (and the settings it saw) to tell whether
 * loading the plugins already read the list.
 */
export default definePlugin({
  name: "lazy-models",
  kind: "harness",
  version: "0.0.1",
  settings: {
    type: "object",
    properties: { note: { type: "string", default: "unset" } },
  },
  models: (settings) => {
    const reads = process.env.OPERAD_TEST_MODELS_READS;
    const note = String(settings.note);
    if (reads !== undefined) appendFileSync(reads, `${note}\n`);
    return { list: [note], default: note };
  },
  steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
});
