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
  // Ten visits per step for ordinary loops, plus one visit of `review` and
  // `review_retry` for each of the review waits a round may take; after those
  // the review waits for a person. See `DEV_MAX_VISITS` in src/timeouts.ts, which a test keeps equal to this number.
  maxVisits: 46,
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
        unavailable: "work_retry",
        cancelled: "end_cancelled",
        interrupted: "announce_work_stopped",
      },
    },
    {
      id: "work_retry",
      kind: "wait",
      params: { check: "dev/work_due" },
      replay: "safe",
      next: { ready: "work", interrupted: "end_cancelled" },
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
        unavailable: "review_retry",
        timed_out: "wait_review_timeout",
        exhausted: "wait_review_unavailable",
        out_of_time: "wait_review_out_of_time",
        cancelled: "end_cancelled",
      },
    },
    {
      id: "review_retry",
      kind: "wait",
      params: { check: "dev/review_due" },
      replay: "safe",
      next: { ready: "review", interrupted: "end_cancelled" },
    },
    {
      id: "wait_review_timeout",
      kind: "wait_person",
      params: {
        prompt:
          "The task is waiting for you: merge it or reject it.\n\nreview timed out twice",
        choices: ["merge", "reject"],
        note: "review timed out twice",
      },
      replay: "safe",
      next: {
        merge: "integrate",
        reject: "worktree",
        interrupted: "end_cancelled",
      },
    },
    {
      id: "wait_review_unavailable",
      kind: "wait_person",
      params: {
        prompt:
          "The task is waiting for you: merge it or reject it.\n\nreview did not finish (model unavailable)",
        choices: ["merge", "reject"],
        note: "review did not finish (model unavailable)",
      },
      replay: "safe",
      next: {
        merge: "integrate",
        reject: "worktree",
        interrupted: "end_cancelled",
      },
    },
    {
      id: "wait_review_out_of_time",
      kind: "wait_person",
      params: {
        prompt:
          "The task is waiting for you: merge it or reject it.\n\nreview did not finish (out of time)",
        choices: ["merge", "reject"],
        note: "review did not finish (out of time)",
      },
      replay: "safe",
      next: {
        merge: "integrate",
        reject: "worktree",
        interrupted: "end_cancelled",
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
