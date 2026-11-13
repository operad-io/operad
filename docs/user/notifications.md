---
description: The notify command: when it runs, what it gets, and an example script.
---

# Notifications

`notify` in `config.json` names a command for `serve` to run when something
starts waiting for a person:

```json
{ "notify": { "command": "sh ~/.operad/notify.sh", "on": ["waiting"] } }
```

## Why it exists

A wait in operad is an object that needs a person: a task ready to merge, review findings, a failed gate. `serve` keeps running without you, so nothing makes a person look at the app or `operad pending` at the right moment. The `notify` setting lets you name one shell command that runs when a wait appears, so you can send a push, a message or a sound by whatever means you already use.

operad does not ship a delivery service. It runs your command and passes the details in environment variables, and what the command does with them is yours to write. The command is also not a way to answer: it only tells you, and you answer in the app or with the commands.

## How it works

1. `operad serve` reads `notify` from `config.json` when it starts, and again when a new config loads. With `notify.command` set to `null`, or `waiting` missing from `notify.on`, nothing runs.
2. On every pass of its loop (every second by default) `serve` looks at the active runs. For each run whose state is waiting for a person it forms an identity from the run and the wait, which names the step and the visit to it.
3. If that wait has no recorded notice, `serve` runs the command with `sh -c` in the operad home. It sets `OPERAD_ID`, `OPERAD_TITLE`, `OPERAD_REASON` and `OPERAD_LINK`. A wait that the object's own plugin answers automatically is skipped, and a later pass reconsiders it if the answer does not come.
4. The command may run for 30 seconds. `serve` does not hold its loop for it.
5. After the command ends, `serve` records the notice. A failure or a timeout is logged with the exit code and the last lines of output, recorded too, and not retried. The wait does not notify again, including after a restart of `serve`.
6. If `serve` is stopped while the command is still running, the command is cancelled and nothing is recorded, so the next `serve` runs it again. If `serve` is killed after the command ends but before the record is written, that wait notifies once more.
7. When you answer and the same run later waits again, that is a new wait and a new notice.

## Settings and variables

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `notify` | object | `{ "command": null, "on": ["waiting"] }` | an object with the keys below; a missing section means notifications are off | When `operad serve` starts; a reload when the new config loads | Refused: `notify: must be an object` |
| `notify.command` | string or `null` | `null` | a non-empty shell line, run with `sh -c` in the operad home; `null` turns notifications off | When `serve` starts or reloads; the command runs for each new wait | Refused: `notify.command: must be a non-empty string or null` |
| `notify.on` | array of strings | `["waiting"]` | `waiting` only: an object now waits for a person | When `serve` starts or reloads; it sets which new waits notify | Refused: `notify.on: must be an array of "waiting"`; a repeated `waiting` is kept once |

An unknown key inside `notify` is ignored; only the keys above are read. The
command runs once per item and wait, with these in its environment:

| Variable | Value |
|---|---|
| `OPERAD_ID` | The object, as `<type>:<id>`. |
| `OPERAD_TITLE` | The object's title, or its id when the title cannot be read. |
| `OPERAD_REASON` | What it waits for: the prompt shown in `operad pending`. |
| `OPERAD_LINK` | The object link, `operad://objects/<id>`. |

For a task of the `dev` plugin the prompt names the step it stopped at; the
specific reason is in the task's `dev.waiting` notice: `ready to merge`,
`review findings`, `gate failed`, `rework limit`, `review timed out twice`,
`review did not finish`, `work did nothing`, `work failed`,
`run stopped during <step>`, `conflict`, `no verified commit`, `merge refused`
or `dependency cancelled`.

The token is never in the environment. A command runs for at most 30 seconds,
then it is stopped. Any exit other than 0, a timeout, or a command that cannot
start is logged by `serve` with its exit code and the last lines of its output,
and is not retried.

Each wait notifies once. A wait is one run reaching one step one time: the same
item that waits again, after you answered, is a new wait and notifies again. A
restart of `serve` does not notify again for a wait that already did. The
notice is recorded after the command has ended, so if `serve` is killed in
the moment between the two, the next `serve` runs the command once more for
that wait: at most one extra notification, never a lost one. Stopping `serve`
cancels a command that is still running, and the next `serve` runs it again.

Example with [ntfy](https://ntfy.sh): a push to your phone that opens the item
in the app when tapped.

```sh
#!/bin/sh
# ~/.operad/notify.sh
curl -s \
  -H "Title: $OPERAD_TITLE" \
  -H "Click: $OPERAD_LINK" \
  -d "$OPERAD_REASON" \
  https://ntfy.sh/my-operad-topic
```

with `"command": "sh ~/.operad/notify.sh"`. A topic name is a password for
anyone who guesses it; pick a long random one or use a self-hosted server.
