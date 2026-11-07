# Running operad on operad

This is how the owner and a lead run development with operad itself: one home,
one registered repository, a plan, tasks, and a person at the merge.

The examples use this repository and the settings in `.operad/dev.json`.

## One time: create the home and register the repository

```sh
operad init
```

`init` creates `~/.operad` when it is missing and checks the installed plugins.
A failed check says what is wrong and the command exits non-zero; it never
registers a repository and never writes to a remote. In this repository the
checks are:

- `shell` is ready.
- `harness-radian` finds `radian` on `PATH`.
- `dev` finds each registered repository's remote and asks it, read-only, for
  its branches through the remote's name. It passes when the main branch is
  published there and fails when the remote does not exist, cannot be reached
  (with git's own message) or has no main branch. It pushes nothing, so no ref
  can be left behind.

Then register the checkout:

```sh
cd /path/to/operad
operad repo add .
```

`repo add` writes `.operad/dev.json` when the repository has none. This
repository has one committed. It refuses a directory that is not the root of a
git work tree, that has no remote, or that is already registered. A refusal
writes nothing.

`operad repo list` shows what is registered. `operad repo remove <name>` removes
a repository that has no open task.

## Plan and tasks

A plan is one request the owner confirms into work. Its stdin is the request
text.

```sh
operad plan add --slug dogfood --title "Run operad on operad" < request.md
```

That prints the plan id, such as `P-0001-dogfood`. Add a task to it; its stdin is
the task's brief.

```sh
operad task add --plan P-0001-dogfood --slug switch --title "Switch to operad" < task.md
```

A task id looks like `T-0001-switch`. `--after <task>` makes a task wait until
another task is merged. Then confirm the plan:

```sh
operad dev:confirm P-0001-dogfood
```

Confirmation moves the plan's draft tasks to ready. A confirmed plan is what the
loop schedules.

`operad list plan`, `operad list task` and `operad show <id>` show what is
recorded. `operad show <task> --section brief` shows the brief. Add to a task's
brief with `operad task edit <id>`.

## Run it

```sh
operad serve
```

`serve` is the only long-running command. It starts ready tasks (up to the
repository's concurrency), runs each task in its own worktree and process, and
keeps going after an interrupted run: a run whose process died is started again
from its last recorded step. Stop it with Ctrl-C; a run that is already moving
is not killed.

In another terminal:

```sh
operad pending
```

`pending` lists what waits for a person, with the choices and actions it offers.
For a task that passed verify and review, the actions are `dev:merge`,
`dev:reject` and `dev:cancel`.

- `operad dev:merge T-0001-switch --yes` lands the verified commit on main,
  runs the integration checks and cleans the task's worktrees and branches. If
  the remote refuses the push, nothing is written: the task waits for a person
  with a note that names the remote, the branch and git's message.
- `operad dev:reject T-0001-switch --note "explain what to change"` sends the
  task back to its worker with that note.
- `operad dev:cancel T-0001-switch --yes` stops the task.

The action needs `--yes` because it is the person's decision; in a terminal
without `--yes` it asks first.

A plan can run further without a person: `operad dev:auto <plan> --level run`
merges reviewed work after the gate passes, and `--level off` returns to a
person at every merge.

## History and what each step did

```sh
operad history T-0001-switch
```

`history` prints one line per step of every run of the task: what started, what
each step did and why, what a verify or review found, what a person chose, and
how the run ended. `operad history <run id>` narrows it to one run, and
`operad history <id> --json` gives the same lines as JSON. `operad running` lists
runs in progress; `operad flows` lists the loaded flows.

## When the reviewer is unavailable

A review that reports a model error (`unavailable` or `usage_limit`) or an HTTP
429 does not lose the attempt. The same review round runs once on
`reviewer.fallback` when `.operad/dev.json` sets one. Without a fallback, or
when the fallback is unavailable too, the task waits `reviewer.retrySecs`
(default 120 seconds) and then runs the review again; it does not start a worker
and does not count a rework. A review that times out is retried once with the
same arguments; a second timeout waits for a person with the note `review timed
out twice`. `operad history <task>` names the model that reviewed each round and
why a fallback or a retry happened.

## When something is stuck

1. `operad pending` — is it waiting for you? A task that needs a decision stays
   here until merge, reject or cancel.
2. `operad running` — is a run still moving? A run with no live process is
   started again by `serve` on its next pass.
3. `operad show <task>` — read the task's sections, especially `changes` and its
   attempts, to see the phase and the last recorded failure.
4. `operad history <task>` — read the last lines for the step and the reason. A
   verify or review failure names the command, the log file and the finding.
5. If `serve` is not running, start it again with `operad serve`. Do not kill a
   run process: an interrupted run is recovered on the next pass, and a run that
   was not interrupted is left alone.
6. If a check failed, fix what it names and run `operad init` again.
7. A task that keeps failing the same step stops for a person after repeated
   attempts. `operad dev:cancel <task> --yes` stops it; `operad dev:reject`
   sends it back with a note.

Delete nothing by hand under `.operad-worktrees`; `cleanup` removes the task's
worktrees and branches after a merge. If cleanup reports a failure, the task is
still merged; remove the leftover with the command the line names.
