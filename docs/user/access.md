---
description: Access profiles, the default profile, access-user.json, always allow, target grants, MCP tools and background runs.
---

# Access

An agent asks before it runs a command or touches a path its access profile does
not allow. A person answers the question with an action; `allow_always` records
the call so the question does not come again. The profile is a guard rail, not
a boundary: it matches the text of a call, and a program that builds a path or
command another way is outside what it can see.

## Why it exists

An agent can run shell commands and edit files, and you will not read every call before it runs. An access profile lets you write down in advance which paths and commands are refused, which ask a person first, and which run freely. The default profile covers the common cases: credentials, destructive commands, and a few commands that change the machine; a bot adds its operad home.

The profile is a guard rail, not a boundary. It matches the text of a call and cannot see what a program does once it runs, so it makes no claim to stop everything. For commands that hide what they run, such as `bash -c`, it asks or refuses instead of guessing, except in a chat at Full access, where such a command runs unless a deny plainly matches.

## How it works

1. Before an agent runs a tool, the harness gives the call to the matcher in `packages/access-match` together with the profile. A call is a tool name, its input and the working directory.
2. The matcher applies the order **deny, then ask, then allow**. A match in `denyPaths` or `denyCommands` refuses the call. A match in `askPaths` or `askCommands`, or a write in a `readOnly` working directory, asks a person. Anything else runs. See [The profile](#the-profile).
3. A path is normalised first: `~` is the user's home and a relative path is joined to the call's working directory. A command is split into its pipeline parts and each part is matched. Inline code is refused or asked about, because its content cannot be seen; at Full access it runs unless a deny plainly matches.
4. For an MCP call the matcher looks at `allowMcp` when the field is present: a listed tool runs, an unlisted one counts as a write and asks (see [MCP tool entries](#mcp-tool-entries)).
5. A question goes to a person, who answers `allow_once`, `allow_always` or `reject_once`. `allow_always` appends the exact command or path and the working directory to `access-user.json`, and the next identical call in that directory is allowed without a question (see [`allow_always`](#allow_always)). It never lifts a deny. The question shows the command it is about, even one the log would hide as unreadable: line breaks are kept, it is cut at 500 characters, and known secret values and leading assignment values are masked.
6. In a [background run](#background-runs), no person started the run, so `alwaysAllow` entries are ignored and every question is asked again.

## The profile

A profile is a JSON object. Every chat and every generated step starts from the
built-in default below. A bot's [settings](config.md#bot), a repository chat and
a flow's profile add to it; none removes a default deny or ask. The matcher
applies this order: **deny wins over ask, and ask wins over allow**. A call that
matches a deny is refused whatever an ask rule says; a call that only matches an
ask rule asks a person; every other call is allowed.

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `denyPaths` | array of strings | the default list below | paths; a `*` stays within one path segment | When a step judges a call | Refused by the reader: `denyPaths must be an array of strings` |
| `denyCommands` | array of strings | the default list below | command rules; word patterns with `*`, and `\|` between pipeline parts | When a step judges a command | Refused by the reader: `denyCommands must be an array of strings` |
| `askCommands` | array of strings | the default list below | command rules in the same shape as `denyCommands` | When a step judges a command that no deny refused | Refused by the reader: `askCommands must be an array of strings` |
| `askPaths` | array of strings | the default list below | paths a write asks about; `*` stays within one path segment | When a step judges a write or edit, or a `bash` redirect | Refused by the reader: `askPaths must be an array of strings` |
| `readOnly` | boolean | `false` | `true` or `false` | When a step judges a call in the profile's working directory | Refused by the reader: `readOnly must be true or false` |
| `level` | string | absent | `plan`, `ask`, `edits` or `full` | When a chat composes its profile for a reply; changed with `/access` | Refused by the reader: `level must be one of plan, ask, edits, full` |
| `readPaths` | array of strings | `[]` | directories a read may still reach under a denied ancestor | When a step judges a read, or a `bash` command that only reads | Refused by the reader: `readPaths must be an array of strings` |
| `allowMcp` | array of strings | absent: MCP tools are not under the profile | `<server>.<tool>` or `<server>.*` | When a step judges an MCP call; having the field at all, even empty, puts MCP tools under the profile | Refused by the reader: `allowMcp must be an array of strings` |
| `outwardCommands` | array of strings | the default list below | command rules in the same shape as `askCommands` | In a background run, before a command that writes outside operad | Refused by the reader: `outwardCommands must be an array of strings` |
| `outwardAllow` | array of strings | `["owner"]` | channel and conversation, address, repository and branch, or service targets; `owner` is the owner's own channels | In a background run, to let a target write without asking | Refused by the reader: `outwardAllow must be an array of strings` |
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
only read. `cd <dir>` may start a reading command, and a redirection that writes
nowhere (`2>/dev/null`, `2>&1`) is allowed; a redirect to a file still asks. A
deny still wins.

`level` is a chat's access level. `plan` is read-only; `ask` asks about every
write and every command not known to only read; `edits` lets a write inside the
working directory pass while a write outside it and a command not known to only
read ask; `full` asks nothing. At `full`, a command the matcher cannot follow
(inline code, a shell expansion, a path after a directory change it cannot
follow) runs unless a deny plainly matches, where `plan`, `ask` and `edits`
still ask about it. Only `denyPaths`, `denyCommands`, `readOnly` and a write
under `readPaths` remain at `full`: a deny refuses, a read-only working
directory asks about a write or a command not known to only read, and a write
under `readPaths` asks. `askCommands`, `askPaths` and an unlisted MCP tool do not
ask at `full`; they still apply at `plan`, `ask` and `edits`. An outward-write
question does not apply at `full`, and still asks in a background run below it.
A chat starts at `plan` on a repository and `ask` on a bot, except a chat a
scheduled prompt opens, which starts at `full`; `/access <level>` changes it; see
[Chats and bots](chats-and-bots.md#access-level).

`readPaths` lets a read reach a directory under an ancestor in `denyPaths`. It
does not allow a write: a write there asks.

## The default profile

The default profile lives in `@operad-io/access-match` and is what every chat and
every ordinary generated step starts from. A bot, a repository or a flow can add
to its lists and turn `readOnly` on, never remove one. The access level is
composed after those additions, so `full` keeps these deny rules too; a chat
below `full` keeps the ask rules as well.

A dev task worker is the exception: it starts from the default's deny rules
only, without its ask rules, because it works in the worktree of its own task
and its change reaches main only through checks, review and a merge. Chats and
other generated steps keep the default at levels below `full`, asks included;
at `full` only its deny rules and `readOnly` apply.

| List | Entries |
|---|---|
| `denyPaths` | `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.radian`, `~/Library/Keychains`, `~/Library/Application Support/Google/Chrome`, `~/Library/Application Support/Firefox`, `~/Library/Safari`, `.git/config`, `.git/hooks` |
| `denyCommands` | `sudo`, `su`, `rm -rf /`, `rm -rf ~`, `mkfs`, `dd`, `diskutil`, `shutdown`, `reboot`, `launchctl`, `crontab -r`, `git push --force*`, `git push --delete`, `curl … \| sh`, `wget … \| sh`, `pkill`, `killall` |
| `askCommands` | `git push`, `brew install`, `npm install -g`, `pip install`, `osascript`, `open` |
| `askPaths` | `~/.zshrc`, `~/.*profile` |
| `outwardCommands` | `git push`, `gh pr create`, `gh pr comment`, `gh issue create`, `gh issue comment`, `gh release create`, `curl`, `wget`, `mail`, `mailx`, `sendmail` |
| `outwardAllow` | `owner` |
| `readPaths`, `readOnly`, `allowMcp`, `level` | absent |

A bot adds the operad home and the `operad` command: every entry of the home
except the bot's own directory is denied (the names there now, and `store`,
`secrets`, `config.json` and the MCP report directory), so a home other than
`~/.operad` is covered too. The bot's own working directory under
`~/.operad/bot` is the one part of the home the agent may use, including its
`memory/` directory. For the default bot, the rest of `~/.operad/bot` is also
allowed except another bot's directory: files and directories a person or the
bot put in the old home stay there and remain readable and writable. Another
bot denies the entries of `~/.operad/bot` it does not own. The path of a
repository `dev` knows, and the path of a bot's skill
directories, are added to `denyPaths`: the agent reaches a repository through
`dev`'s actions, not by touching its files. The skill directories are also in
`readPaths`, so the agent reads them; a write there is still refused. A bot's
own `access` lists are appended to these, and its `access.readOnly` can turn
the working directory read-only.

A repository chat adds `operad` to `denyCommands` and starts read-only in the
main clone, with its skill directories read-only there. A generated step that
names no profile gets the default unchanged; a flow that names one adds to it.

A rule is a pattern of words; `*` matches any characters in a word. `-rf`
matches the same single-dash letters in any order, and `…` adds no condition.
`git push --force*` therefore matches `git -C x push --force`. An inline command
(such as `bash -c`, `python -c`, `bun -e`, `osascript -e`, `find -exec`, `xargs`,
`eval`, a backtick or `$()`) is refused while `denyCommands` is set and no
`askCommands` is set; when `askCommands` is set, it asks instead, because the
matcher cannot see what it runs. A chat at `full` runs it instead unless a deny
plainly matches; `plan`, `ask` and `edits` keep the refusal or question.
The full rule tables are in `packages/access-match/REFERENCE.md`.

## `access-user.json`

`$OPERAD_HOME/access-user.json` (see [the home](config.md#the-home)) holds the
calls a person answered `allow_always` for. A missing file is an empty list. A
file that cannot be read is reported by the step that reads it and treated as
empty. When the default bot moves from the old `$OPERAD_HOME/bot` to
`$OPERAD_HOME/bot/default`, an entry whose `cwd` is exactly the old home is
rewritten once to the new directory; every other entry is left as it was. A person adds an entry by answering `allow_always`; removing an entry is
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

## Always for this flow and target

In a background run the outward question also offers **Always for this flow and
target**. Choosing it records a grant: the same flow, with the same definition,
writing to the same target does not ask again. Another target asks, and a
change to the flow's definition asks again even after the change is reverted.
The grant is not bound to the content sent, so a daily digest with new text each
day to the same chat stays allowed. The chat's exact-call `allow_always` still
does not lift a background question.

The grants live in `$OPERAD_HOME/access-grants.json`. A missing file is an empty
list. A file that cannot be read is reported by the step that reads it and
treated as empty. A person lists and removes them with `operad dev:allow` on a
repository; `--target <target>` removes the grants of one target, and
`--flow <name>` narrows that to one flow. The same `allow` action is reachable
through HTTP and MCP, so a client can show the list. A removed grant asks again
on the next write.

<!-- schema: access-grants.schema.json -->
```json
{
  "flows": [
    { "flow": "daily:send", "digest": "b3f1…", "id": "6a8e…" }
  ],
  "grants": [
    {
      "flow": "daily:send",
      "definition": "6a8e…",
      "kind": "channel",
      "target": "telegram:999",
      "by": { "via": "ios", "id": "owner" },
      "at": 1700000000000
    }
  ]
}
```

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `flows` | array of flow identities | `[]` | the flow definitions last seen | Whenever a background outward write is judged: a digest that differs from the last one makes a new id | An entry without a flow, digest or id makes the whole file count as empty |
| `flows.flow` | string | required | the flow's name | It names the flow the identity belongs to | An empty value makes the whole file count as empty |
| `flows.digest` | string | required | the digest of the definition last seen | It tells an edit from the same definition | An empty value makes the whole file count as empty |
| `flows.id` | string | required | a generated identity, never reused | A grant matches only a grant with this identity | An empty value makes the whole file count as empty |
| `grants` | array of target grants | `[]` | the targets a person allowed | A background outward write to a matching target does not ask | An entry with a missing or wrong field makes the whole file count as empty |
| `grants.flow` | string | required | the flow's name | The grant lifts only that flow's question | An empty value makes the whole file count as empty |
| `grants.definition` | string | required | the definition identity the person answered for | A changed definition no longer matches | An empty value makes the whole file count as empty |
| `grants.kind` | string | required | `channel`, `mail`, `post`, `repository`, `service`, `command` | It records what kind of write the target takes | Any other value makes the whole file count as empty |
| `grants.target` | string | required | the exact target as the question names it | The write must name the same target | An empty value makes the whole file count as empty |
| `grants.by` | object | required | `{ "via", "id" }`, who answered | It is shown in the list and recorded for the owner | A missing or empty field makes the whole file count as empty |
| `grants.by.via` | string | required | the client the person answered from | It is shown in the list | An empty value makes the whole file count as empty |
| `grants.by.id` | string | required | who answered, as the client names them | It is shown in the list | An empty value makes the whole file count as empty |
| `grants.at` | number | required | when the person answered, in epoch milliseconds | It is shown in the list | A missing or non-number value makes the whole file count as empty |

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
`allow_always` is not offered: a question asks again every time. This is
deliberate: a scheduled or incoming run is held to the profile afresh rather
than inheriting a permission a person gave in an earlier conversation.

An **outward write** also asks first below `full`: a message, mail or
post; a `git push`; or a write call to an outside service. The question names
the target (the chat, address, repository and branch, or service) and carries
the whole content; its choices are `Send once`, `Always for this flow and
target` and `Reject`. A write to one of the owner's own channels, or to a target
in `outwardAllow`, does not ask. A plugin step or action declares such a write;
the shell steps use `outwardCommands`. The chat's exact-call `alwaysAllow` does
not lift this question; only a target grant from the section above does. A chat
at `full` asks nothing outward: see [Access level](chats-and-bots.md#access-level).
