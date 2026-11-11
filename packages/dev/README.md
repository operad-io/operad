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
| **pause** | stop a task for a while; **resume** undoes it |
| **auto** | how far a plan may run without you: off, run, merge |
| **priority** | P0 (most urgent) to P5 (least urgent), default P3 |

## The hierarchy

`dev` is a hierarchy of three levels: repo → plan → task. Each level is an
object type, and a row names the level above it as its `parent`:

- A **repo** object exists for every repository registered with
  `operad repo add`; its id is the repository name. It has no parent, so it is
  a top-level object of `dev`. Its row has the name as id and title, the state
  `active` (or `removed` after `repo remove`) and a note with the open plan and
  open task counts. The default filter shows `active`; `--filter removed` shows
  the removed ones. Its sections are Overview (the path, the default branch,
  whether `.operad/dev.json` is in force, the worker and the reviewer) and the
  kernel's History. A repo has no actions of its own: `repo add` and
  `repo remove` stay commands. A repository registered before `repo` existed
  is carried over the first time anything lists or reads `repo` objects, so
  `operad list repo` works in a fresh process.
- A **plan**'s parent is its repo (`repo:<name>`).
- A **task**'s parent is its plan (`plan:<repo>/<plan id>`), so two repositories
  that both have `P-0001-work` never share tasks.

`operad list --root` lists the top level; `operad list --parent <id>` lists the
next level down, with the child type's default filter (finished plans are
hidden and counted in `hidden`).

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
operad plan add --slug <slug> --title <title> [--concurrency <n>] [--flow <name>] [--repo <name>]   # request on stdin
operad task add --plan <plan> --slug <slug> --title <title> [--after <task>]... [--area <area>] [--flow <name>] [--repo <name>]   # brief on stdin
operad task edit <id>      # $EDITOR on the brief body; proposed or ready only
operad task update <id> [--title <title>] [--after <task>]... [--area <area>] [--flow <name>]   # --area "" clears it, --after "" clears the dependencies
operad start <task>        # start one ready task now, whatever its plan's auto level
operad reruns              # how often each test passed only on its own rerun, most frequent first
```

### Where a command runs, and ids

A command that looks up a plan or a task (`start`, `task edit`, `task update`,
`show`, every `dev:<action>`) finds its repository in this order:

1. A qualified id, `<repo>/<id>` as `operad list` prints it
   (`operad start operad/T-0045-shell-hang-guards`), names the repository, from
   any directory. `--repo` with a different repository is refused, naming both.
2. `--repo <name>`.
3. Inside a registered repository, a bare id means that repository's object.
   The longest registered path that contains the directory wins.
4. Outside every repository, a bare id resolves when exactly one registered
   repository has an object with that id. When several do, the error lists the
   qualified ids to choose from.

`plan add` and `task add` create rather than look up, so they never guess from an
id: they use the repository of the directory or `--repo`.

When no repository applies, the error names the directory and lists the
registered ones, a repository whose path is gone marked `(missing)`:

```
no registered repository contains /Users/hai/Code/radian; run the command inside one of these, or pass --repo <name>:
  operad      ~/Code/operad
  operad-ios  ~/Code/operad-ios
```

With nothing registered it points at `operad repo add <path>`.

## Actions

Every action is also a command: `operad dev:<action> <id>`.

| action | object | key | what it does |
|---|---|---|---|
| `dev:confirm` | plan, task | `c` | confirm a draft plan (its tasks become ready) or a proposed task |
| `dev:merge` | task | | answer the task's wait with `merge`; asks first |
| `dev:reject` | task | | answer the task's wait with `reject` and append `## Rework <n> (owner)` with the note |
| `dev:rework` | task | | add the lead's own rework: `--note <text>` becomes `## Rework <n> (lead)`, and the worker runs again; history reads "you chose rework" with the note |
| `dev:reverify` | task | | run verify and review again on the task's current commit, with no worker |
| `dev:cancel` | plan, task | `x` | cancel a plan and its open tasks, or one task; asks first |
| `dev:pause` | task | | stop a ready, running or reviewing task for a while: the step stops as `cancel` stops it (its processes too), but the task keeps its branch, worktree, commits, attempt count and place. It shows as paused (mark `paused`), holds no concurrency slot, and is not started; a task that follows it stays queued as for any unmerged task. Owner action, not offered through MCP; asks first |
| `dev:resume` | task | | undo pause: the task is ready again, and its next start is a new attempt that begins with the worktree step on the existing branch, as a rework does. Owner action, not offered through MCP; asks first |
| `dev:auto` | plan | | set auto: `--level off`, `--level run` or `--level merge` |
| `dev:priority` | plan | | set the priority: `--level P0` (most urgent) to `--level P5` |
| `dev:concurrency` | plan | | set how many of the plan's tasks may run at once: `--count 1` to `--count 16`; takes effect at the next tick, running tasks are not stopped |

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
- `reverify` merges the current `<remote>/<mainBranch>` into the task branch,
  then re-runs verify and review on the result, with no worker, for example
  after a flaky failure. A clean merge (or a main already contained) goes
  straight to verify; a main that conflicts goes to the worker with the
  conflict prompt. The history says `reverify: merged main <sha>, checking
  again` or `reverify: main conflicts, sending to work`. The result follows the
  normal gate path, and it does not count toward `maxAutoRework`.

Each action claims the task at the version it saw. A `merge`, `reject`, `cancel`
or second `rework` or `reverify` that got there first wins; the other reports
what happened and changes nothing.

## Flows

A repository sets its own development flows in `.operad/dev.json`. A flow is an
ordered list of stages; dev keeps the worktree at the start and integrate and
cleanup at the end, so a repository writes neither.

```json
{
  "flows": {
    "default": {
      "stages": [
        { "stage": "work" },
        { "stage": "check" },
        { "stage": "review", "grading": "default" },
        { "stage": "human" }
      ]
    },
    "quick": {
      "stages": [
        { "stage": "work" },
        { "stage": "check", "commands": ["bun test"] },
        { "stage": "human" }
      ]
    }
  }
}
```

A repository that writes no `flows` runs the built-in `default` flow: work,
check, review, human. A flow named `default` is the one a task starts with; a
plan or task may choose another with `--flow <name>`, and once a task's first
attempt starts it keeps that flow (`task update --flow` refuses after it). A task
without `--flow` takes its plan's flow, and a plan without one takes `default`. A task whose
flow dev.json does not define stays ready, and its row and its plan's row say `flow <name>
is not defined in .operad/dev.json`. When a repository defines more than one flow, the task
row and the Brief name the task's flow, and history names it on each run start. Every flow needs at least one `check`,
`review` or `human` stage. A `human` stage asks a person; when it is the last
stage, its merge answer goes to integrate, and when it is not, that answer
continues with the next stage. A flow whose last stage is not `human` goes
straight to integrate after that stage passes, so its plan's auto level has no
human wait to answer. A flow with no gate makes dev.json invalid, with a message
naming the flow and the rule.

### Stages

| stage | parameters | what it does | results |
|---|---|---|---|
| `work` | `use`, `args`, `brief`, `beforeAttempt` | a worker changes the task branch; `use` and `args` replace the harness step and its arguments, `brief` is appended to the worker's prompt, and `beforeAttempt` is the preparation before the attempt: `merge-main` fetches and merges the latest main, `none` leaves the branch as it is | `done`, `nothing`, `failed`, `unavailable`, `cancelled`, `interrupted` |
| `check` | `commands`, `rerun` | runs the commands in a gate checkout of the verified commit; unset values come from `gate.commands` and `check.rerun` | `pass`, `fail`, `cancelled` |
| `review` | `use`, `args`, `later`, `grading` | a reviewer reads the diff from the merge base to the verified commit; unset values come from `reviewer`, `later` replaces the arguments after the first review of an attempt, and `grading` names the entry in `.operad/review.json` (unset means the flow's own name) | `pass`, `fail`, `failed`, `unavailable`, `timed_out`, `exhausted`, `out_of_time`, `cancelled` |
| `human` | none | waits for a person to merge, reject, rework or reverify | the person's choice |

A failed `check` or `review` appends its rework section and goes back to the
nearest `work` stage before it. With no `work` before it, the run waits for a
person instead. The retry steps, the unavailable-model waits, the review
timeout waits, cancellation and the announcements are the ones the built-in
flow has, one set per stage.

A work stage passes its harness override as the step params `flowUse`,
`flowArgs` and `flowBrief`; a check stage passes `commands` and `rerun`, and a
review stage passes `use`, `args`, `later` and `grading`. A hand-written flow
passes the same names to `dev/work`, `dev/verify` and `dev/review`.

### How a flow is registered

The built-in flow keeps the name `dev`, so runs and history from before
projects could set flows keep working. A repository's flow is registered under
`dev/<repository>/<flow>/<hash>`, where the hash is the first 12 hex digits of
the SHA-1 of its stages. Two repositories may therefore use the same flow name,
and a changed `flows` entry gets a new name instead of replacing a graph a
running attempt still uses. A start records the graph on the task; every tick
declares the graphs of the tasks it finds, so a fresh process resumes a running
attempt on the graph it started with.

### Writing a flow in TypeScript

The compiled stages are the building blocks for `.operad/flows/<name>.flow.ts`:
a hand-written flow calls the same plugin steps. `dev/worktree`,
`dev/reverify`, `dev/work`, `dev/verify`, `dev/review`, `dev/rework`,
`dev/integrate` and `dev/cleanup` are described in the Steps table below;
`dev/retry`, `dev/review_due`, `dev/work_due` and `dev/retry_due` are the waits
and retries around them, and `dev/announce` tells the outside world that a run
stopped. A hand-written flow keeps the same hard rules: integrate and cleanup
last, and at least one gate.

## Steps

| step | results | what it does |
|---|---|---|
| `dev/worktree` | `ready`, `conflict`, `blocked`, `failed` | fetches, creates `worktreeRoot/<task id>` on `work/<task id>` from `<remote>/<mainBranch>`, and on a later attempt reuses it after merging the latest main; a start that carries a `blockedBy` dependency records the person wait instead |
| `dev/reverify` | `ready`, `conflict`, `failed` | the first step of a reverify: fetches and merges the current main into the task branch in the existing worktree, keeping the attempt; `ready` goes to verify, `conflict` to the worker |
| `dev/work` | `done`, `nothing`, `failed` | builds the worker prompt, runs the configured harness step in the worktree, then requires new commits, a clean tree and a pushed branch |
| `dev/verify` | `pass`, `fail` | recreates `<worktreeRoot>/<task id>-gate` detached at the branch head, runs `gate.commands` through `shell/check`, and records the verified commit |
| `dev/review` | `pass`, `fail`, `failed`, `unavailable`, `timed_out` | runs the reviewer harness step in the gate worktree on the diff from the merge base to the verified commit; the previous review is the newest report for another commit (see Rework rounds); in every review a finding far from the task's own change and from the previous review's findings is moved out of the failing set as pre-existing, while a critical one or one without a place still fails |
| `dev/review_due` | `ready`, `interrupted` | the wait a review enters after a model was unavailable; it lets the flow run the same review round again at the recorded time |
| `dev/retry` | `again`, `hold`, `ask`, `give_up`, `cancelled` | runs in front of the announcement of a work, worktree or reverify step that stopped. A stop that is not the task's own work (the run stopped, a process killed by a signal nobody sent, a step that is not loaded, settings that cannot be read) runs the step once more in the same attempt, without a person and without counting toward `maxAutoRework`; a second one, or a wait that ran out, goes to a person and the waiting line names the cause (for example `pool/agent is not loaded`) |
| `dev/retry_due` | `ready`, `waiting`, `interrupted` | the wait a retry enters while a step is not loaded or the settings cannot be read; it ends when they are there, or after `retry.environmentWaitMinutes` (default 60) |
| `dev/rework` | `again`, `ask` | appends `## Rework <n> (verify|review)` with the failed command or the counted findings and sends the task back to the worker; after `maxAutoRework` in a row, or when a review failure follows a review failure (whatever the findings; a verify failure or a conflict between them resets this), it asks a person instead, with the reason `review failed twice in a row` and both rounds' findings in the section |
| `dev/integrate` | `merged`, `conflict`, `fail`, `failed` | fetches, builds the candidate in the gate worktree by merging the verified commit onto `<remote>/<mainBranch>`, runs `integration.keyCommands` through `shell/check`, and pushes plainly; a moved main starts again from the fetch, at most three times. Tasks of one repository integrate one at a time: a task whose merge was chosen waits for its turn first (see below) |
| `dev/cleanup` | `done` | runs `hooks.afterMerge` with `OPERAD_TASK`, `OPERAD_WORKTREE` and `OPERAD_REMOTE` set; a failing hook is recorded, not a task failure |

A conflict appends `## Rework <n> (conflict with main)` and sends the task back
to the worktree. A failing key command appends `## Rework <n> (integration)`.
The verified commit is merged even when the branch has moved past it, and the
step records that the head moved. A remote that refuses the push is `failed`
with git's message. Integrate is replay-safe: after a push it checks that the
remote's main contains the candidate instead of pushing again. Cleanup is also
replay-safe; the default hooks remove both worktrees and the local and remote
`work/<task id>` branch.

A merge updates the main clone when it can. After the push, integrate
fast-forwards the repository's own checkout (the one `operad serve` and every
run execute) to the merged commit, but only when that checkout is on
`<mainBranch>` and has no uncommitted changes to tracked files. Otherwise it
leaves the checkout alone and says why in the step data (`mainClone`) and in
the task's Changes ("main clone not updated: uncommitted changes"). It only
fast-forwards through git: no reset, rebase or stash. When `bun.lock` changed
in the merge it then runs `bun install --frozen-lockfile` there and reports the
result the same way. A running serve keeps the code it loaded until it is
restarted; new runs use the new code.

A conflict leaves the worktree mid-merge. The next `dev/work` prompt starts by
asking the worker to resolve it. A failed attempt names the uncommitted files.
The task records its attempt count, phase, session id and cost while these steps
run.

### What a step cleans up

Every process a step starts (the worker's harness, the reviewer's harness, a
check) carries `OPERAD_RUN=<run id>:<step>` in its environment, with
`OPERAD_RUN_HOME` naming the home so two homes never meet. Children inherit it
whatever process group or session they move to, which a command a worker runs
can do: the Bash tool of a coding agent starts each command in a process group
of its own, so a loop it leaves in the background is outside the group the
harness stops.

When a step ends, however it ends (done, nothing, failed, timeout, cancelled),
the platform finds every live process of the same user that still carries the
step's marker and stops it: TERM, a short wait, KILL. The step log says how many
and which commands, one line each, cut to 120 characters. `operad serve` does the
same at start for the markers of runs that are no longer active, which a serve
that died left behind, and says so once in the serve log.

The environment alone is not enough on macOS: the system withholds the
environment of Apple's own binaries (`/bin/sh`, `/bin/bash`, `/bin/zsh`), so a
shell loop a command leaves behind carries the marker without showing it. The
platform therefore also follows the processes themselves. While a step runs, a
kernel watch (kqueue, reached with `bun:ffi`) reports every fork of a process
below the ones the step started, and each fork is answered at once with a look
at that process's children. The kernel keeps the reports until they are read,
and they are read every 2 ms, so a shell that ends right after it started its
loops is still seen while it lives. A table read with `ps` every 200 ms backs
this up (and is all there is where the watch is not available). What was seen is
remembered by pid and start time. A command's shell leads a process group of its
own, and what it left behind keeps that group id, so a later member of the group
is stopped too, if it started while the leader lived: a process that was given
the leader's pid after the leader was gone started later and is left alone. At
the end of the step the sweep stops all of these and the parent of every marked
process, so a shell loop that starts one program after another is stopped before
it starts the next, and it looks again up to three times for what a stopped
process started.

Limits. A process that removes `OPERAD_RUN` from its own environment is not
found by the marker, and the sweep does not chase it. On macOS a system shell
loop is found through the watch, not the marker, so one that leaves its parent
and its process group before the watch has looked at it (a `setsid` or a
double fork) is not found, and neither is a loop whose parent ends within a few
milliseconds of starting it, before the watch has looked at the parent. On Linux the environment
is read from `/proc/<pid>/environ` and shows every process.

## Scheduling

On every tick of the kernel loop, `dev` starts ready tasks whose dependencies
have merged. A task starts only while its plan is at auto `run` or `merge`, the
plan's running count is under its `concurrency`, and the repository's running
count is under its `concurrency` setting. Plans are considered most urgent
first; within one priority they take turns (the plan that started a task least
recently goes first). When the repository has more than one slot, one slot
is kept for the plan that has gone longest without starting a task: while no
running task holds it, the last free slot goes to that plan, whatever its
priority. Every other freed slot goes by priority. So a plan with a startable
task never waits forever behind more urgent plans. With one slot, priority
alone orders the queue. Each registered repository is scheduled on its own. A
task the scheduler claimed but whose run never recorded itself (a crash between
the two) returns to `ready` on the next tick, so the scheduler can start it
again.

At auto `merge`, a waiting task whose review passed in this attempt is answered
with `merge`. A wait that follows `nothing`, `failed`, the rework limit or `review failed twice in a row` is
never answered. A task whose dependency was cancelled waits for a person
instead of starting, and a plan whose tasks have all merged or been cancelled
is reported finished once. Every change prints one line:
`T-0003-kernel ready -> running`.

`operad start <task>` asks the scheduler to start one ready task on its next
tick, whatever its plan's auto level is. The task's dependencies and both
concurrency limits still hold, so an ineligible task waits for a later tick.

`operad task update <id> --after ...` also works on a task that waits because a
dependency was cancelled: changing its dependencies, or clearing them with
`--after ""`, ends that wait (its run is stopped), and the task starts on a later
tick like any ready task.

`--after` takes a task id (a task of this repository, in any plan) or
`<repository>/<task id>` (a task of any registered repository). Either way the
full key is stored. A task is `blocked` until every task it follows is merged,
wherever it is; its note says `waiting for operad/T-0188` when the task is in
another repository. A task must exist when it is named; a task cannot follow
itself or close a cycle (the refusal shows the cycle). A cancelled dependency,
in any plan or repository, makes the task wait for a person as above.

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
the task that holds it; when ready tasks of the area are queued before it, the
note ends `, <n> ahead`. A task waiting for a person does not hold its area, the
same way it holds no concurrency slot.

The check and the start are one decision: the scheduler claims a task under the
repository lock and reads the stored tasks inside that lock, so two ticks or two
`operad` processes cannot both start a task of one area.

## Flow

`dev` is the coding flow: worktree → work → verify → review → a person decides
`merge`, `reject` or `reverify` (the last merges the current main into the branch, then runs verify and
review again on it with no worker). A task whose dependency was cancelled enters the same
person wait directly from the worktree step. A failing verify or review goes to
`rework`, which sends the task back to the worktree until `maxAutoRework`
automatic reworks have run in a row, or a second review failure in a row; then it waits for a person (`review failed twice in a row`), and the lead's `rework --note` or `reject` steers the next pass. `reverify` at that wait keeps the count, so a review failure on the reverified head waits again at once; a passed review or a merge conflict clears it. `nothing` and
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

The waits are bounded. A round waits at most 6 times (`MAX_REVIEW_WAITS`); the first wait is
`reviewer.retrySecs` and each further wait doubles, up to 30 minutes (2, 4, 8, 16,
30, 30 minutes at the default: about 90); the count is the number of primary runs
of the round recorded as unavailable in the task, so a crash and a restart agree
on it. The next unavailable run waits for a person with the note `review did not
finish (model unavailable)`. The dev flow's visit limit is finite (10 plus one
visit of each wait step per allowed work wait). One review step also has to end
before its three-hour step timeout: a run that cannot fit in what is left is
skipped, and the round waits for a person with the note `review did not finish
(out of time)`. While a review waits for its model, `merge`, `reject`, `rework`
and `reverify` are not offered.

Each reviewer call writes its report inside the gate worktree, because some
agents cannot write elsewhere: `.operad/review/<run>-attempt-<n>-review-<round>-try-<k>.json`,
where `k` is the number of calls before it in the round, so every call has a
path of its own and a stale report is never read. The prompt names that path.
Before the call dev creates `.operad` and `.operad/review` if missing, looking
at each component with `lstat`; if either is not a plain directory (a link, a
file) or a file already exists at the report path, the review fails naming the
path and nothing is written. After the call dev reads the report only if it is
a regular file, validates it, and writes a copy to
`<store>/dev/reviews/<run>/<task>-attempt-<n>-review-<round>.json`, which is the
record the history and views point at; a failed copy fails the step and leaves
the workspace file. **dev never removes, truncates or overwrites anything under
the gate worktree's `.operad`**; the worktree is disposable and its next
recreation removes the reports. Nothing is committed from the gate worktree
(the integrate step recreates it first and only commits a squash or merge of
the index), so the reports cannot reach a commit.

How a call is named, in this order: a valid report is used whatever the harness
result; a file that fails validation is `wrote an invalid report`; with no file,
a timeout is `timed_out` and an unavailable model is `unavailable` (they drive
retry and fallback), and anything else is `could not write the report` with the
reviewer's last message. The review folders are checked (plain directories, same
device and inode) before and after the report is read, and a missing folder, a
link or a mismatch fails the round. A run resumed from before this
change reads the store path too when the workspace path has no file. A crash
after the report was written and before the copy is recovered by copying the
report from the old worktree before it is replaced, not by asking again.

A reviewer that wrote a valid report and then stalled, timed out or exited
non-zero has reviewed: its report is used and a retry never deletes it. `dev:reverify` starts review round 1
again with no runs from the old round.

A review that times out runs once more with the same arguments. A second
timeout waits for a person with the note `review timed out twice`. Neither an
unavailable reviewer nor a timeout counts toward `maxAutoRework`: only a review
that returns findings at or above `reviewer.fixLevel` does.

### Follow-ups

Findings that did not fail a review are not lost. When a task merges and any
review round of it had such a finding, dev marks the task. When a plan has no
ready, running, review or waiting task, dev collects every such finding of
every round of the plan's marked tasks (oldest first; within one task, a
finding with the same `file:line` and text, whitespace collapsed, is kept once) and proposes one task, `<plan slug>-followups` (then
`-2`, `-3` when the slug is taken), titled `Follow-ups from <plan id>'s
reviews`, that follows the collected tasks. Its brief lists each finding as
`[level] path:line summary (round n)` under a `From T-xxxx` heading per task, and tells
the worker to fix what still applies and say which findings no longer apply.
A task is collected once, even when its follow-up is cancelled; a follow-up's
own findings are never collected; tasks merged before this existed carry no
mark. `reviewer.followups: false` turns it off.

### Grading: `.operad/review.json`

What critical, major and minor mean is a project setting, not text in the
plugin. A repository may keep `.operad/review.json` (schema:
`packages/review-grading/review.schema.json`; the reader is the
`@operad-io/review-grading` package, whose README describes every field):

```json
{ "flows": { "dev": { "levels": { "critical": "…", "major": "…", "minor": "…" },
                      "rules": ["…"], "fixLevel": "major" } },
  "default": { "…": "…" } }
```

The review prompt gets a `## Grading` section with the `dev` flow's levels and
rules, word for word; `dev` adds no grading words of its own, and a repository
with no file gets no section. An entry for the flow falls back field by field
to `default`.

`fixLevel` in `review.json`, when set, wins over `reviewer.fixLevel` in
`dev.json`, for the review and for the rework that follows it. `reviewer.fixLevel`
keeps working when `review.json` sets none. An invalid `review.json` fails the
review step with a message naming `review.json` and what is wrong, as an invalid
`dev.json` does.

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

## Rework rounds

One rule says which review is which:

- The **previous review** is the newest review report of the task, in any
  attempt, for a commit other than the one now reviewed. When there is none, or
  its commit is not in the checkout, the review gets the first-review prompt
  (brief and full diff).
- With a previous review, the prompt is the rework-round prompt: the brief, the
  previous review's blocking findings (level, `file:line`, summary), the commits
  `<previous sha>..<sha>` and the increment, not the full diff. It asks the
  reviewer to say, in `verified`, which previous findings are fixed and which are
  not, to review the increment, and to list every problem it finds. The reviewer
  can still read any file.
- A reverify of an unchanged head finds the newest report is for the same
  commit, skips it and follows the one before it, if any. A reverify after main
  moved is a review of a new commit and follows the newest report.
- Which findings move as pre-existing depends on the review. A **first review**
  keeps only the per-file rule: a finding in a file the task's change does not
  touch is moved (the prompt is the whole diff, and a reviewer can still wander
  into untouched files). A **reverify of the same commit** gets the first
  prompt and moves nothing. A **rework round** applies the line rules below.
  In every review a critical finding, and one without a file or a line, stays.

The **increment** is built like `git range-diff`: take the task's own diff at the
previous review (the merge base recorded then, or the merge base of the remote
main and the previous commit, to the previous commit) and the task's own diff
now. A hunk of the current diff is in the increment when its `-`/`+` lines,
ignoring line numbers and context, are not in the previous diff of that file. A
hunk of the previous diff that is gone or changed is listed as "Removed since the
previous review" with its old content. Both sides are the task's own diff, so a
line that only came with a merge of main is on neither side.

In a rework round, dev, not the model, moves a failing finding out of the failing set and marks it
`pre_existing` unless (a) its `file:line` is within 3 lines of a line the task's
own change added or changed in that file, (b) it is in the same file as and
within 10 lines of a blocking finding of the previous review, (c) its level is `critical`, or (d) it has no file or no line. A
moved finding keeps its level, and a `pre_existing` mark the reviewer wrote is
ignored. The grading in `.operad/review.json` applies first. The review's data
records `moved`, and history and Changes say "rework round: n previous findings,
m fixed, k moved as pre-existing"; a previous finding counts as fixed when no
blocking finding of this review is in the same file within 10 lines of it. A
review that crashed before its model answered asks again with the prompt it
recorded.

## Review diff size

Before building the review prompt, the step leaves out files marked
`linguist-vendored`, `linguist-generated`, `-diff` or `binary` in
`.gitattributes`, and every file whose own diff is over `maxFileDiffBytes`. Each
left-out file is listed with its added/removed line counts and the reason. If
the remaining diff is over `maxDiffBytes`, no reviewer starts and the step fails
with the size and the largest files, so a person sees why.

The diff is built with rename detection, and `maxDiffBytes` and
`maxFileDiffBytes` count what the prompt carries, not the raw change:

- A renamed file with no edit is one line, `renamed <old> → <new>, unchanged`.
  A renamed file with edits carries only the edits.
- A deleted file is one line, `<path>: deleted, <n> lines`, with the command that
  reads it (`git show <base>:<path>`); its removed lines are not in the prompt.

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
| `concurrency` | none | a cap on running tasks, applied to the sum of the `default` pool's counts; with the old `worker` form it is the one worker's `count` (default `1`); each plan also has its own limit |
| `workers`, `pools` | none | the repository's workers and pools; fields are in the manual ("`dev.json`: workers and pools"). Not allowed together with `worker` |
| `worker.use` | `harness-radian/agent` | the harness step that works a task; the old single-worker form, one worker named after its harness |
| `worker.args` | `[]` | extra arguments for that harness step |
| `worker.wallTimeSecs`, `worker.stallSecs` | harness defaults | the worker's time limits |
| `work.wrapUpAt` | `0.85` | the share (above 0, below 1) of a work step's time limit at which the worker is asked, through its harness, to stop starting new things, commit and write a progress note (`.operad-progress.md` in the worktree, never committed). The limit is the wall time of the run the harness reports when it starts (the worker's `wallTimeSecs`, or the harness's own default), counted from when the pool gave the worker its place. The harnesses that take a message mid-run (`harness-claude`, `harness-pi`) pass it on; the others get nothing. A step that runs out of time anyway is stopped a little before that limit (a harness that reports none is stopped by the step's own three hours), what is in the worktree is committed (`work in progress: the work step ran out of time`), and the task waits with the reason `work timed out`. The note and the commits are in the step's history, and the next attempt's prompt starts with them |
| `workerBrief` | `.operad/worker-brief.md` | the brief a worker reads first; a missing file means the built-in text |
| `prepare` | `[]` | shell lines run in every checkout dev makes (the worker's worktree, the gate checkout verify and review use, the integration checkout) after it is created or moved to a new commit and before a step uses it, e.g. `bun install --frozen-lockfile`. Output goes to the step's log; a failing line fails the step with reason `prepare failed` and the log path. The review prompt says the checkout is prepared. When `prepare` is empty, the gate and integration checkouts of a workspace repository link each workspace package into their own `node_modules`, so a change spanning packages resolves its own code instead of the main clone's |
| `gate.commands` | `[]` | the commands the verify step runs on the task commit. A command is a string, or `{ "run": "…", "failed": { "match": "<regex, one capture group: the failed test's name>", "rerun": "<command with {name} (shell-quoted name) or {pattern} (shell-quoted anchored regex, \" > \" turned into a space as `bun test -t` matches)>", "max": 10 } }`: when `run` exits non-zero, the names found in its log are run again one by one (each taking a check place); the check passes when every rerun passes. No name, more than `max`, or a failing rerun fails it as before; a timeout is never rerun; `check.rerun` is not used for that command. The task's Changes say `passed on rerun: <test names>`, the check log holds each rerun under a heading, and `operad reruns` lists how often each test passed on a rerun, most frequent first |
| `gate.commandTimeoutSecs` | `1800` | the longest one gate command may run |
| `check.rerun` | `1` | how many times a failed gate or integration check runs again before it counts as failed; `0` turns it off; a timeout is never rerun. A pass on the rerun is a pass, noted in the task's Changes and the check log holds both runs |
| `check.flakyTask` | `2` | how many times one test may pass only on its rerun in this repository before dev proposes a task `flaky-<test>` (title "Fix the flaky test: <test>") in the flaky-test plan (see `check.flakyPlan`), with the test, the count, the tasks and times, the last two failures and the stress command in its brief; `0` turns it off. The test's file is the one whose section of the check log holds the test's own `(fail)` line, never the summary bun prints again after the last file; when the log does not give it, dev searches the repository's test files for the test's name and, if that does not find exactly one file, the brief says the file is unknown. The task's area is the package that file is in (`packages/<name>/...` gives `<name>`; `tests` when the file is unknown). The brief's stress command has `--runs <N>`; N follows the sizing rule from the repository's CLAUDE.md quoted below it. One task per test until it is merged or cancelled, then the count restarts at 0. `operad reruns` shows the task beside its test |
| `check.flakyPlan` | unset | the id of the plan the flaky-test tasks are proposed in. When it is unset, or that plan is finished or cancelled, dev makes a plan `flaky-tests` (title "Flaky tests") once, confirmed, with the auto level and priority of the repository's newest confirmed plan (`off` and `P3` with none), and uses it until it is finished or cancelled |
| `reviewer.use` | `harness-radian/agent` | the harness step that reviews the diff |
| `reviewer.args` | `[]` | the arguments every review gets |
| `reviewer.firstArgs` | none | the arguments the first review of an attempt gets instead, including its one retry after an invalid report |
| `reviewer.first.use`, `reviewer.first.args`, `reviewer.first.timeoutSecs`, `reviewer.first.stallSecs` | none | the settings of a task's first review (no earlier review of the task). Each value set there replaces the reviewer's own for that review only; every later review (a rework round, or a review of the same commit as an earlier one) uses the reviewer's own values, so a rework round, which reads only the increment and the previous findings, can run a cheaper model under a shorter limit. With no `first` block every review uses the reviewer's values, as before. Each review report (and the review step's data) records `reviewSettings`: the round (`first` or `rework`) and the values that ran, with where each came from (`first`, `firstArgs`, `fallback` for the harness and arguments of a fallback review, or `default`) |
| `reviewer.fallback.use` | none | the harness step that reviews when the primary reviewer is unavailable |
| `reviewer.fallback.args` | `[]` | the arguments every fallback review gets |
| `reviewer.timeoutSecs` | `600` | the longest a review may run |
| `reviewer.stallSecs` | harness default | how long a review may print no new line before it is stopped |
| `reviewer.fixLevel` | `major` | the lowest finding severity that fails the gate: `critical`, `major` or `minor` |
| `reviewer.followups` | `true` | whether findings that did not fail a review (below `fixLevel`, or moved as pre-existing) are collected into a follow-up task |
| `reviewer.retrySecs` | `120` | how long an unavailable review waits first; each further wait doubles, up to 30 minutes |
| `reviewer.maxFileDiffBytes` | `200000` | the largest diff one file may put in the review prompt |
| `reviewer.maxDiffBytes` | `1000000` | the largest diff the review prompt may carry; counts the prompt's text, where a rename or a deleted file is one line |
| `autoDefault` | `"off"` | the auto level a new plan starts at: `off`, `run` or `merge` |
| `maxAutoRework` | `2` | how many automatic reworks in a row are allowed before waiting for a person |
| `integration.style` | `merge` | `merge` lands a merge commit with `Merge work/<task id> (<short sha>)`; `squash` lands one squashed commit |
| `integration.batch` | `1` | the most tasks one integration merges together; `1` or unset means one at a time. Above 1, when more than one task is queued as a turn starts, integrate merges the queued verified commits onto main in queue order into one candidate, runs `integration.keyCommands` once and pushes once; each task keeps its own merge commit (`Merge work/<id> (<sha>)`), so history and revert stay per task. A merge conflict between them, or failing key commands, falls back to integrating them one by one in queue order, so a bad task is sent back to its worker alone and the others land. Each task's history says `integrated in a batch with <tasks>` |
| `integration.keyCommands` | `[]` | commands (strings or `{ run, failed }` as in `gate.commands`) the integrate step runs on the candidate before the push; a failure sends the task back to the worker |
| `hooks.afterMerge` | removes both worktrees and both branches | commands cleanup runs after a merge, in the repository root, with `OPERAD_TASK`, `OPERAD_WORKTREE` and `OPERAD_REMOTE` set |

### Check places

The checks of verify and integrate share a limit per operad home, not per
repository: tasks of different plans and repositories run on one machine. The
limit is `checks` in the `dev` section of the home's `config.json` (default
`2`); it is there and not in `dev.json` because `dev.json` belongs to one
repository. A check takes a place before it runs. When none is free, the step
log says `waiting for a check place: 2 in use` and the check waits without a
time limit; its `gate.commandTimeoutSecs` starts when it runs. Places are lock
files under `<home>/dev/check-places/`, so a check whose process dies gives its
place back. A rerun of a failed check takes a place again.

A repository can also limit itself: `gate.places` in its `dev.json` (an integer
of 1 or more, unset by default) is the most checks of that repository that run
at once. It is for checks that cannot share a machine, such as full UI test
runs on a simulator, so that they do not hold back the checks of other
repositories. A check takes a place of the home and a place of its repository,
waits without a time limit until both are free, and says which it waits for:
`waiting for a check place of operad-ios: 1 in use`. It takes them in one order
(home, then repository) and gives the home place back while it waits for the
repository's, so two checks cannot wait for each other. The repository's places
are lock files in the same directory, so a dead check gives both back.

One integration of a repository runs at a time. A task whose wait was answered
with `merge` joins the repository's integration queue, in the order the merges
were chosen, and the integrate step waits for its turn without a time limit. It
says so in the step log and in `operad running`:
`waiting to integrate: T-0025 is integrating`. Waiting is not a check and holds
no check place. The queue is a set of ticket files under
`<home>/dev/integration-queue/`; a task whose process dies loses its ticket, so
its turn goes to the next however it ended (merged, conflict, fail, cancelled).
The task that has the turn builds its candidate on the main the previous one
pushed, so a full key-command run is not thrown away because another task
pushed first.

The built-in brief says to work only in the worktree, commit whole pieces, run
the repository's verify command and end with a summary.

A `dev.json` written by an earlier version still loads: `worktrees` is read as
`worktreeRoot`, and `sandbox` is ignored. A `worktreeRoot` that is absolute,
climbs out of the repository, or resolves outside it through a symlink is
refused when the file is read and again before a worktree is created.

## Settings from a client

`operad settings` lists what a person may tune and `operad settings set <name>
<value>` changes it (add `--repo <name>` for a repository's files). The home's
`checks` is `dev.checks`. A repository's `.operad/dev.json` is `dev.dev.*`
(`autoDefault`, `concurrency`, `gate.commands`, `gate.commandTimeoutSecs`, `reviewer.use`,
`reviewer.args`, `reviewer.timeoutSecs`, `reviewer.fixLevel`) and its
`.operad/review.json` is `dev.review.default.*` (`levels`, `rules`,
`fixLevel`). Changing what merges (`autoDefault`, `fixLevel`, the levels and rules)
asks for `--yes`, because it changes what merges. Other settings can be read
there but are changed in the file.

## Views

A plan shows a request and a table of its tasks. A task shows its brief, its
rework sections when it has some, and its changes.

The Changes section is the task's story in a few lines, readable without the
history. Each entry shows the time it happened (`HH:MM`, the serve host's local
time) and, where there is one, why, in one line of about 160 characters; a date
line starts each new day:

```
2026-11-08

21:05  rework 1 — review: packages/dev/src/gate.ts:1059 major: The review-report setup follows …
21:31  merged origin/main 83163e5 into the branch (clean)
21:40  merged as 0bce8fa
```

A rework says who asked (review, verify, integrate, conflict, lead, owner) and
the first finding or failing check line. A reverify, reject, cancel or lead or
owner action carries its note when it has one, a wait says what it waits for,
and a merge names the commit. The time and the reason are stored with the entry
when the event happens (in the task's brief); an entry written before that has
no time and is shown as it was.

The Metrics section is narrow enough for a phone. A table has one row per
attempt (number, wall time from its first step to its last, cost, how it ended:
`merged`, `review: n findings`, `verify failed`, `conflict`, `cancelled`,
`running <step>`) and a total row that sums time and cost over all attempts.
Under it, one line per attempt, newest first, gives the per-step times and the
tokens (in k with one decimal from 10k); steps that did not run are left out. What is running comes from the task's run itself, the step and start time `operad running` reports; when the run is not active (it waits for a person, has ended, or the task was cancelled) nothing is shown as running, whatever the task's phase says. Finished steps and how an attempt ended come only from recorded results:

```
| # | time | cost | result |
|---|------|------|--------|
| 1 | 45m | $1.24 | review: 2 findings |
| 2 | 3m … | – | running work |
| total | 48m | $1.24 | |

**#2** worktree 2s · work 3m00s (running)

**#1** worktree 2s · work 22m10s · verify 4m35s · review 18m00s · 100 in / 35.9k out tokens
```
