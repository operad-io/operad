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

A plan id is `PL<4 digits>-<slug>`; a task id is `TK<4 digits>-<slug>`. Numbers
count up per repository and are never reused, so two repositories may both have
`TK0001-work`; a command accepts the bare id inside the repository it names.

## Commands

```
operad repo add <path> [--name <name>]
operad repo list
operad repo remove <name>
operad plan add --slug <slug> --title <title> [--repo <name>]   # request on stdin
operad task add --plan <plan> --slug <slug> --title <title> [--after <task>]... [--repo <name>]   # brief on stdin
operad task edit <id>      # $EDITOR on the brief body; proposed or ready only
operad task update <id> [--title <title>] [--after <task>]...
```

Inside a registered repository the repository is inferred; elsewhere pass
`--repo <name>`.

## Actions

Every action is also a command: `operad dev:<action> <id>`.

| action | object | key | what it does |
|---|---|---|---|
| `dev:confirm` | plan, task | `c` | confirm a draft plan (its tasks become ready) or a proposed task |
| `dev:cancel` | plan, task | `x` | cancel a plan and its open tasks, or one task; asks first |
| `dev:auto-off` | plan | | set auto to off |
| `dev:auto-run` | plan | | set auto to run |
| `dev:auto-merge` | plan | | set auto to merge |
| `dev:priority-up` | plan | | move one step towards P0 |
| `dev:priority-down` | plan | | move one step towards P5 |

`merge` and `reject` arrive with the review part of the plan.

## Settings

`operad repo add` writes `<repository>/.operad/dev.json` when it is absent (its
schema is `schemas/dev.schema.json`) and adds `.operad-worktrees/` and
`.radian-sandbox/` to the repository's `.git/info/exclude`.

## Views

A plan shows a request and a table of its tasks. A task shows its brief, its
rework sections when it has some, and its changes.
