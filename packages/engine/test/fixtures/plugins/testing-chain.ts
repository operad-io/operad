import { defineFlow, definePlugin } from "../../../src/index.ts";

export default definePlugin({
  name: "chain",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "job" }],
  steps: [{ name: "note", results: ["ok"], run: () => ({ result: "ok" }) }],
  flows: [
    defineFlow({
      name: "first",
      entry: "ask",
      steps: [
        {
          id: "ask",
          kind: "wait_person",
          params: { prompt: "Go?", choices: ["go", "stop"] },
          replay: "safe",
          next: { go: "done", stop: "done", interrupted: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    }),
    defineFlow({
      name: "third",
      entry: "work",
      steps: [
        {
          id: "work",
          kind: "plugin",
          params: { use: "chain/note", params: {} },
          replay: "safe",
          next: { ok: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    }),
    defineFlow({
      name: "second",
      entry: "work",
      steps: [
        {
          id: "work",
          kind: "plugin",
          params: { use: "chain/note", params: {} },
          replay: "safe",
          next: { ok: "done" },
        },
        // Ends cancelled so that its own end does not start the rule again.
        { id: "done", kind: "end", params: { status: "cancelled" }, replay: "safe" },
      ],
    }),
  ],
  rules: [
    {
      source: "operad",
      type: "run.done",
      start: { flow: "second" },
      object: "$event.object",
      mode: "auto",
    },
    {
      source: "mail",
      type: "mail.received",
      start: { flow: "first" },
      object: "job:1",
      mode: "auto",
    },
  ],
});
