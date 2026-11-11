import { defineFlow, definePlugin } from "../../../engine/src/index.ts";

/**
 * A plugin shaped like dev's cancel: a job keeps the id of the run that waits
 * on it, and its `stop` action asks the kernel to cancel that run.
 */
const hold = defineFlow({
  name: "hold",
  entry: "hold",
  steps: [
    {
      id: "hold",
      kind: "wait_person",
      params: { prompt: "Approve this job?", choices: ["finish"] },
      replay: "safe",
      next: { finish: "done", interrupted: "stopped" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "stopped", kind: "end", params: { status: "cancelled" }, replay: "safe" },
  ],
});

export default definePlugin({
  name: "canceltest",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "job" }],
  flows: [hold],
  actions: [
    {
      name: "stop",
      on: "job",
      when: () => true,
      async run(ctx) {
        const run = ctx.object.data.run;
        if (typeof run === "string") await ctx.runs?.cancel(run);
      },
    },
  ],
});
