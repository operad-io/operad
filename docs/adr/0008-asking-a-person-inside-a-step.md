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
- The answer stays in the run state until the step that asked runs again, and is delivered even if several steps lie between. When the flow comes back, the parameters gain `resumeSession` and `askAnswer: { prompt, choice, note, actor? }`, and the access profile gains `grants: [{ waitId, kind, value }]`. The actor is who answered, so a grant a late answer records can name the same person as an answer within the grace.
- The grant is used up by a `grant_used` fact (carrying the wait id). The fact is written before the call is let through. So a grant is used at most once: if the process dies after writing the fact and before the call, that call is not let through again, and a person is asked again.
- A step definition's `resumable` is the bit the descriptor file decides. A step that writes `false` has its `ctx.ask` forced to `reject_once`.
- The radian harness has no hook that sees tool calls, so it cannot enforce a one-time grant, and a run that carries a grant is refused by it. The pi harness enforces in its `tool_call` handler.

### D4: What the kernel records, and the flow-level wait

The kernel records a wait-for-person fact carrying the step's effect id. The answer carries the wait id and is used only once, and it is right in whichever phase it lands. An answer for a step that has long ended is refused and a fact is recorded. Crash semantics do not change: if the process is gone, the step's `replay` decides. The flow-level `wait_person` stays for a long wait that holds no process; a flow author can use only that, and cannot use `ctx.ask`.

### D5: `onTimeout`

The default behaviour after a timeout, `onTimeout`, is `waiting` (it requires the harness to be able to resume) or `reject_once` (the only choice for a harness that cannot resume, decided by the descriptor file, which a user cannot override).

### D6: A choice may say what it is

A question may carry `choiceInfo`, keyed by a choice string. Each value may hold `label` (what a button shows instead of the raw choice), `hint` (one sentence saying what choosing it does), `role` (`"primary"` for the one the asker recommends, `"destructive"` for one that cannot be undone) and `note` (`"optional"` or `"required"`). At most one choice is `primary`; any number may be `destructive`. Every key must be one of the question's choices.

`choiceInfo` is accepted wherever choices are given: on `ctx.ask`, on a flow's `wait_person` step, and on a question a harness passes on. The kernel checks the keys, the roles and the bounds of the strings before anyone is asked, then only carries the value: into the wait's record, the pending view, the HTTP pending read, the MCP `pending` tool and a channel event. The choice string itself remains the value an answer sends. A question without `choiceInfo` reads exactly as before, and the kernel gives no choice a meaning of its own.

### D7: A question may be a form

`ctx.ask({ prompt, questions })` asks a form instead of one answer: one or more
questions, each with an `id`, its `text`, an optional short `header`, choices of
`label` and `description`, `multiple` and `freeText`. A form carries no
`choices` of its own. The kernel checks the shape before anyone is asked (a
non-empty id and text, an id used once, at most 8 questions with at most 8
choices each, and the bounds of each string), then carries it unchanged: into
the wait's record, the pending view, the HTTP pending read, the MCP `pending`
tool, a channel event, and the resumed step's `askAnswer`, which carries the
form beside its answers so the step can name each answer. A form that runs out
of grace is carried on exactly as D2 to D5 carry a choice question, so the same
item stays pending and a late answer still reaches the step.

When a form has exactly one question that offers choices, takes no free text and
is not multiple, the kernel also exposes that question's labels as the
question's `choices`, so a client that knows only a choice still answers it. Any
other form has none; such a client shows the form's text and cannot answer every
question, and that is the form's own limit, not a second question.

The answer is `answers: [{ id, choices?, text?, skipped? }]`: the labels picked,
the person's own text, or `skipped`. A question the answer leaves out counts as
skipped, so a person can always finish the form. The kernel checks every answer
against the form: the id names one of its questions and is used once, a label is
one of that question's choices, `text` needs `freeText`, more than one label
needs `multiple`, and a skipped answer carries neither. An invalid answer is
refused before anything is recorded. A plain `choice` is still an answer when
the form is one question, and is refused for any other form.

A form asks no one-time permission: `resume.grant` and the approving choices
play no part. The flow edge a late form answer takes is the one the asker named
in `resume.choice` when that is an edge of the wait step, else the answer's own
choice when it is an edge, else the wait step's first choice. A harness that
only gives text has no form and keeps D1 to D6 exactly as they are.
