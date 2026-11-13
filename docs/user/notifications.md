---
description: The notify command: its keys, when it runs, what it gets, and an example.
---

# Notifications

`notify` in `config.json` names a command for `serve` to run when something
starts waiting for a person. It is off while `command` is `null`.

| Key | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `notify` | object | `{ "command": null, "on": ["waiting"] }` | `command` and `on` | When `serve` starts and at each wait; a change to `config.json` is read again at its next use. |
| `notify.command` | string or `null` | `null` | A shell line, or `null` | When a wait starts: the line is run with `sh -c` in the operad home. `null` turns notifications off. An empty string is a config error. |
| `notify.on` | array of strings | `["waiting"]` | `waiting` | When a wait starts: `waiting` means an object now waits for a person. It is the only value; any other value is a config error that names it. |

For example:

```json
{ "notify": { "command": "sh ~/.operad/notify.sh", "on": ["waiting"] } }
```

A config error names the file and the key, for example
`<file>: notify.on: must be an array of "waiting"`.

## When it runs

The command runs once per item and wait, with these in its environment:

| Variable | Value |
|---|---|
| `OPERAD_ID` | The object, as `<type>:<id>`. |
| `OPERAD_TITLE` | The object's title, or its id when the title cannot be read. |
| `OPERAD_REASON` | What it waits for: the prompt shown in `operad pending`. |
| `OPERAD_LINK` | The object link, `operad://objects/<id>`; opening it shows the object in the app. |

For a task of the `dev` plugin the prompt names the step it stopped at; the
specific reason (`ready to merge`, `review findings`, ...) is in the task's
`dev.waiting` notice, which [Running operad on operad](../dogfood.md) lists.

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

A wait that its plugin is about to answer automatically is not notified: `dev`
answers "merge" itself for a task whose plan is at auto merge and whose review
passed. If the automatic answer does not come, the next pass finds the wait and
notifies then.

## Example

With [ntfy](https://ntfy.sh): a push to your phone that opens the item in the
app when tapped.

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

The app's own push uses the same waiting moment; see [Pending and
notifications](app.md#pending-and-notifications). The MCP channel has its own
`mcp.channel.notify` setting; see [the MCP page](mcp.md#claude-code-channel).
