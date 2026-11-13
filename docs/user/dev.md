---
description: dev.json and the dev plugin: its commands, the reviewer, workers and pools, usage and end results.
---

# dev.json and the dev plugin

The `dev` plugin runs plans and tasks on a repository. Its project settings are in `.operad/dev.json`; its commands and what they do are in the sections below. A complete workflow is in [Running operad on operad](../dogfood.md); the settings a client may change are in [config.json](config.md#settings-from-a-client).

## Reverify and an attempt that adds no commit

`dev:reverify` merges the current main into the task branch first, then runs verify and review again with no worker. A clean merge goes straight to verify; a conflicting main sends the task to the worker.

When the worker adds no commit, the task waits with `work did nothing` if the branch has nothing beyond main or its latest commit already passed verify. If the branch already holds commits not on main and its latest commit has not passed verify (an earlier run stopped before verify ended), the task does not wait: history says `the branch already has unchecked work; checking it` and the task goes on to verify.

## Where `dev` commands run

A `dev` command takes its repository from the directory, from `--repo <name>`
or from a qualified id such as `operad/T-0045-shell-hang-guards`; a bare id
outside a repository works when only one repository has it. The rules are in
[packages/dev/README.md](../../packages/dev/README.md#where-a-command-runs-and-ids).

## Where the reviewer writes its report

The reviewer runs in the task's gate worktree, and some agents (radian, for one)
cannot write outside the folder they run in. So each reviewer call is told to
write its report to `.operad/review/<run>-attempt-<n>-review-<round>-try-<k>.json`
inside that worktree, a path that is new for every call (`k` counts the calls
before it in the round). `dev` reads the report there, checks it, and keeps its
own copy in the store under `dev/reviews/<run>/`; that copy is the record.
`dev` never deletes, truncates or overwrites a file in the review workspace: it
creates `.operad/review` when missing, and refuses to write through a link or
over an existing file, failing the review with the path instead. The gate
worktree is disposable and is replaced by the next gate step, which removes the
reports with it. A reviewer that finishes without writing a report is shown as
`could not write the report` with its last message; a file that fails the check
is shown as `wrote an invalid report`.

## Limiting runs of one model

A provider may answer HTTP 429 when several runs use one model at once. The
`radian`, `pi` and `claude` plugins can limit that. Set `concurrency` in
the plugin's `settings`:

```json
{
  "plugins": {
    "pi": {
      "module": "@operad-io/harness-pi",
      "settings": { "concurrency": { "opencode-go/deepseek-v4.1-flash": 2 } }
    }
  }
}
```

| Setting | Type | Default | What it does |
|---|---|---|---|
| `concurrency` | object, model name to integer | `{}` | How many agent runs of that model may go at once in this home, across all runs. Each count must be an integer of 1 or more; `0`, a string or a fraction refuses the plugin when `config.json` loads, and the log names `settings.concurrency`. A model that is not listed has no limit. |

The count covers every agent run in the home, including the ones `dev` starts.
A change takes effect with the next agent step that starts; steps already going
keep their place.

The limit is on a key, and the plugin builds it from the step's `args`:

| Plugin | Key | Where the model comes from |
|---|---|---|
| `pi` | `pi:<model>` | the `--model` argument, else the plugin's `model` setting; with neither, the step is not limited |
| `claude` | `claude:<model>` | the `--model` argument, else the plugin's `model` setting; with neither, the step is not limited |
| `radian` | `radian:<provider>/<model>` | the `--provider` and `--model` arguments only (the model alone when there is no `--provider`); radian has no `model` setting, and a step without `--model` is not limited |

The model is read from the step's own `args`, in either `--model value` or
`--model=value` form; when a flag is repeated the last one counts. A model that
only a flow's `args` names is not seen.

A step over the limit waits in line, first come first served, and
`operad running` prints one line per run: the object id (the run id when there is none), the step, the step time, the title and a trailing `run <age>`, for example
`operad/T-0048-type-filters  review  3m 10s  Object type filters  run 4h 09m`.
It (and `GET /v1/running`) shows the step as
`<step> queued (<key>, <n> ahead)`, where `<n>` is how many waiting steps are in
front of it. `operad history` shows `<step> is queued`. If the step is stopped
while it waits (the run is cancelled), it leaves the line, never runs, and ends
as failed with the reason that it was cancelled.

### Long commands under claude

`claude` runs each step as one foreground turn. Nothing moves to the
background, and the tools that only wait for background work are off, so a long
command such as the gate runs to its end inside the turn. The setting
`bashTimeoutSecs` (integer, 1 or more, default `1800`) is the longest one Bash
call may run, in seconds. If claude nevertheless starts a second session after it
gave its result, the step ends `failed` with a message that says so.

### Long commands under pi

`pi` gives each call of pi's bash tool a time limit, so a command that
never ends (a read from a FIFO nobody writes to) cannot hold a run until its
wall time. The setting `bashTimeoutSecs` (integer, 1 or more, default `1800`) is
the longest one bash call may run, in seconds. It is both the default and the
maximum: a call the model gives no timeout runs under it, and a timeout the model
asks for above it is brought down to it. When a call reaches the limit, pi stops
the command and its children and the model gets an error that says the command
timed out; the run goes on, so the model can try something else. A value that is
not an integer of 1 or more (0, a negative number, a string) is refused when the
plugin loads, with the field path. The setting is read when a step starts, so a
change takes effect with the next agent step.

The default is 1800 s (30 minutes), the same as `claude`, because a gate
such as `bash scripts/verify.sh` (install, type-check and the whole test suite)
runs in the foreground inside one call and must not be cut short. A project whose
gate is faster can set a lower value to catch a stuck command sooner.

`stallSecs` is unchanged: it measures silence while no tool call is open, and an
open tool call is not a stall (see the README of `pi`). The time limit
above is what bounds a single tool call.

### The agent's shell and the user's aliases

An alias or function from the user's own shell setup, such as `ls` defined as
`eza --git --hyperlink`, must not change what a command in an agent run does.

- `pi`: pi runs each command as `bash -c` (a non-interactive shell with
  no rc files, so no aliases or functions). The worker also removes `BASH_ENV`
  and `ENV` from its environment, the two variables that make a non-interactive
  shell read a file.
- `radian`: radian runs `/bin/sh -c`, which reads no user setup.
- `claude`: claude's Bash tool sources a snapshot of the user's
  `~/.zshrc` or `~/.bashrc` before each command, and claude has no
  supported switch (environment variable or setting) that turns the snapshot
  off. `CLAUDE_CODE_SHELL` only picks which of zsh and bash is used; the
  snapshot is read from the home directory. operad does not work around this: a
  user whose rc file defines an alias that hangs (or changes the output of) a
  common command should guard it there, for example `[[ -o interactive ]]`
  around the alias, or define it only in a file that agents do not read. The
  `bashTimeoutSecs` limit above still stops a hung command after its time.

## Sharing agents between flows: the `pool` plugin

Agent runs cost an account, not a repository: one Claude or Codex login serves
every repository on the machine. The `pool` plugin has one step, `pool/agent`,
that picks a worker with room, runs that worker's harness step and hands the
result back. A flow that uses it (the `dev` flow does) describes its workers;
the home says how many runs one harness may have in all.

The plugin is shipped but not installed by `operad init`; `operad plugin enable
pool` adds it.

### Home: `settings.harnesses`

```json
{
  "plugins": {
    "pool": {
      "module": "@operad-io/pool",
      "settings": { "harnesses": { "pi": 2, "claude": 1 } }
    }
  }
}
```

| Setting | Type | Default | What it does |
|---|---|---|---|
| `harnesses` | object, harness plugin name to integer | `{}` | How many runs through `pool/agent` may go at once in this home for that harness, across all repositories and flows. A run of `claude/agent` counts under `claude`. Each count must be an integer of 1 or more; `0`, a string or a fraction refuses the plugin when `config.json` loads, and the log names `settings.harnesses`. A harness that is not listed has no cap. |

A change takes effect with the next `pool/agent` step that starts; steps already
going keep their place. Only runs that go through `pool/agent` count: a flow
that calls a harness step directly does not, and the per-model `concurrency`
limit of the harness still applies to every run.

### A flow: `workers` and `pools`

A flow's settings, at every level it can be set, may define workers and group
them into pools. These are the fields; the parser behind them is shared, so
every flow refuses the same mistakes in the same words.

| Field | Type | Default | What it does |
|---|---|---|---|
| `workers` | object, worker name to worker | required | The ways this flow can run an agent. At least one worker. |
| `pools` | object, pool name to list of worker names | one pool named `default` with every worker in the order written | Groups of workers a step picks from. Each list is non-empty and names only workers of `workers`. |

A worker has these fields; any other field is refused.

| Field | Type | Default | What it does |
|---|---|---|---|
| `use` | string | required | The harness step to run, as `<plugin>/<step>`, such as `claude/agent`. |
| `args` | array of strings | `[]` | The arguments given to that step, such as `["--model", "sonnet"]`. |
| `count` | integer, 1 or more | `1` | How many runs of this worker may go at once for this flow. |
| `wallTimeSecs` | number, above 0 | unset | The wall-time limit passed to the harness step. |
| `stallSecs` | number, above 0 | unset | The stall limit passed to the harness step. |
| `fallback` | string | unset | Another worker of `workers` to run once when this worker's model is unavailable. |

Two workers may use the same harness with different arguments (`pi-flash` and
`pi-pro`); together they count against that harness's home cap.

Each refusal names the path of the bad value, for example
`workers.claude.fallback`:

- `workers` or `pools` is not an object, `workers` is empty, `pools` is empty.
- A worker is not an object, has a field not in the table, a `use` that is not
  `<plugin>/<step>`, `args` that is not a list of strings, a `count` that is not
  an integer of 1 or more, or a `wallTimeSecs` or `stallSecs` that is not above 0.
- A pool is not a non-empty list, or names a worker that `workers` does not have
  (`pools.default[1]`).
- A `fallback` names an unknown worker, the worker itself, a worker that has a
  `fallback` of its own (a chain is one step; two workers that name each other
  are a cycle), or is not a string.

### The step `pool/agent`

Its params are `prompt`, `cwd`, `prefix` (the key for the flow's counts; the
caller passes `<repository>/<pool>`), `workers` (the pool's definitions in
order, each with its `name`), optionally `fallbacks` (workers outside the pool
that a member's `fallback` names) and `worker` (a worker the caller requires,
such as the one that did the first attempt), plus anything the harness step takes.

1. It picks the first worker in order whose own count under `prefix` has room
   and whose harness has room under `settings.harnesses`. With `worker` set only
   that worker may run; a name not in `workers` ends the step `failed` with
   `data.reason` `unknown_worker`.
2. When none has room it waits, without an error, until a run ends. It sends
   the event `pool.waiting` once for each reason: `data.full` is `flow` when the
   flow's counts are full and `home` when a harness's home cap is full. A
   stopped step leaves the line and ends `interrupted`.
3. It runs the worker's `use` with the params, the worker's `args`,
   `wallTimeSecs` and `stallSecs`, and returns the result unchanged, adding to
   `data`: `worker`, `harness` and, after a fallback, `fallbackFrom` (the worker
   that failed).
4. When the result's `data.modelError.kind` is `unavailable` or `usage_limit`,
   or the harness step cannot start (it threw, or it ended `failed` with
   `data.reason` `missing` or `spawn`), and the worker has a `fallback`, it runs
   that worker once, after giving back the first worker's places and waiting for
   the fallback's own room. A timeout (wall time or stall) never falls back, and
   the fallback's own failure is returned as it is.

Where the counts live: every step runs in its own worker thread, so the places
are kept in one file under the home, `pool/places.json`, changed under a lock
file. Steps in any thread or process of the home see the same counts. A place
records the process that holds it; when that process is gone (a crashed serve)
the place is dropped the next time a `pool/agent` step looks.

## `dev.json`: workers and pools

The `dev` plugin's work step runs every task through `pool/agent`, so `dev`
needs the `pool` plugin enabled (`operad plugin enable pool`). The repository
chooses its workers in `<repository>/.operad/dev.json`; `dev` reads that file in
the registered repository's main clone, never the copy in a task's worktree,
which carries whatever the task's branch had when it started.

| Field | Type | What it does |
|---|---|---|
| `workers` | object | The repository's workers. Same fields as in [A flow: `workers` and `pools`](#a-flow-workers-and-pools); that table is the one place the worker fields, defaults and refusals are listed. |
| `pools` | object | Pool groups. `dev` uses the pool named `default`, so a `pools` setting must define it. Without `pools`, `default` holds every worker in the order written. |
| `concurrency` | integer, 1 or more | An extra cap on running tasks; see below. |

```json
{
  "workers": {
    "claude": { "use": "claude/agent", "args": ["--model", "sonnet"], "fallback": "pi" },
    "pi": { "use": "pi/agent", "args": ["--model", "opencode-go/deepseek-v4.1-flash"] }
  },
  "pools": { "default": ["claude", "pi"] }
}
```

Errors in `workers` and `pools` name the field path, such as
`workers.claude.fallback` or `pools.default[1]`.

**The old `worker` form.** `worker` (`use`, `args`, `wallTimeSecs`,
`stallSecs`) still works and means one worker named after its harness plugin
(`radian` for `radian/agent`), with `count` equal to
`concurrency`, alone in the pool `default`. Its runs count under the home cap of
its harness like any worker's. A file that has both `worker` and `workers`, or
`pools` without `workers`, is refused when it is read.

**How many tasks run at once.** A repository runs at most as many tasks as the
sum of the `count` of the workers in its `default` pool. When the file sets
`concurrency` it caps that sum further and never raises it. A plan's own
`concurrency` still applies on top of this. A task past the cap waits for a
free place; one past a worker's own `count` or the home cap waits in
`pool/agent`.

**Which worker.** The work step passes the `default` pool and the key
`<repository>/default` to `pool/agent`. The attempt records the `worker` that
ran (after a fallback, the fallback worker, with `fallbackFrom` naming the one
that failed), and the work result says `work: claude` or
`work: pi (fallback from claude)`. After a rework or a reject, the next work
attempt asks for the worker of the attempt before, so it resumes that worker's
session when the harness can. If that worker is busy the work waits for it;
another worker does not take it. If the worker is no longer in the `default`
pool the pool picks any worker with room and the result says
`work: pi; claude is no longer in the pool`.

### One integration at a time

Tasks of one repository integrate one at a time, in the order their merges were
chosen. A task that waits for its turn shows `waiting to integrate: T-0025 is
integrating` in `operad running` and in its step log; it holds no check place and
waits without a time limit. A turn is given back when the integration ends in
any way, including when its process dies.

`integration.batch` in `dev.json` (default `1`, one at a time) lets a turn merge
the tasks queued behind it: up to that many verified commits go onto main in
queue order as one candidate, the key commands run once, and one push lands
them. Each task keeps its own merge commit and its history says `integrated in a
batch with <tasks>`. A conflict between them or a failing key command falls back
to one by one, so only the task at fault goes back to its worker.

### When `dev.json` is not valid

A repository's `dev.json` is read again by every step and every scheduler pass.
When the file stops being valid (a typo, or a shape the running `serve` does
not know yet, such as after a merge changed what `dev.json` may hold):

- The last valid settings of that repository stay in force. Running steps finish
  with them, the next step of a run reads them too, and the scheduler keeps
  starting and repairing tasks in that repository. A `serve` or a step that
  starts while the file is invalid reads the copy of the last valid settings
  kept in `$OPERAD_HOME/dev/settings/`. Another repository is not affected.
- `serve` writes one line to its log, `dev: repository "<name>": <reason>`, each
  time the file changes to a different invalid state, never once per pass.
- `operad pending` and `GET /v1/pending` show one item for the repository (its id
  is `dev:settings:<name>`, it has no actions): `the repository settings are not
  valid: <reason>; the last valid settings are in use`. The item disappears when
  the file is valid again, and the next breakage is logged again.
- A repository that never had valid settings has nothing to fall back on: the
  item says so and no task starts in it until the file is fixed. Its running
  steps are not touched either.

### When a merge changes the code `serve` runs

The main clone follows a merge when it can (a fast-forward on a clean clone), but
a `serve` that is already running keeps the code it loaded until it reloads
(see Changed code).
When a followed merge changes that code, which means any file under the directory of the kernel (`engine`, `cli`) or
of a package the home loads (source, flows, `bin/`, schemas at any depth,
manifests), `operad pending` shows
`serve runs older code than main: restart it when no check runs (merged <commit>
in <repository>)`, once however many merges followed. Markdown files (docs and the
mutation records), `test/` and `fixtures/` do not count. The item is advice: it
may appear for a change that did not need a restart, but a change to a loaded
package's code or schema always raises it. `serve` restarts itself when the new
code loads and the item goes away with the restart; when the new code does not
load, `serve` keeps the old code and the item stays until the files are fixed.

`dev` also needs the plugins its steps run through. When the home does not load
`pool`, `operad pending` shows `plugin pool is not loaded and dev runs its
workers through it: run `operad plugin enable pool` and restart serve; until
then no new work starts`, and ready tasks stay ready instead of failing. The
item goes away once `pool` is loaded.

### What the views say about the worker

- `operad list task` and the first lines of `operad show` end the row's note
  with the worker of the task's last attempt, name only. A name longer than 16
  characters is cut with `…`; Metrics has the whole name.
- `operad history` has the work line above: `work: claude` or
  `work: pi (fallback from claude)`.
- The task's Metrics section adds a table under the attempts, one row per
  worker, summed over the attempts that worker ran: attempts, cost, time and
  first pass (attempts whose first review round passed, out of the attempts
  reviewed).
- A task from before pools has no worker: the row shows none and Metrics has no
  worker table. `dev` has no repository-level metrics, so there is nothing to
  split there.

```
$ operad list task
T-0044-views   Worker views   running   $0.35  pi
$ operad section T-0044-views metrics
| worker | attempts | cost | time | first pass |
| --- | --- | --- | --- | --- |
| claude | 2 | $0.30 | 4m10s | 1/2 |
| pi | 1 | $0.05 | 1m02s | 0/1 |
```

## Usage and end results

Every agent step records what the run used in one field of its data, `usage`,
and ends with one of a fixed list of results. Cost, metrics and budgets read
this one form, whichever harness ran.

`usage` has these fields:

| Field | Type | Meaning |
|---|---|---|
| `harness` | string | The harness plugin that ran, such as `pi`. |
| `model` | string or `null` | The model as `provider/id` when the step named it; `null` when it did not. |
| `tokens.input` | integer, 0 or more | Input tokens. |
| `tokens.output` | integer, 0 or more | Output tokens. |
| `tokens.cacheread` | integer, 0 or more | Tokens read from the provider's cache. |
| `tokens.cachewrite` | integer, 0 or more | Tokens written to the provider's cache. |
| `costMicros` | integer, 0 or more, or `null` | The cost in millionths of a dollar. `null` means the cost is unknown; `0` means the run was free. |
| `costQuality` | `exact`, `estimated`, `incomplete` or `null` | How far to trust `costMicros`. `exact` is the price the provider billed; `estimated` was worked out from a price list; `incomplete` priced only part of the run (some message had no price), so the real cost is higher. `null` exactly when `costMicros` is `null`. |

A count the harness does not report is `0`. Records written before this field
existed keep their old fields (`usage` with `input`, `output`, `cache_read` and
`cache_write`, and `cost` with `micros`, `incomplete` and `estimated`); they are
still read, and nothing writes them any more. A `usage` that is not in the
standard shape is ignored and the run's log gets one line naming the run and the
field.

`dev` shows a cost's quality as a symbol in a task's row and in its metrics:
`$0.31` is exact, `~$0.31` is estimated and `≥$0.31` is incomplete (at least
that much).

A plan's row note reads `1/8 · ~$4.20 · P2 // 2`: merged tasks over tasks
(cancelled ones are not counted), the total cost of the plan's tasks at the
weakest quality among them (left out while no task has a cost), the priority,
and after `//` how many of the plan's tasks may run at once. The plan's badge
carries its auto level. A task's note reads `$0.31 · claude · area: app-core`: the cost
(`$0.00` before there is one), the worker, the area (or `waiting for area
app-core (T-0023-action-numbers)`), and last a refused push's message. A
repository's note reads `plans: 1 · tasks: 4`, counting open ones.

A step ends with one of these results:

| Result | Meaning |
|---|---|
| `done` | The work finished. |
| `nothing` | There was nothing to do. |
| `failed` | The step could not do its work. |
| `needs_decision` | The step needs a person to choose. |
| `waiting` | The step stopped to wait, and will continue. |
| `interrupted` | The step was stopped before it finished. |

The end results apply to plugins of the `harness` kind: they run an agent, and
a flow reads any agent the same way. `operad plugin check` refuses a harness
step that declares another name and names it. The agent steps of
`radian`, `pi` and `claude` declare `done`, `failed` and `interrupted`.
Plugins of other kinds name their own results. `shell` is a `stage`, not a
harness: its steps run a command or a check and give a verdict, so they end in
`pass` and `fail` (and `ready` or `waiting` for a check), and the end results
do not apply to them.
