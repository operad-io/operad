import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "../../../engine/src/index.ts";

// A step that asks one secret question and keeps what it received in a file of
// the home, which stands for the credential store a login writes.
export default definePlugin({
  name: "secret-steps",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "key",
      results: ["done", "failed"],
      async run(ctx) {
        const answer = await ctx.ask({
          prompt: "Enter the key",
          questions: [{ id: "value", text: "Enter the key", freeText: true, secret: true }],
          onTimeout: "reject_once",
        });
        const text = answer.answers?.[0]?.text;
        if (text === undefined) return { result: "failed" };
        writeFileSync(join(ctx.home, "received.json"), JSON.stringify({ text }));
        return { result: "done" };
      },
    },
  ],
});
