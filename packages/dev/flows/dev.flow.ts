import { defineFlow } from "@operad-io/engine";

/**
 * The dev flow: give a task a worktree, let a worker change it, gate the
 * commit, and send a failed gate back for another pass. A person decides the
 * merge; the merge lands on main and cleanup removes the worktrees and branches.
 */
export default defineFlow({
  name: "dev",
  entry: "worktree",
  steps: [
    {
      id: "worktree",
      kind: "plugin",
      params: { use: "dev/worktree", params: {} },
      replay: "unsafe",
      next: {
        ready: "work",
        conflict: "work",
        blocked: "wait",
        failed: "end_failed",
        cancelled: "end_cancelled",
        interrupted: "wait",
      },
    },
    {
      id: "work",
      kind: "plugin",
      params: { use: "dev/work", params: {} },
      replay: "unsafe",
      next: {
        done: "verify",
        nothing: "wait",
        failed: "wait",
        cancelled: "end_cancelled",
        interrupted: "wait",
      },
    },
    {
      id: "verify",
      kind: "plugin",
      params: { use: "dev/verify", params: {} },
      replay: "safe",
      next: {
        pass: "review",
        fail: "rework",
        cancelled: "end_cancelled",
      },
    },
    {
      id: "review",
      kind: "plugin",
      params: { use: "dev/review", params: {} },
      replay: "safe",
      next: {
        pass: "wait",
        fail: "rework",
        failed: "wait",
        cancelled: "end_cancelled",
      },
    },
    {
      id: "rework",
      kind: "plugin",
      params: { use: "dev/rework", params: {} },
      replay: "safe",
      next: {
        again: "worktree",
        ask: "wait",
        cancelled: "end_cancelled",
      },
    },
    {
      id: "wait",
      kind: "wait_person",
      params: {
        prompt: "The task is waiting for you: merge it or reject it.",
        choices: ["merge", "reject"],
        note: "the run stopped during {step}; reject to run it again",
      },
      replay: "safe",
      next: {
        merge: "integrate",
        reject: "worktree",
        interrupted: "end_cancelled",
      },
    },
    {
      id: "integrate",
      kind: "plugin",
      params: { use: "dev/integrate", params: {} },
      replay: "safe",
      next: {
        merged: "cleanup",
        conflict: "worktree",
        fail: "worktree",
        failed: "wait",
        cancelled: "end_cancelled",
      },
    },
    {
      id: "cleanup",
      kind: "plugin",
      params: { use: "dev/cleanup", params: {} },
      replay: "safe",
      next: {
        done: "end_done",
        cancelled: "end_cancelled",
      },
    },
    {
      id: "end_done",
      kind: "end",
      params: { status: "done" },
      replay: "safe",
    },
    {
      id: "end_failed",
      kind: "end",
      params: { status: "failed" },
      replay: "safe",
    },
    {
      id: "end_cancelled",
      kind: "end",
      params: { status: "cancelled" },
      replay: "safe",
    },
  ],
});
