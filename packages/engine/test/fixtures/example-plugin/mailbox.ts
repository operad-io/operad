// example-plugin/mailbox.ts
import { defineFlow, definePlugin } from "@operad-io/engine";

export default definePlugin({
  name: "mailbox",
  kind: "domain",
  version: "0.1.0",
  objects: [{ name: "mail" }],
  steps: [{ name: "file", results: ["ok"], run: () => ({ result: "ok" }) }],
  flows: [
    defineFlow({
      name: "incoming",
      entry: "file",
      steps: [
        {
          id: "file",
          kind: "plugin",
          params: { use: "mailbox/file", params: {} },
          replay: "safe",
          next: { ok: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    }),
  ],
  rules: [
    {
      source: "mail",
      type: "mail.received",
      start: { flow: "incoming" },
      object: "mail:1",
      mode: "auto",
    },
  ],
});
