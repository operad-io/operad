---
description: Asking a person from a step.
---

# Asking a person from a step

A step can ask a person a question and carry on with the answer. The step calls
`ctx.ask`; a flow cannot.

```ts
const answer = await ctx.ask({
  prompt: "Delete the stale branch?",
  choices: ["yes", "no"],
  graceSecs: 120,
  onTimeout: "waiting",
  resume: { session: "abc" },
});
```

`ctx.ask` returns `{ choice, note, actor }`. The question shows up in
`operad pending` and `GET /v1/pending` as one item, with the run's object and
its `waitId`, like any other wait. `POST /v1/answer` and the MCP `answer` tool
take that `runId`, `waitId` and one of the choices.

**The grace.** While the step's process is alive the answer goes straight to the
waiting call and the step goes on. The wait lasts the narrowest of: the
`graceSecs` of the call, the step's `askGraceSecs` param, and `ask.graceSecs` in
`config.json` (default `600`). `0` does not wait. There is no unlimited value.
The step's own timeout does not run while it waits for an answer.

```json
{ "ask": { "graceSecs": 600 } }
```

**When the grace passes.** `onTimeout` decides:

| `onTimeout` | What happens |
|---|---|
| `"waiting"` (default) | The step ends with the result `waiting` and the data `{ waitId, prompt, choices, resume }`. The flow must have an edge `waiting` to a `wait_person` step; that step shows the same item (same wait id) and an answer to it takes the edge the choice names. |
| `"reject_once"` | The call returns `{ choice: undefined, rejected: true }` and the step goes on. |

A step that asks with `onTimeout: "waiting"` (the default) must declare
`waiting` in its `results`. If it does not, `ctx.ask` fails at once, before
anything is asked, with an error that says so; otherwise the question would be
lost when the grace passed. A step that only ever uses `"reject_once"` does not
need `waiting`.

A flow where a step can end `waiting` and has no `waiting` edge to a
`wait_person` step is refused when it loads.

A step asks one question at a time. A second `ctx.ask` while the first has no
answer yet fails at once with `a step asks one question at a time`.

`graceSecs` (the call, the step's `askGraceSecs` and `ask.graceSecs` in
`config.json`) is a number of seconds from `0` to `2147483` (about 24 days);
anything above is refused with a message.

**One answer.** The first answer to a question counts. A second one is refused
with `already answered`. An answer that comes after the step ended, when its
flow wait was not reached, is refused and recorded in `operad history` as
refused. An answer to a question that was already answered is never applied
twice, also not after a crash.

**After a crash.** A question has a stable id, `<run>:<step run>:<n>`. If the
process stops while it waits, a step that is safe to run again asks again with the
same id, so the item stays one; an answer that came in meanwhile is given to the
step from the log. If the process stops after the step ended `waiting`, the
flow wait is reached on restart with the same id.

**Carrying on after the answer.** When the person answers the wait that a
`waiting` step left, the step that asked runs again, also when the flow goes
through other steps on the way from the wait back to it (those run with their own
params; the answer waits for the asking step). The step runs again with its
params plus:

| param | what it holds |
|---|---|
| `resumeSession` | the session the step left in `resume` (`resume` as a string, or `resume.session`) |
| `askAnswer` | `{ prompt, choice, note }`: the question and the answer |

A harness step adds one paragraph to the prompt: `You asked: <prompt>. The answer
is: <answer>. Continue.` The prompt and the choice are put on one line. A note
the person wrote is quoted after it, each line behind `> `, and marked as part
of the answer, not as an instruction.

If `resume` is `{ session, grant: { kind, value } }`, with `kind` `"command"` or
`"path"` and `value` the exact command or path the step asked about, the run
also gets a one-time permission for that call in `access.grants`
(`{ waitId, kind, value, tool? }`). Only the choice that approves gives it:
`grant.choice`, which is required when the question has choices and must be one
of them (`ctx.ask` refuses the question before anyone is asked otherwise). A
`grant.choices` list names more than one approving answer. A question without
choices gives the permission only for the answer `approve`.
A path grant also names the `tool` the person approved (`write` is not `read`);
`ctx.ask` refuses a path grant without one. A harness lets a call that
equals `value` exactly through once: it uses the permission up (recorded in
`operad history` as "let one call through that you approved", before the call
runs, so a crash cannot give it twice), a second identical call is checked
against the profile as usual, and a different call is too.

A step type that cannot run again from where it left (`resumable: false` in its
definition) cannot be asked with `"waiting"`: its questions are forced to
`onTimeout: "reject_once"`. `pi`, `claude` and `radian` all resume.
`radian` cannot enforce a one-time permission (no hook sees its tool
calls); a step type that says `grants: false` has `ctx.ask` refuse a question
that offers one, before anyone is asked. If a run still reaches radian with one,
it fails with `grant_unsupported`. A resumed radian run that answers with another
session than the one it was given fails with `session_missing`.
