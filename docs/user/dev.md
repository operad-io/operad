---
description: dev.json and the dev plugin: its commands, the reviewer, workers and pools, usage and end results.
---

# dev.json and the dev plugin

The `dev` plugin runs plans and tasks on a repository. Its project settings are in `.operad/dev.json`; its commands and what they do are in the sections below. A complete workflow is in [Running operad on operad](../dogfood.md); the settings a client may change are in [config.json](config.md#settings-from-a-client).

## Every `.operad/dev.json` key

A repository's `dev.json` is JSON; the schema is `packages/dev/dev.schema.json`.
A missing file means the defaults below. The file is read again by every step
and every scheduler pass; when it stops being valid, the last valid settings
stay in force and `operad pending` shows one item for the repository (see
[When `dev.json` is not valid](#when-devjson-is-not-valid)). A wrong value is
refused with the field path in front, such as `workers.claude.fallback: ...`.

### The repository and its workers

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `dev.$schema` | string | absent | `https://operad.io/schemas/dev.schema.json` or another schema URL | Only editors read it | Ignored |
| `dev.name` | string | unset | non-empty text | When the file is read; it is kept with the settings but does not rename a registered repository | Refused: `name: must be a non-empty string` |
| `dev.remote` | string | `"origin"` | a git remote name | When a task branch is fetched, pushed or cleaned up | Refused: `remote: must be a non-empty string` |
| `dev.mainBranch` | string | `"main"` | a branch name | When a task branch starts and merges main | Refused: `mainBranch: must be a non-empty string` |
| `dev.worktreeRoot` | string | `".operad-worktrees"` | a relative path inside the repository | When a worktree is created or read | Refused: `worktreeRoot: must be relative to the repository` or `worktreeRoot: must stay inside the repository` |
| `dev.worktrees` | string | unset | the old name of `worktreeRoot`; read when `worktreeRoot` is absent | When the file is read | Refused with the same two messages, naming `worktrees` |
| `dev.concurrency` | integer | unset: the `default` pool's counts alone set it | `1` or more | On the next scheduler pass; running tasks are not stopped | Refused: `concurrency: must be a positive integer` |
| `dev.sandbox` | string | unset | any string; kept so older files still validate | Never; the value is ignored | Ignored |
| `dev.worker` | object | `{ "use": "radian/agent", "args": [] }` when neither `worker` nor `workers` is written | the keys below; not allowed together with `workers` | When the file is read | Refused: `worker: cannot be set together with workers; use one or the other` |
| `dev.worker.use` | string | `"radian/agent"` | a step name `<plugin>/<step>` | When the worker step starts | Refused: `worker.use: must be a non-empty string` |
| `dev.worker.args` | array of strings | `[]` | arguments for that step | When the worker step starts | Refused: `worker.args: must be an array of strings` |
| `dev.worker.wallTimeSecs` | number | unset | above `0` | When the worker step starts | Refused: `worker.wallTimeSecs: must be a positive number of seconds` |
| `dev.worker.stallSecs` | number | unset | above `0` | When the worker step starts | Refused: `worker.stallSecs: must be a positive number of seconds` |
| `dev.workers` | object | absent: the one `worker` above | worker name to a worker object; at least one | When the file is read | Refused: `workers: must be an object`, `workers: must define at least one worker`, or the worker's own field error |
| `dev.workers.<name>` | object | none | the keys below; `use` is required | When the worker step starts | Refused: `workers.<name>: must be an object` or `workers.<name>: is not a worker field` |
| `dev.workers.<name>.use` | string | required | `<plugin>/<step>`, such as `claude/agent` | When the worker step starts | Refused: `workers.<name>.use: must be a step name such as claude/agent` |
| `dev.workers.<name>.args` | array of strings | `[]` | arguments for that step | When the worker step starts | Refused: `workers.<name>.args: must be an array of strings` |
| `dev.workers.<name>.count` | integer | `1` | `1` or more | On the next scheduler pass; running tasks keep their place | Refused: `workers.<name>.count: must be an integer of 1 or more` |
| `dev.workers.<name>.wallTimeSecs` | number | unset: the harness's own limit | above `0` | When the worker step starts | Refused: `workers.<name>.wallTimeSecs: must be a positive number of seconds` |
| `dev.workers.<name>.stallSecs` | number | unset: the harness's own limit | above `0` | When the worker step starts | Refused: `workers.<name>.stallSecs: must be a positive number of seconds` |
| `dev.workers.<name>.fallback` | string | unset | another worker of `workers`; not itself and not a worker with its own fallback | When a worker's model is unavailable | Refused: `workers.<name>.fallback: "<name>" cannot fall back to itself`, `... is not a worker in workers`, or `... already has a fallback` |
| `dev.pools` | object | one pool named `default` holding every worker in the order written | pool name to a non-empty list of worker names | When the file is read; `dev` needs the pool named `default` | Refused: `pools: must be an object`, `pools: must define at least one pool`, `pools.<name>: must be a non-empty list of worker names`, or `pools: needs a pool named "default", the one the dev flow uses` |
| `dev.pools.<name>` | array of strings | one `default` pool when `pools` is absent | worker names; each must exist in `workers` | On the next scheduler pass for the `default` pool | Refused: `pools.<name>[<i>]: "<worker>" is not a worker in workers` |
| `dev.workerBrief` | string | `".operad/worker-brief.md"` | a path to a Markdown file; a missing file uses the built-in four-line brief | When the work step builds the worker prompt | Refused: `workerBrief: must be a non-empty string` |
| `dev.prepare` | array of strings | `[]` | shell lines run in every checkout after it is created or moved to a new commit, before a step uses it | When a checkout is made or moved | Refused: `prepare: must be an array of command lines` or `prepare[<i>]: must be a non-empty string`; a failing line fails the step with `prepare failed` |

### The gate and its checks

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `dev.gate` | object | `{ "commands": [], "commandTimeoutSecs": 1800 }` | the keys below | When a check starts | Refused: `gate: must be an object` or `gate.<key>: is not a gate setting` |
| `dev.gate.commands` | array | `[]`: no check runs | a shell line, or a check command object | When the check step starts | Refused: `gate.commands: must be an array of commands` or the command's own error |
| `dev.gate.commandTimeoutSecs` | number | `1800` | above `0` seconds | When a gate command starts | Refused: `gate.commandTimeoutSecs: must be a positive number of seconds` |
| `dev.gate.places` | integer | unset: no limit for this repository | `1` or more | When a check looks for a place | Refused: `gate.places: must be an integer of 1 or more` |
| `dev.check` | object | `{ "rerun": 1, "flakyTask": 2 }` | the keys below | When a failed check is judged | Refused: `check: must be an object` or `check.<key>: is not a check setting` |
| `dev.check.rerun` | integer | `1` | `0` or more; `0` turns a rerun off | When a check line list fails; a timeout is never rerun | Refused: `check.rerun: must be zero or a positive integer` |
| `dev.check.flakyTask` | integer | `2` | `0` or more; `0` turns the proposal off | When a test passes only on its rerun | Refused: `check.flakyTask: must be zero or a positive integer` |
| `dev.check.flakyPlan` | string | unset: dev uses a plan `flaky-tests` (title `Flaky tests`) | a plan id | When a flaky-test task is proposed | Refused: `check.flakyPlan: must be a plan id`; a finished or cancelled plan makes dev use `flaky-tests` |
| `dev.check.loadLimit` | number | unset: the number of cores | above `0`, a 1-minute load average | When a check timed out or was killed from outside | Refused: `check.loadLimit: must be a positive number` |
| `dev.check.flakyLoadLimit` | number | unset: twice the number of cores | above `0`, a 1-minute load average | When a test failed and then passed on rerun | Refused: `check.flakyLoadLimit: must be a positive number` |

### A check command

The same object may appear in `gate.commands`, `integration.keyCommands` and a
flow's `check` stage.

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `gate.commands`, `integration.keyCommands`, `flows.<name>.stages.commands` | string or object | required where written | a shell line, or an object with `run` and optional `failed` | When that check runs | Refused: `<path>[<i>]: must be a string or an object` or `<path>[<i>].<key>: is not a command setting` |
| `gate.commands.run`, `integration.keyCommands.run`, `flows.<name>.stages.commands.run` | string | required | a non-empty shell line | When that check runs | Refused: `<path>[<i>].run: must be a non-empty string` |
| `gate.commands.failed`, `integration.keyCommands.failed`, `flows.<name>.stages.commands.failed` | object | absent: the top-level `check.rerun` applies | the keys below | Only when the line exits non-zero | Refused: `<path>[<i>].failed: must be an object` |
| `gate.commands.failed.match`, `integration.keyCommands.failed.match`, `flows.<name>.stages.commands.failed.match` | string | required in `failed` | a regular expression with exactly one capture group, matched per log line | When the check line fails | Refused: `<path>[<i>].failed.match: must be a valid regular expression` or `... must have exactly one capture group` |
| `gate.commands.failed.rerun`, `integration.keyCommands.failed.rerun`, `flows.<name>.stages.commands.failed.rerun` | string | required in `failed` | a command with `{name}` or `{pattern}` | When the check line fails | Refused: `<path>[<i>].failed.rerun: must contain {name} or {pattern}` |
| `gate.commands.failed.max`, `integration.keyCommands.failed.max`, `flows.<name>.stages.commands.failed.max` | integer | `10` | `1` or more | When the check line fails | Refused: `<path>[<i>].failed.max: must be a positive integer`; more failures than `max` fails the check without a rerun |

`{name}` is replaced by the shell-quoted test name and `{pattern}` by the
shell-quoted anchored regular expression of it. A check that uses `failed` does
not use `check.rerun` for that line. See [Checking a change](checks.md).

### Work, review, integration and cleanup

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `dev.work` | object | `{ "wrapUpAt": 0.85 }` | the key below | When a work step starts | Refused: `work: must be an object` or `work.<key>: is not a work setting` |
| `dev.work.wrapUpAt` | number | `0.85` | above `0` and below `1` | When the work step reaches that share of its time limit | Refused: `work.wrapUpAt: must be a number above 0 and below 1` |
| `dev.reviewer` | object | the reviewer defaults below | the keys below | When a review step starts | Refused: `reviewer: must be an object` or `reviewer.<key>: is not a reviewer setting` |
| `dev.reviewer.use` | string | `"radian/agent"` | a step name `<plugin>/<step>` | When a review starts | Refused: `reviewer.use: must be a non-empty string` |
| `dev.reviewer.args` | array of strings | `[]` | arguments for that step | When a review starts | Refused: `reviewer.args: must be an array of strings` |
| `dev.reviewer.firstArgs` | array of strings | unset | arguments for the first review of an attempt | When the first review of an attempt starts | Refused: `reviewer.firstArgs: must be an array of strings` |
| `dev.reviewer.first` | object | unset | the keys below; a set value replaces the reviewer's own for the first review | When the first review of an attempt starts | Refused: `reviewer.first: must be an object` or `reviewer.first.<key>: is not a first review setting` |
| `dev.reviewer.first.use` | string | `reviewer.use` | a step name | When the first review starts | Refused: `reviewer.first.use: must be a non-empty string` |
| `dev.reviewer.first.args` | array of strings | `reviewer.args` | arguments for that step | When the first review starts | Refused: `reviewer.first.args: must be an array of strings` |
| `dev.reviewer.first.timeoutSecs` | number | `reviewer.timeoutSecs` | above `0` seconds | When the first review starts | Refused: `reviewer.first.timeoutSecs: must be a positive number of seconds` |
| `dev.reviewer.first.stallSecs` | number | `reviewer.stallSecs` | above `0` seconds | When the first review starts | Refused: `reviewer.first.stallSecs: must be a positive number of seconds` |
| `dev.reviewer.fallback` | object | unset | `use` and optional `args`; used when the primary reviewer is unavailable | When a review finds the primary unavailable | Refused: `reviewer.fallback: must be an object`, `reviewer.fallback.use: must be a non-empty string`, or `reviewer.fallback.<key>: is not a fallback setting` |
| `dev.reviewer.fallback.use` | string | required | a step name | When the fallback review starts | Refused: `reviewer.fallback.use: must be a non-empty string` |
| `dev.reviewer.fallback.args` | array of strings | `[]` | arguments for that step | When the fallback review starts | Refused: `reviewer.fallback.args: must be an array of strings` |
| `dev.reviewer.timeoutSecs` | number | `600` | above `0` seconds | When a review starts | Refused: `reviewer.timeoutSecs: must be a positive number of seconds` |
| `dev.reviewer.stallSecs` | number | unset: the harness's own limit | above `0` seconds | When a review starts | Refused: `reviewer.stallSecs: must be a positive number of seconds` |
| `dev.reviewer.fixLevel` | string | `"major"` | `critical`, `major`, `minor` | When a review is graded | Refused: `reviewer.fixLevel: must be "critical", "major" or "minor"`; a value in `review.json` wins |
| `dev.reviewer.followups` | boolean | `true` | `true` or `false` | When a review passed with findings that did not fail it | Refused: `reviewer.followups: must be true or false` |
| `dev.reviewer.retrySecs` | number | `120` | above `0` seconds | When a review waits to run again after a model was unavailable | Refused: `reviewer.retrySecs: must be a positive number of seconds` |
| `dev.reviewer.maxFileDiffBytes` | integer | `200000` | `1` or more | When the review prompt is built | Refused: `reviewer.maxFileDiffBytes: must be a positive integer`; a larger file is left out and listed |
| `dev.reviewer.maxDiffBytes` | integer | `1000000` | `1` or more | When the review prompt is built | Refused: `reviewer.maxDiffBytes: must be a positive integer`; a larger change fails the review before a reviewer starts |
| `dev.integration` | object | `{ "style": "merge", "keyCommands": [], "batch": 1 }` | the keys below | When the integrate step starts | Refused: `integration: must be an object` or `integration.<key>: is not an integration setting` |
| `dev.integration.style` | string | `"merge"` | `merge`, `squash` | When a verified commit is put on main | Refused: `integration.style: must be "merge" or "squash"` |
| `dev.integration.keyCommands` | array | `[]` | check commands | When an integration candidate is built | Refused: `integration.keyCommands: must be an array of commands` or the command's own error; a failure sends the task back to the worker |
| `dev.integration.batch` | integer | `1`: one task at a time | `1` or more | When the next integration turn starts | Refused: `integration.batch: must be a positive integer` |
| `dev.hooks` | object | the cleanup commands below | the key below | When cleanup runs | Refused: `hooks: must be an object` or `hooks.<key>: is not a hook setting` |
| `dev.hooks.afterMerge` | array of strings | the five commands that remove the worktrees, prune, delete the local branch and delete the remote branch | shell lines run in the repository root with `OPERAD_TASK` and `OPERAD_WORKTREE` set | When cleanup runs after a merge | Refused: `hooks.afterMerge: must be an array of strings` or `hooks.afterMerge[<i>]: must be a non-empty string`; a failure is recorded and does not fail the task |
| `dev.maxAutoRework` | integer | `2` | `0` or more | When an automatic rework would start | Refused: `maxAutoRework: must be zero or a positive integer`; more waits for a person |
| `dev.autoDefault` | string | `"off"` | `off`, `run`, `merge` | When a new plan is made | Refused: `autoDefault: must be "off", "run" or "merge"` |
| `dev.retry` | object | `{ "environmentWaitMinutes": 60 }` | the key below | When a step fails for a reason outside the task's own work | Refused: `retry: must be an object` or `retry.<key>: is not a retry setting` |
| `dev.retry.environmentWaitMinutes` | integer | `60` | `1` or more minutes | When a step waits for what was missing | Refused: `retry.environmentWaitMinutes: must be a positive integer` |

### Flows and their stages

A repository's own flows are explained in [Flows and their stages](#flows-and-their-stages). The built-in
`default` flow is used when `flows` is absent.

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `dev.flows` | object | absent: the built-in `default` flow | flow name to a flow object | When a plan or task starts a run of that flow | Refused: `flows: must be a JSON object`, `flows: a flow needs a non-empty name`, or the flow's own error |
| `dev.flows.<name>` | object | none | `stages` only | When a task of that flow starts | Refused: `flows.<name>: must be a JSON object` or `flows.<name>.<key>: is not a flow setting` |
| `dev.flows.<name>.stages` | array | required | at least one stage; at least one must be `check`, `review` or `human` | When a task of that flow starts | Refused: `flows.<name>.stages: must be an array of stages` or `flows.<name>.stages: needs at least one check, review or human stage` |
| `dev.flows.<name>.stages.stage` | string | required | `work`, `check`, `review`, `human` | When the stage is reached | Refused: `flows.<name>.stages[<i>].stage: must be "work", "check", "review" or "human"` |
| `dev.flows.<name>.stages.use` | string | the repository worker for `work`, `reviewer.use` for `review` | a step name | When that stage starts | Refused: `flows.<name>.stages[<i>].use: must be a non-empty string` |
| `dev.flows.<name>.stages.args` | array of strings | the worker's or reviewer's own arguments | arguments for that step | When that stage starts | Refused: `flows.<name>.stages[<i>].args: must be an array of strings` |
| `dev.flows.<name>.stages.brief` | string | unset | extra instructions appended to the worker prompt | When the work stage starts | Refused: `flows.<name>.stages[<i>].brief: must be a non-empty string` |
| `dev.flows.<name>.stages.beforeAttempt` | string | unset: the worktree step's merge stays in force | `merge-main`, `none` | Before the work stage runs | Refused: `flows.<name>.stages[<i>].beforeAttempt: must be "merge-main" or "none"` |
| `dev.flows.<name>.stages.commands` | array | `gate.commands` | check commands | When the check stage starts | Refused: `flows.<name>.stages[<i>].commands: must be an array of commands` or the command's own error |
| `dev.flows.<name>.stages.rerun` | integer | `check.rerun` | `0` or more | When a check line list fails | Refused: `flows.<name>.stages[<i>].rerun: must be zero or a positive integer` |
| `dev.flows.<name>.stages.later` | array of strings | unset: `reviewer` arguments | arguments for every review after the first in an attempt | When a later review starts | Refused: `flows.<name>.stages[<i>].later: must be an array of strings` |
| `dev.flows.<name>.stages.grading` | string | unset: the flow's own name | an entry in `.operad/review.json` | When the review is graded | Refused: `flows.<name>.stages[<i>].grading: must be a non-empty string`; a missing entry falls back to `default` |

A field that a stage kind does not allow is refused with
`flows.<name>.stages[<i>].<key>: is not a stage setting`. A `human` stage has no
fields besides `stage`.

## `review.json`

`.operad/review.json` holds the grading a reviewer reads and the lowest finding
that fails a review. It falls back field by field to `default`. The file is
read when a review step needs it; [the review section](#reviewjson)
explains what a reviewer does with it.

<!-- schema: review.schema.json -->
```json
{
  "default": {
    "levels": {
      "critical": "A wrong result, data loss, a security hole or a broken build.",
      "major": "A defect a person would notice, or a missed requirement.",
      "minor": "A style or naming problem."
    },
    "rules": ["Do not ask for changes the task did not ask for."],
    "fixLevel": "major"
  },
  "flows": {
    "quick": { "fixLevel": "critical" }
  }
}
```

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `review.$schema` | string | absent | a schema URL | Only editors read it | Refused if it is not a string: `review.json: invalid <path>: $schema must be a string` |
| `review.default` | object | `{}` | the keys below | When a review has no flow entry | Refused: `review.json: invalid <path>: default must be a JSON object` |
| `review.default.levels` | object | `{}` | `critical`, `major`, `minor` to text given to the reviewer | When a review prompt is built | Refused: `review.json: invalid <path>: default.levels must be a JSON object` or `default.levels.<level> must be a string` |
| `review.default.levels.critical` | string | unset | what a critical finding means | When a review prompt is built | Refused: `... default.levels.critical must be a string` |
| `review.default.levels.major` | string | unset | what a major finding means | When a review prompt is built | Refused: `... default.levels.major must be a string` |
| `review.default.levels.minor` | string | unset | what a minor finding means | When a review prompt is built | Refused: `... default.levels.minor must be a string` |
| `review.default.rules` | array of strings | unset | extra grading rules | When a review prompt is built | Refused: `... default.rules must be an array of strings` or `default.rules[<i>] must be a string` |
| `review.default.fixLevel` | string | unset: `dev.reviewer.fixLevel` | `critical`, `major`, `minor` | When a review is graded | Refused: `... default.fixLevel must be "critical", "major" or "minor"` |
| `review.flows` | object | `{}` | flow name to a grading object | When a review of that flow is graded | Refused: `... flows must be a JSON object` |
| `review.flows.<name>` | object | unset: `default` | the keys below | When a review of that flow is graded | Refused: `... flows.<name> must be a JSON object` or `flows.<name>.<key> is not a known field` |
| `review.flows.<name>.levels` | object | `review.default.levels` | `critical`, `major`, `minor` to text | When a review of that flow is graded; it merges per level | Refused: `... flows.<name>.levels must be a JSON object` |
| `review.flows.<name>.levels.critical` | string | `review.default.levels.critical` | what a critical finding means for this flow | When a review of that flow is graded | Refused: `... flows.<name>.levels.critical must be a string` |
| `review.flows.<name>.levels.major` | string | `review.default.levels.major` | what a major finding means for this flow | When a review of that flow is graded | Refused: `... flows.<name>.levels.major must be a string` |
| `review.flows.<name>.levels.minor` | string | `review.default.levels.minor` | what a minor finding means for this flow | When a review of that flow is graded | Refused: `... flows.<name>.levels.minor must be a string` |
| `review.flows.<name>.rules` | array of strings | `review.default.rules` | extra grading rules for this flow | When a review of that flow is graded | Refused: `... flows.<name>.rules must be an array of strings` |
| `review.flows.<name>.fixLevel` | string | `review.default.fixLevel`, else `dev.reviewer.fixLevel` | `critical`, `major`, `minor` | When a review of that flow is graded; wins over `dev.reviewer.fixLevel` | Refused: `... flows.<name>.fixLevel must be "critical", "major" or "minor"` |

A field the schema does not name is refused with `... <path> is not a known
field`. A file that is not valid is refused whole, with the file named; the
review step then fails rather than guessing a grading.

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
`radian`, `pi`, `claude` and `codex` plugins can limit that. Set `concurrency` in
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
| `codex` | `codex:<model>` | the `--model` argument, else the plugin's `model` setting; with neither, the step is not limited |
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

### The `codex` settings

`codex` runs the user's own Codex through `codex-acp`; how to set it up is in
`docs/dogfood.md`. Its settings are in the `codex` section of `config.json`:

| Setting | Type | Default | What it does |
|---|---|---|---|
| `codex.model` | string | Codex's own | The model; the step's `--model` wins. |
| `codex.effort` | `minimal`, `low`, `medium`, `high`, `xhigh` | Codex's own | The reasoning effort; the step's `--effort` wins. |
| `codex.command` | array of strings | the `bun` and the `codex-acp` of `PATH` | The program and arguments that start codex-acp. |
| `codex.wallTimeSecs` | number, 1 to 28500 | `3600` | The longest one run may take. |
| `codex.stallSecs` | number, 1 or more | `600` | How long a run may be silent while no tool call is open. An image generation counts as an open tool call. |
| `codex.concurrency` | object, model name to integer | `{}` | The limit described above. |
| `codex.concurrency.<name>` | integer, 1 or more | none | How many runs of the model `<name>` may go at once. |

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

<!-- schema: dev.schema.json -->
```json
{
  "name": "operad",
  "remote": "origin",
  "mainBranch": "main",
  "concurrency": 2,
  "workers": {
    "claude": { "use": "claude/agent", "args": ["--model", "sonnet"], "fallback": "pi" },
    "pi": { "use": "pi/agent", "args": ["--model", "opencode-go/deepseek-v4.1-flash"] }
  },
  "pools": { "default": ["claude", "pi"] },
  "gate": { "commands": ["bash scripts/verify.sh"], "commandTimeoutSecs": 1800 },
  "check": { "rerun": 1, "flakyTask": 2 },
  "reviewer": { "use": "radian/agent", "fixLevel": "major" },
  "integration": { "style": "merge", "batch": 1 },
  "maxAutoRework": 2,
  "autoDefault": "off"
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
`radian`, `pi`, `claude` and `codex` declare `done`, `failed` and `interrupted`.
Plugins of other kinds name their own results. `shell` is a `stage`, not a
harness: its steps run a command or a check and give a verdict, so they end in
`pass` and `fail` (and `ready` or `waiting` for a check), and the end results
do not apply to them.
