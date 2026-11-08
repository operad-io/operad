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
operad plan add --slug <slug> --title <title> [--concurrency <n>] [--repo <name>]   # request on stdin
operad task add --plan <plan> --slug <slug> --title <title> [--after <task>]... [--area <area>] [--repo <name>]   # brief on stdin
operad task edit <id>      # $EDITOR on the brief body; proposed or ready only
operad task update <id> [--title <title>] [--after <task>]... [--area <area>]   # --area "" clears it
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

## Steps

| step | results | what it does |
|---|---|---|
| `dev/worktree` | `ready`, `conflict`, `blocked`, `failed` | fetches, creates `worktreeRoot/<task id>` on `work/<task id>` from `<remote>/<mainBranch>`, and on a later attempt reuses it after merging the latest main; a start that carries a `blockedBy` dependency records the person wait instead |
| `dev/reverify` | `ready`, `conflict`, `failed` | the first step of a reverify: fetches and merges the current main into the task branch in the existing worktree, keeping the attempt; `ready` goes to verify, `conflict` to the worker |
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
`merge`, `reject` or `reverify` (the last merges the current main into the branch, then runs verify and
review again on it with no worker). A task whose dependency was cancelled enters the same
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

A review is a **rework round** when the task has an earlier review report for a
different commit; the newest report is the previous review. A review of the same
commit as the previous one (a reverify of an unchanged head) is a first review,
and so is a review whose previous commit is not in the checkout.

A rework round's prompt holds the brief, the previous review's blocking findings
(level, `file:line`, summary), the commits `<previous sha>..<sha>` and the
increment, not the full diff. It asks the reviewer to say, in `verified`, which
previous findings are fixed and which are not, to review the increment, and to
list every problem it finds. The reviewer can still read any file.

The increment is the new-side lines of `git diff <previous sha> <sha>` that are
also new-side lines of the task's own diff (merge base of main and the head, to
the head), so lines that came only with a merge of main drop out. The increment
diff is the task's own diff restricted to the hunks that hold an increment line.

In every round, dev, not the model, moves a failing finding out of the failing
set and marks it `pre_existing` unless (a) its `file:line` is within 3 lines of
a line the task's own change added or changed in that file, (b) it is in the same
file as and within 10 lines of a blocking finding of the previous review, (c) its
level is `critical`, or (d) it has no file or no line. A moved finding keeps its
level, and a `pre_existing` mark the reviewer wrote is ignored. The grading in
`.operad/review.json` applies first. The review's data records `moved`, and
history and Changes say "rework round: n previous findings, m fixed, k moved as
pre-existing"; a previous finding counts as fixed when no blocking finding of
this review is in the same file within 10 lines of it. A rework round that
crashed before its model answered asks again with the prompt it recorded.

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
| `workerBrief` | `.operad/worker-brief.md` | the brief a worker reads first; a missing file means the built-in text |
| `gate.commands` | `[]` | the commands the verify step runs on the task commit. A command is a string, or `{ "run": "…", "failed": { "match": "<regex, one capture group: the failed test's name>", "rerun": "<command with {name} (shell-quoted name) or {pattern} (shell-quoted anchored regex, \" > \" turned into a space as `bun test -t` matches)>", "max": 10 } }`: when `run` exits non-zero, the names found in its log are run again one by one (each taking a check place); the check passes when every rerun passes. No name, more than `max`, or a failing rerun fails it as before; a timeout is never rerun; `check.rerun` is not used for that command. The task's Changes say `passed on rerun: <test names>`, the check log holds each rerun under a heading, and `operad reruns` lists how often each test passed on a rerun, most frequent first |
| `gate.commandTimeoutSecs` | `1800` | the longest one gate command may run |
| `check.rerun` | `1` | how many times a failed gate or integration check runs again before it counts as failed; `0` turns it off; a timeout is never rerun. A pass on the rerun is a pass, noted in the task's Changes and the check log holds both runs |
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
| `reviewer.maxDiffBytes` | `1000000` | the largest diff the review prompt may carry; counts the prompt's text, where a rename or a deleted file is one line |
| `maxAutoRework` | `2` | how many automatic reworks in a row are allowed before waiting for a person |
| `integration.style` | `merge` | `merge` lands a merge commit with `Merge work/<task id> (<short sha>)`; `squash` lands one squashed commit |
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

The built-in brief says to work only in the worktree, commit whole pieces, run
the repository's verify command and end with a summary.

A `dev.json` written by an earlier version still loads: `worktrees` is read as
`worktreeRoot`, and `sandbox` is ignored. A `worktreeRoot` that is absolute,
climbs out of the repository, or resolves outside it through a symlink is
refused when the file is read and again before a worktree is created.

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
