---
description: The notify command: when it runs, what it gets, and an example script.
---

# Notifications

`notify` in `config.json` names a command for `serve` to run when something
starts waiting for a person:

```json
{ "notify": { "command": "sh ~/.operad/notify.sh", "on": ["waiting"] } }
```

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
