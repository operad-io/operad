# ADR 0008: Asking a Person Inside a Step

Status: accepted

## Background

A step sometimes needs a person's answer in the middle of its work, and it must not matter whether the answer comes in a minute or in a day. A reviewer that was eaten by a 429 and burned ten attempts is the lesson behind keeping this separate from crash handling.

## Decisions

### D1: `ctx.ask({ prompt, choices, graceSecs?, onTimeout? })` returns the answer

This is the one new primitive in the kernel contract. It has three phases (D1 to D3). The first is the **grace period**: the process stays alive, and when the answer arrives the step continues at once. The grace period can be set at three layers, and the narrower overrides the wider: the global default (`config.json`, default 600 seconds); the flow or conversation level (a step parameter or an object field); and one single question (the parameter of `ctx.ask`). `0` means do not wait; there is no unlimited wait.

### D2: Timeout pause

The step ends with the result `waiting`. Its data carries the wait id, the harness's session reference and the question itself. The flow catches it with one edge `waiting → wait_person`, and the wait-for-person step keeps **the same wait id**, so pending still shows one item. There is no process at this time, and the wait can be as long as it needs to be.

### D3: Resume

When the answer arrives, the flow goes back to the same step with `resumeSession` and a one-time grant (valid for only the command or path that was asked about), and the prompt gains a sentence: "you asked X before, the answer is Y, continue". The harness re-sends that call, and the grant lets it pass directly; if it does something else instead, it is asked again.

The shape:

- The step's `resume` is `{ session, grant: { kind, value, choice, choices?, tool? } }`.
- A question with choices must write `choice`, which gives the grant. `choices` can list further answers that give the same grant. A question without choices gives it only with `approve`. A path grant must write `tool` and is valid only for that tool. `ctx.ask` rejects an unqualified form before it asks a person, and a step with `grants: false` cannot carry a grant.
- The answer stays in the run state until the step that asked runs again, and is delivered even if several steps lie between. When the flow comes back, the parameters gain `resumeSession` and `askAnswer: { prompt, choice, note }`, and the access profile gains `grants: [{ waitId, kind, value }]`.
- The grant is used up by a `grant_used` fact (carrying the wait id). The fact is written before the call is let through. So a grant is used at most once: if the process dies after writing the fact and before the call, that call is not let through again, and a person is asked again.
- A step definition's `resumable` is the bit the descriptor file decides. A step that writes `false` has its `ctx.ask` forced to `reject_once`.
- The radian harness has no hook that sees tool calls, so it cannot enforce a one-time grant, and a run that carries a grant is refused by it. The pi harness enforces in its `tool_call` handler.

### D4: What the kernel records, and the flow-level wait

The kernel records a wait-for-person fact carrying the step's effect id. The answer carries the wait id and is used only once, and it is right in whichever phase it lands. An answer for a step that has long ended is refused and a fact is recorded. Crash semantics do not change: if the process is gone, the step's `replay` decides. The flow-level `wait_person` stays for a long wait that holds no process; a flow author can use only that, and cannot use `ctx.ask`.

### D5: `onTimeout`

The behaviour after a timeout, `onTimeout`, is `waiting` (it requires the harness to be able to resume) or `reject_once` (the only choice for a harness that cannot resume, decided by the descriptor file, which a user cannot override).
