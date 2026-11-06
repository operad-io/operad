import { defineFlow } from "../../../src/index.ts";

export default defineFlow({
  name: "write-note",
  entry: "write",
  steps: [
    {
      id: "write",
      kind: "plugin",
      params: { use: "notes/write", params: { text: "hello" } },
      replay: "safe",
      next: { ok: "done", failed: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});
