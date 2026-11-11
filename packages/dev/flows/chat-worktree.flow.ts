import { defineFlow } from "@operad-io/engine";

/** Opens the worktree a chat asked for; one step, then the run ends. */
export default defineFlow({
  name: "dev:chat-worktree",
  entry: "open",
  steps: [
    {
      id: "open",
      kind: "plugin",
      params: { use: "dev/chat_worktree", params: {} },
      replay: "safe",
      next: { done: "done", failed: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});
