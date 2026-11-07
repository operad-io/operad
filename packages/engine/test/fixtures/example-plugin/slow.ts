// example-plugin/slow.ts
import { defineFlow, definePlugin } from "@operad-io/engine";

export default definePlugin({
  name: "slow",
  kind: "domain",
  version: "0.1.0",
  steps: [
    {
      name: "wait-forever",
      results: ["ok", "interrupted"],
      run: () => new Promise(() => undefined),
    },
  ],
  flows: [
    defineFlow({
      name: "stuck",
      entry: "work",
      steps: [
        {
          id: "work",
          kind: "plugin",
          params: { use: "slow/wait-forever", params: {} },
          replay: "safe",
          next: { ok: "done", interrupted: "gave-up" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
        { id: "gave-up", kind: "end", params: { status: "failed" }, replay: "safe" },
      ],
    }),
  ],
});
