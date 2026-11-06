import { defineFlow } from "../../../src/index.ts";

export default defineFlow({
  name: "greet",
  entry: "ask",
  steps: [
    {
      id: "ask",
      kind: "wait_person",
      params: { prompt: "Continue?", choices: ["yes", "no"] },
      replay: "safe",
      next: { yes: "done", no: "stop", interrupted: "stop" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "stop", kind: "end", params: { status: "cancelled" }, replay: "safe" },
  ],
});
