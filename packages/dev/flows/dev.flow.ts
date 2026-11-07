import { defineFlow } from "@operad-io/engine";

/**
 * A step in front of the person wait: it tells the outside world once that the
 * task needs a person, then goes on to the wait.
 */
function announce(id: string, from: string, result: string) {
  return {
    id,
    kind: "plugin" as const,
    params: { use: "dev/announce", params: { from, result } },
    replay: "safe" as const,
    next: { done: "wait", interrupted: "wait", cancelled: "end_cancelled" },
  };
}

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
        blocked: "announce_blocked",
        failed: "end_failed",
        cancelled: "end_cancelled",
        interrupted: "announce_worktree_stopped",
      },
    },
    {
      id: "work",
      kind: "plugin",
      params: { use: "dev/work", params: {} },
      replay: "unsafe",
      next: {
        done: "verify",
        nothing: "announce_nothing",
        failed: "announce_work_failed",
        cancelled: "end_cancelled",
        interrupted: "announce_work_stopped",
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
        pass: "announce_ready",
        fail: "rework",
        failed: "announce_review_failed",
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
        ask: "announce_rework",
        cancelled: "end_cancelled",
      },
    },
    announce("announce_blocked", "worktree", "blocked"),
    announce("announce_worktree_stopped", "worktree", "interrupted"),
    announce("announce_nothing", "work", "nothing"),
    announce("announce_work_failed", "work", "failed"),
    announce("announce_work_stopped", "work", "interrupted"),
    announce("announce_ready", "review", "pass"),
    announce("announce_review_failed", "review", "failed"),
    announce("announce_rework", "rework", "ask"),
    announce("announce_integrate", "integrate", "failed"),
    {
      id: "wait",
      kind: "wait_person",
      params: {
        prompt:
          "The task is waiting for you: merge it, reject it, or verify and review it again.",
        choices: ["merge", "reject", "reverify"],
        note: "the run stopped during {step}; reject to run it again, or reverify to check the same commit again",
      },
      replay: "safe",
      next: {
        merge: "integrate",
        reject: "worktree",
        reverify: "verify",
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
        failed: "announce_integrate",
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
