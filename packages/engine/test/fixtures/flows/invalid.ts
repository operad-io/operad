import { defineFlow } from "../../../src/index.ts";

export default defineFlow({
  name: "broken",
  entry: "ask",
  steps: [
    {
      id: "ask",
      kind: "wait_person",
      params: { prompt: "Continue?", choices: ["yes"] },
      replay: "safe",
      next: { yes: "end" },
    },
  ],
});
