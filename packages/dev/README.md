# dev

The `dev` plugin turns a request into planned work and follows each task to a
merge. It is a plugin: the kernel knows none of these words.

## The words

| word | what it is |
|---|---|
| **repo** | a git work tree with a remote that `dev` is allowed to work on; `operad repo add <path>` registers it |
| **plan** | one request, its tasks and how far they may run without you |
| **task** | one unit of work in a plan, with a brief and the tasks that must merge before it |
| **brief** | the Markdown a task's worker reads; a rework section is appended to it, and a trailing `## Changes` section records every edit |
| **rework** | another pass over a task, added as `## Rework <n> (<source>)` |
| **confirm** | accept a plan (its tasks then become ready) or a single proposed task |
| **cancel** | stop a plan and its open tasks, or one task |
| **auto** | how far a plan may run without you: off, run, merge |
| **priority** | P0 (most urgent) to P5 (least urgent), default P3 |

A plan id is `P-<4 digits>-<slug>`; a task id is `T-<4 digits>-<slug>`.
Numbers count up per repository and are never reused, so two repositories may
both have `T-0001-work`; a command accepts the bare id inside the repository it
names. An object made before the change keeps its `PL…` or `TK…` id: commands,
views and `--after` accept both forms, and an id is matched exactly.

## Commands

```
operad repo add <path> [--name <name>]
operad repo list
operad repo remove <name>
operad plan add --slug <slug> --title <title> [--repo <name>]   # request on stdin
operad task add --plan <plan> --slug <slug> --title <title> [--after <task>]... [--area <area>] [--repo <name>]   # brief on stdin
operad task edit <id>      # $EDITOR on the brief body; proposed or ready only
operad task update <id> [--title <title>] [--after <task>]... [--area <area>]   # --area "" clears it
operad start <task>        # start one ready task now, whatever its plan's auto level
```

Inside a registered repository the repository is inferred; elsewhere pass
`--repo <name>`.

## Actions

Every action is also a command: `operad dev:<action> <id>`.

| action | object | key | what it does |
|---|---|---|---|
| `dev:confirm` | plan, task | `c` | confirm a draft plan (its tasks become ready) or a proposed task |
| `dev:merge` | task | | answer the task's wait with `merge`; asks first |
| `dev:reject` | task | | answer the task's wait with `reject` and append `## Rework <n> (owner)` with the note |
| `dev:rework` | task | | add the lead's own rework: `--note <text>` becomes `## Rework <n> (lead)`, and the worker runs again |
| `dev:reverify` | task | | run verify and review again on the task's current commit, with no worker |
| `dev:cancel` | plan, task | `x` | cancel a plan and its open tasks, or one task; asks first |
| `dev:auto` | plan | | set auto: `--level off`, `--level run` or `--level merge` |
| `dev:priority` | plan | | set the priority: `--level P0` (most urgent) to `--level P5` |

`merge` and `reject` answer the task's person wait. They appear in `pending`
only while the task is waiting, and are refused with a clear message otherwise.
`reject` takes the required note (`--note <text>`); the note becomes a rework
section and the task goes back to the worktree.

`rework` and `reverify` are for the lead. They work while the task waits for a
person, whatever stopped it: a passed review, a gate failure, or a worker that
returned nothing or failed (a model rate limit, a gate killed from outside).
They are listed in `pending` after `merge` and `reject`.

- `rework --note <text>` appends `## Rework <n> (lead)` and sends the task to a
  worker. It does not count toward `maxAutoRework`, and it resets the count of
  automatic reworks in a row to 0.
- `reverify` re-runs verify and review on the current head, with no worker, for
  example after a flaky failure. The result follows the normal gate path, and it
  does not count toward `maxAutoRework`.

Each action claims the task at the version it saw. A `merge`, `reject`, `cancel`
or second `rework` or `reverify` that got there first wins; the other reports
what happened and changes nothing.

## Steps

| step | results | what it does |
|---|---|---|
| `dev/worktree` | `ready`, `conflict`, `blocked`, `failed` | fetches, creates `worktreeRoot/<task id>` on `work/<task id>` from `<remote>/<mainBranch>`, and on a later attempt reuses it after merging the latest main; a start that carries a `blockedBy` dependency records the person wait instead |
| `dev/work` | `done`, `nothing`, `failed` | builds the worker prompt, runs the configured harness step in the worktree, then requires new commits, a clean tree and a pushed branch |
| `dev/verify` | `pass`, `fail` | recreates `<worktreeRoot>/<task id>-gate` detached at the branch head, runs `gate.commands` through `shell/check`, and records the verified commit |
| `dev/review` | `pass`, `fail`, `failed`, `unavailable`, `timed_out` | runs the reviewer harness step in the gate worktree on the diff from the merge base to the verified commit; a finding on a file the change did not touch is pre-existing and does not count |
| `dev/review_due` | `ready`, `interrupted` | the wait a review enters after a model was unavailable; it lets the flow run the same review round again at the recorded time |
| `dev/rework` | `again`, `ask` | appends `## Rework <n> (verify|review)` with the failed command or the counted findings and sends the task back to the worker; after `maxAutoRework` in a row it asks a person instead |
| `dev/integrate` | `merged`, `conflict`, `fail`, `failed` | fetches, builds the candidate in the gate worktree by merging the verified commit onto `<remote>/<mainBranch>`, runs `integration.keyCommands` through `shell/check`, and pushes plainly; a moved main starts again from the fetch, at most three times |
| `dev/cleanup` | `done` | runs `hooks.afterMerge` with `OPERAD_TASK`, `OPERAD_WORKTREE` and `OPERAD_REMOTE` set; a failing hook is recorded, not a task failure |

A conflict appends `## Rework <n> (conflict with main)` and sends the task back
to the worktree. A failing key command appends `## Rework <n> (integration)`.
The verified commit is merged even when the branch has moved past it, and the
step records that the head moved. A remote that refuses the push is `failed`
with git's message. Integrate is replay-safe: after a push it checks that the
remote's main contains the candidate instead of pushing again. Cleanup is also
replay-safe; the default hooks remove both worktrees and the local and remote
`work/<task id>` branch.

A conflict leaves the worktree mid-merge. The next `dev/work` prompt starts by
asking the worker to resolve it. A failed attempt names the uncommitted files.
The task records its attempt count, phase, session id and cost while these steps
run.

## Scheduling

On every tick of the kernel loop, `dev` starts ready tasks whose dependencies
have merged. A task starts only while its plan is at auto `run` or `merge`, the
plan's running count is under its `concurrency`, and the repository's running
count is under its `concurrency` setting. Plans are considered most urgent
first, and each registered repository is scheduled on its own. A task the
scheduler claimed but whose run never recorded itself (a crash between the two)
returns to `ready` on the next tick, so the scheduler can start it again.

At auto `merge`, a waiting task whose review passed in this attempt is answered
with `merge`. A wait that follows `nothing`, `failed` or the rework limit is
never answered. A task whose dependency was cancelled waits for a person
instead of starting, and a plan whose tasks have all merged or been cancelled
is reported finished once. Every change prints one line:
`T-0003-kernel ready -> running`.

`operad start <task>` asks the scheduler to start one ready task on its next
tick, whatever its plan's auto level is. The task's dependencies and both
concurrency limits still hold, so an ineligible task waits for a later tick.

A task whose dependency was cancelled starts no work. The scheduler starts its
flow into the person wait instead, so the task is a real pending item: `merge`
and `reject` answer it like any other wait, and `cancel` stops the run. The task
is counted as waiting, not running, so it does not hold a concurrency slot.

### Areas

A task may name an `area`, a short one-line string of at most 64 characters
such as `engine-core`. The scheduler never runs two tasks with the same area in
the same repository at once, whatever the concurrency; a task with no area is
not limited, and the same area name in two repositories does not block.

| | |
|---|---|
| type | string, default none |
| set | `operad task add --area <area>`, `operad task update <id> --area <area>` (`--area ""` clears it) |
| effect | a ready task whose area is held by a running or reviewing task is not started; it starts on a later tick once that task leaves those phases (it merges, is cancelled, or waits for a person) |
| when | the area is read on every tick, so a change made while the task is `proposed` or `ready` applies from the next tick |

`operad show <task>` prints the area, and `operad list task` shows `area: <a>`.
A ready task held back by its area shows `waiting for area <a> (<task>)`, naming
the task that holds it. A task waiting for a person does not hold its area, the
same way it holds no concurrency slot.

The check and the start are one decision: the scheduler claims a task under the
repository lock and reads the stored tasks inside that lock, so two ticks or two
`operad` processes cannot both start a task of one area.

## Flow

`dev` is the coding flow: worktree → work → verify → review → a person decides
`merge`, `reject` or `reverify` (the last runs verify and review again on the same
commit). A task whose dependency was cancelled enters the same
person wait directly from the worktree step. A failing verify or review goes to
`rework`, which sends the task back to the worktree until `maxAutoRework`
automatic reworks have run in a row; then it waits for a person. `nothing` and
`failed` from `work` also wait for a person. An unavailable reviewer waits for
`reviewer.retrySecs` and runs the same review again; a review that times out
twice waits for a person. `merge` builds the candidate on main and pushes it,
then cleanup removes the worktrees and branches. A plan is finished when every
task is merged or cancelled.

## Review fallback and retry

One review round is keyed by the attempt and the review number. It ends once,
with `passed`, `findings`, `unavailable` or `timed_out`. A fallback or a retry
is another run of the same round: the attempt and the rework count do not
change, and no worker starts.

The reviewer is unavailable when the harness reports a model error of kind
`unavailable` or `usage_limit` (the radian harness passes the `Result` record's
`model_error` through as `modelError`). When a harness reports none, the last
lines of its error output count only if one reads `HTTP 429`, `status 429` or
`too many requests`; a `429` elsewhere in the data (a line number, a duration)
does not. The same round runs once on `reviewer.fallback` at once. If the
repository sets no fallback, or the fallback is unavailable too, the task waits
with `retryAt` set to `now + reviewer.retrySecs` and does not rework. When the
time comes, `dev/review_due` lets the flow run the review again, with no new
attempt and no other step. A round uses its fallback at most once: a retry that
finds the primary unavailable again waits instead of trying the fallback a
second time. A wait longer than one step run is split into pieces below the
three-hour step timeout, so any positive `reviewer.retrySecs` is waited out and
the review runs a model again only at `retryAt`.

The waits are bounded. A round waits at most 36 times (`MAX_REVIEW_WAITS`, about
72 minutes at the default 120 seconds); the count is the number of primary runs
of the round recorded as unavailable in the task, so a crash and a restart agree
on it. The next unavailable run waits for a person with the note `review did not
finish (model unavailable)`. The dev flow's visit limit is finite (10 plus one
visit of each wait step per allowed wait). One review step also has to end
before its three-hour step timeout: a run that cannot fit in what is left is
skipped, and the round waits for a person with the note `review did not finish
(out of time)`. While a review waits for its model, `merge`, `reject`, `rework`
and `reverify` are not offered.

A reviewer that wrote a valid report and then stalled, timed out or exited
non-zero has reviewed: its report is used and a retry never deletes it. Only an
unreadable report is removed before a run. `dev:reverify` starts review round 1
again with no runs from the old round.

A review that times out runs once more with the same arguments. A second
timeout waits for a person with the note `review timed out twice`. Neither an
unavailable reviewer nor a timeout counts toward `maxAutoRework`: only a review
that returns findings at or above `reviewer.fixLevel` does.

The task's history names the model that reviewed each round and why a fallback
or a retry happened.

### Crash table

A review round writes the run it is about to make to the task, and each
reviewer call writes its outcome beside the report before it returns. A crash
therefore resumes the same round and reuses the answer instead of asking the
same model again.

| crash point | what is recorded | the resumed round does | test |
|---|---|---|---|
| after the first run's result | the pending primary run and its outcome | reads the outcome back; never asks the first model again | `dev/review crash recovery > a crash after the first result reuses it instead of asking again` |
| after an unavailable first result | the pending primary run and its `unavailable` outcome | runs the fallback once; never repeats the primary | `dev/review crash recovery > a crash after an unavailable first result resumes on the fallback` |
| during the fallback | the primary run, and the fallback as pending with its outcome | reads the fallback outcome back; no model runs again | `dev/review crash recovery > a crash during the fallback reads its result back` |
| after the first run was saved | the primary run in the round | runs the fallback once | `dev/review crash recovery > a crash after the first run was saved resumes on the fallback` |

## Review diff size

Before building the review prompt, the step leaves out files marked
`linguist-vendored`, `linguist-generated`, `-diff` or `binary` in
`.gitattributes`, and every file whose own diff is over `maxFileDiffBytes`. Each
left-out file is listed with its added/removed line counts and the reason. If
the remaining diff is over `maxDiffBytes`, no reviewer starts and the step fails
with the size and the largest files, so a person sees why.

## Settings

`operad repo add` writes `<repository>/.operad/dev.json` when it is absent (its
schema is `dev.schema.json`) and adds `.operad-worktrees/` and
`.radian-sandbox/` to the repository's `.git/info/exclude`.

The file holds the repository's work settings:

| field | default | what it is |
|---|---|---|
| `remote` | `origin` | the remote a task branch is fetched from and pushed to |
| `mainBranch` | `main` | the branch a task starts from and merges on each attempt |
| `worktreeRoot` | `.operad-worktrees` | where task worktrees live, relative to the repository and inside it |
| `concurrency` | `1` | how many tasks this repository may run at once; each plan also has its own limit |
| `worker.use` | `harness-radian/agent` | the harness step that works a task |
| `worker.args` | `[]` | extra arguments for that harness step |
| `worker.wallTimeSecs`, `worker.stallSecs` | harness defaults | the worker's time limits |
| `workerBrief` | `.operad/worker-brief.md` | the brief a worker reads first; a missing file means the built-in text |
| `gate.commands` | `[]` | the commands the verify step runs on the task commit |
| `gate.commandTimeoutSecs` | `1800` | the longest one gate command may run |
| `reviewer.use` | `harness-radian/agent` | the harness step that reviews the diff |
| `reviewer.args` | `[]` | the arguments every review gets |
| `reviewer.firstArgs` | none | the arguments the first review of an attempt gets instead, including its one retry after an invalid report |
| `reviewer.fallback.use` | none | the harness step that reviews when the primary reviewer is unavailable |
| `reviewer.fallback.args` | `[]` | the arguments every fallback review gets |
| `reviewer.timeoutSecs` | `600` | the longest a review may run |
| `reviewer.stallSecs` | harness default | how long a review may print no new line before it is stopped |
| `reviewer.fixLevel` | `major` | the lowest finding severity that fails the gate: `critical`, `major` or `minor` |
| `reviewer.retrySecs` | `120` | how long an unavailable review waits before the same round runs again |
| `reviewer.maxFileDiffBytes` | `200000` | the largest diff one file may put in the review prompt |
| `reviewer.maxDiffBytes` | `1000000` | the largest diff the review prompt may carry |
| `maxAutoRework` | `2` | how many automatic reworks in a row are allowed before waiting for a person |
| `integration.style` | `merge` | `merge` lands a merge commit with `Merge work/<task id> (<short sha>)`; `squash` lands one squashed commit |
| `integration.keyCommands` | `[]` | commands the integrate step runs on the candidate before the push; a failure sends the task back to the worker |
| `hooks.afterMerge` | removes both worktrees and both branches | commands cleanup runs after a merge, in the repository root, with `OPERAD_TASK`, `OPERAD_WORKTREE` and `OPERAD_REMOTE` set |

The built-in brief says to work only in the worktree, commit whole pieces, run
the repository's verify command and end with a summary.

A `dev.json` written by an earlier version still loads: `worktrees` is read as
`worktreeRoot`, and `sandbox` is ignored. A `worktreeRoot` that is absolute,
climbs out of the repository, or resolves outside it through a symlink is
refused when the file is read and again before a worktree is created.

## Views

A plan shows a request and a table of its tasks. A task shows its brief, its
rework sections when it has some, and its changes.
