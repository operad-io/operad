---
description: Access profiles, the default profile, access-user.json, always allow, MCP tools and background runs.
---

# Access

An agent asks before it runs a command or touches a path its access profile does
not allow. A person answers the question with an action; `allow_always` records
the call so the question does not come again. The profile is a guard rail, not
a boundary: it matches the text of a call, and a program that builds a path or
command another way is outside what it can see.

## The profile

A profile is a JSON object. A bot's profile is its [bot settings](config.md#bot)
merged with the default below; a flow's profile is given to the steps that
declare they enforce its fields. The matcher applies this order: **deny wins
over ask, and ask wins over allow**. A call that matches a deny is refused
whatever an ask rule says; a call that only matches an ask rule asks a person;
every other call is allowed.

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `denyPaths` | array of strings | the default list below | paths; a `*` stays within one path segment | When a step judges a call | Refused by the reader: `denyPaths must be an array of strings` |
| `denyCommands` | array of strings | the default list below | command rules; word patterns with `*`, and `\|` between pipeline parts | When a step judges a command | Refused by the reader: `denyCommands must be an array of strings` |
| `askCommands` | array of strings | the default list below | command rules in the same shape as `denyCommands` | When a step judges a command that no deny refused | Refused by the reader: `askCommands must be an array of strings` |
| `askPaths` | array of strings | the default list below | paths a write asks about; `*` stays within one path segment | When a step judges a write or edit, or a `bash` redirect | Refused by the reader: `askPaths must be an array of strings` |
| `readOnly` | boolean | `false` | `true` or `false` | When a step judges a call in the profile's working directory | Refused by the reader: `readOnly must be true or false` |
| `readPaths` | array of strings | `[]` | directories a read may still reach under a denied ancestor | When a step judges a read, or a `bash` command that only reads | Refused by the reader: `readPaths must be an array of strings` |
| `allowMcp` | array of strings | absent: MCP tools are not under the profile | `<server>.<tool>` or `<server>.*` | When a step judges an MCP call; having the field at all, even empty, puts MCP tools under the profile | Refused by the reader: `allowMcp must be an array of strings` |
| `alwaysAllow` | array of entry objects | the entries in [access-user.json](#access-userjson) for a run a person started; empty in a background run | the entries below | When a step judges a call that would otherwise ask | Refused by the reader: `alwaysAllow must be an array`, or an entry's own message |
| `grants` | array of grant objects | `[]` | one-time permissions a step carries for one exact call | When the step that was waiting continues | Refused by the reader: `grants must be an array`, or a grant's own message |

The fields `cwd`, `outside` and `network` are not read by the matcher. The MCP
entries say what a local or remote MCP tool may do; see [MCP tool
entries](#mcp-tool-entries).

`denyPaths` and `askPaths` are matched against the path as the call wrote it,
normalised with `~` as the user's home and relative paths joined to the call's
working directory. A path under a `denyPaths` entry is refused. A write or edit
under an `askPaths` entry asks; a `bash` redirect to one asks with the whole
command.

`readOnly` makes the call's working directory read-only: a write or edit there
asks, and a `bash` command asks unless it is on the short list of commands that
only read. A deny still wins.

`readPaths` lets a read reach a directory under an ancestor in `denyPaths`. It
does not allow a write: a write there asks.

## The default profile

The default profile is what a bot starts from. Its lists are added to the lists
a bot writes; a bot can tighten them, never loosen them.

| List | Entries |
|---|---|
| `denyPaths` | `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.radian`, `~/Library/Keychains`, `~/Library/Application Support/Google/Chrome`, `~/Library/Application Support/Firefox`, `~/Library/Safari`, `.git/config`, `.git/hooks`, and every entry of the operad home except the bot's own directory (the names there now, and `store`, `secrets`, `config.json` and the MCP report directory) |
| `denyCommands` | `operad`, `sudo`, `su`, `rm -rf /`, `rm -rf ~`, `mkfs`, `dd`, `diskutil`, `shutdown`, `reboot`, `launchctl`, `crontab -r`, `git push --force*`, `git push --delete`, `curl … \| sh`, `wget … \| sh`, `pkill`, `killall` |
| `askCommands` | `git push`, `brew install`, `npm install -g`, `pip install`, `osascript`, `open` |
| `askPaths` | `~/.zshrc`, `~/.*profile` |
| `readPaths`, `readOnly`, `allowMcp` | absent |

The home entries are absolute, so a home other than `~/.operad` is covered too.
The bot's own working directory under `~/.operad/bot` is the one part of the
home the agent may use. The path of a repository `dev` knows, and the path of a
bot's skill directories, are added to `denyPaths`: the agent reaches a
repository through `dev`'s actions, not by touching its files. A bot's own
`access` lists are appended to these, and its `access.readOnly` can turn the
working directory read-only.

A rule is a pattern of words; `*` matches any characters in a word. `-rf`
matches the same single-dash letters in any order, and `…` adds no condition.
`git push --force*` therefore matches `git -C x push --force`. An inline command
(such as `bash -c`, `python -c`, `bun -e`, `osascript -e`, `find -exec`, `xargs`,
`eval`, a backtick or `$()`) is refused while `denyCommands` is set, and asks
while only `askCommands` is set, because the matcher cannot see what it runs.
The full rule tables are in `packages/access-match/README.md`.

## `access-user.json`

`$OPERAD_HOME/access-user.json` (see [the home](config.md#the-home)) holds the
calls a person answered `allow_always` for. A missing file is an empty list. A
file that cannot be read is reported by the step that reads it and treated as
empty. A person adds an entry by answering `allow_always`; removing an entry is
deleting its object from the array. The file is written under a lock and
replaced whole, so a crash does not leave it half written.

<!-- schema: access-user.schema.json -->
```json
[
  { "kind": "command", "value": "git status --short", "cwd": "/Users/you/Code/example" },
  { "kind": "path", "value": "notes/todo.md", "cwd": "/Users/you/Code/example", "tool": "edit" }
]
```

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `kind` | string | required | `command`, `path` | When a step asks about a call: an entry matches only a call of its kind | An entry without `command` or `path` makes the whole file count as empty; the step reports `entry <i> is not a command or path entry with a value and a working directory` |
| `value` | string | required | the command text exactly as allowed (for an MCP tool, `mcp <server>.<tool>`), or the path as the call wrote it | When a step asks about a call: the call must match it exactly | An entry without a non-empty value makes the whole file count as empty |
| `cwd` | string | required | the working directory the call was allowed in | When a step asks about a call: the call must be in that directory; another directory is a new question | An entry without a non-empty working directory makes the whole file count as empty |
| `tool` | string | required for `path` | a tool name such as `write` or `edit` | A path entry allows that tool only, not another tool on the same path | A path entry without a tool, or a command entry with one, makes the whole file count as empty |

An invalid file is treated as an empty list and the step logs `the user access
file "<path>" ...; it is treated as empty`. An `allow_always` answer writes an entry only when the call was allowed
once; a call that holds a secret value is never asked about and never written.

## `allow_always`

When a call needs to ask, a person sees three choices in a run a person started
(`allow_once`, `allow_always`, `reject_once`). `allow_always` lets this call run
and appends its exact value and working directory to `access-user.json`; later
calls with the same text in the same directory then run without asking. It does
not lift a `denyPaths` or `denyCommands` match, and it does not cover a
different command, a different path spelling, or the same command in another
directory. A late answer may carry the write too; if the file cannot be written,
the step logs that and lets the call run once.

## MCP tool entries

`allowMcp` in the profile (or `mcpAllow` in a bot's settings) lists the MCP
tools that run without asking, as `<server>.<tool>` or `<server>.*`. The field's
presence, even as an empty list, puts MCP tools under the profile: a tool that
is not listed counts as a write and asks first. A tool that is listed runs
without asking; a deny path or command still wins when it covers the call.

An answered MCP question is recorded like any other command: `kind` is
`command`, `value` is `mcp <server>.<tool>` and `cwd` is the working directory.
An entry matches only that server and tool, exactly.

## Background runs

A run is a **background run** when no person's message started it: a schedule, a
webhook, an incoming message from another source, or an event a run emitted.
Only a message from one of the chat's own client sources (`ios`, `telegram`,
`cli`, `tui`, `other`) is a person's message for this rule.

In a background run the existing `alwaysAllow` entries are not used, and
`allow_always` is not offered: a question asks again every time, with
`allow_once` and `reject_once` only. This is deliberate: a scheduled or incoming
run is held to the profile afresh rather than inheriting a permission a person
gave in an earlier conversation.
