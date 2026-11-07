# T-0024-ctx-ask (Sonnet)

Problem

docs/backlog/operad-contract.md point 6, the kernel part. A step cannot ask a person and go on: today a flow needs a separate wait_person step, and the harness's process is gone by then. ctx.ask is the one new kernel primitive.

Protocol

• ctx.ask({ prompt, choices?, graceSecs?, onTimeout? }) returns the answer { choice?, note?, actor }. The grace is the narrowest of: the ctx.ask argument, the step param askGraceSecs, the global ask.graceSecs in config.json (default 600). 0 means do not wait; there is no unlimited value.
• Data model. One ask is one wait with a unique id <runId>:<effectId>:<n> (n counts asks within the step). The kernel writes askopened (wait id, prompt, choices) before the ask is visible; pending and GET /v1/pending show it as one item with the run's object; an answer is recorded once as askanswered with the wait id and the actor (claim-then-act: the first answer for a wait id wins; a second is refused with "already answered").
• Grace. While the step's process lives and the grace has not passed, the answer is delivered to the waiting ctx.ask call and the step goes on.
• Timeout. When the grace passes: with onTimeout: "waiting" the step ends with result waiting and data { waitId, prompt, choices, resume } (resume is whatever the step put there, for example a harness session reference); the flow must have an edge waiting → <a waitperson step>, and that step reuses the same wait id, so pending still shows one item. With onTimeout: "rejectonce" the call returns { choice: undefined, rejected: true } and the step goes on.
• Late answer. An answer to a wait whose step already ended and whose flow wait was not reached is refused and recorded (ask_refused).
• A flow author cannot call ctx.ask from a flow; only steps can. A flow that has a step able to return waiting without a waiting edge is refused at validation.
• Crash table, each row a test that kills a real process: after askopened, before the answer (on restart the step's replay decides; a safe step asks again with the same wait id, so pending shows one item); after askanswered, before the step reads it (the answer is delivered from the fact on replay); after the step ended waiting, before the flow wait (the wait is reached on restart with the same id).
• This task does not touch any harness; the resume (session, one-time grant) is the next task.

Tests

• Answer within the grace; answer after the timeout (through the flow wait, same wait id, one pending item); a late answer to an ended step is refused and recorded.
• Grace precedence (argument over step param over config); 0 does not wait.
• reject_once.
• Two answers at once: one wins.
• The crash table.

Rules for this repository

• Read AGENTS.md, docs/backlog/operad-contract.md (the point named above and "顺序") and the docs/backlog/ items it names first; do not contradict a decided point. A decided point that must change is changed in its own docs-only commit first.
• Never write under .git yourself. Never kill, signal or stop a process you did not start, and never use outside_sandbox to do it.
• Add no runtime dependency. Use @operad-io/engine/platform for processes, locks and watching; a spawn has at most three stdio entries.
• Record each mutation check in MUTATIONS.md of the package you changed (<task id>-M<n>).
• Run bash scripts/verify.sh once at the end and paste its bun test summary in the final answer.

## Lead notes

- Branch feat/ctx-ask from origin/main (has T-0021 step limits, T-0022 standard usage, TK0008, TK0009, T-0026 mcp-read). The other Sonnet works on T-0023 testing-package in parallel in the engine; keep your change to your point and expect to merge origin/main once before the end.
- Protocol first: the shape and docs in the first commit, then the code.
- Run `bash scripts/verify.sh` once at the end.

When done: `herdr pane send-text w8:p1 "ctx-ask done: <head sha>, verify <bun test summary>"` then `herdr pane send-keys w8:p1 enter`.
