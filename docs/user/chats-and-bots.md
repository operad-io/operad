---
description: Chats with an agent, bots, their commands, settings, MCP servers and proposals.
---

# Chats and bots

A chat is a long conversation with an agent. A bot is a working directory, a
default agent, skills, a speaker and an access profile; a chat on a bot uses
them, and a chat on a repository does the repository's work. Both are objects
from plugins: `chat` owns every chat, `dev` opens one on a repository, and
`bot` opens one on a bot.

## Why it exists

Working with an agent is usually a long exchange, not one command. A chat keeps that exchange in operad: you send messages from the command line, the terminal UI, iOS or Telegram (see [Telegram](telegram.md)), and every one lands in the same transcript. operad keeps its own record of the messages, so the history of a chat does not depend on the agent's session files; a cleaned or compacted session does not erase it.

A bot exists for chats that are not about a repository. It fixes, in one place, the working directory, default agent, skills, speaker and access profile that such a chat uses, so you can keep several bots with different permissions, for example a read-only one. Because a chat reads its bot at every reply, tightening a bot or adding a skill does not need a new chat.

The plugins are deliberately cautious. A chat on a repository is read-only until you agree to open a worktree. A bot cannot change its own skills, settings or MCP servers; it can only propose a change, and nothing on disk changes until a person approves.

## How it works

1. A chat is opened by a plugin: `dev:chat` on a repository, `bot:chat` on a bot. The agent is chosen then and does not change; the model and effort can be changed later with `chat:model` and `chat:effort`.
2. `chat:send` records a message. A message is an event whose source is `ios`, `telegram`, `cli`, `tui` or `other`, and the `chat` plugin's own rule starts `chat:reply` for it (see [Chats](#chats)).
3. `chat:reply` takes the messages that no reply answers yet from the chat's own record, continues the agent's session, and records the reply. If messages arrived meanwhile it goes round again, at most 20 rounds. Without `operad serve` the message is only recorded and is answered when `serve` runs.
4. While the agent works, the `transcript` section shows the messages, tool calls and the unfinished text of the current reply.
5. Each tool call is checked against the chat's access profile (see [Access](access.md)). For a bot chat the profile is the default profile plus the bot's own `access` settings; the bot's settings are read again at every reply (see [Bots](#bots)).
6. A chat on a repository starts in the main clone as read-only. A write, or a command that is not known to only read, becomes the worktree question; on yes, `dev` opens `work/chat-<id>` and the chat works there.
7. When a bot proposes a skill, a settings change or an MCP server (`operad bot skill`, `bot setting`, `bot mcp`), a `bot-proposal` object waits in Pending. `bot:approve` applies it and `bot:reject` drops it (see [Bot objects and proposals](#bot-objects-and-proposals)).
8. `chat:close` records `chat.closed`; the transcript stays readable and `chat:send` is refused.

## Chats

A chat belongs to the plugin that opened it. `dev` opens one on a repository:

```sh
operad dev:chat --repo operad --title "The build" [--agent pi]
operad chat:send C-0001 --note "why does the gate fail on main?"
operad show C-0001 --section transcript
```

`dev:chat` offers `claude` and `pi` as agents (the first one loaded when
`--agent` is left out): they can stop a tool call before it starts, which a
read-only chat needs. `radian` is refused there as an agent and stays for bot
chats. `bot:chat` offers every loaded agent; its default is the bot's `harness`,
or the first loaded.

A chat has these actions:

| Action | Arguments | What it does |
|---|---|---|
| `chat:send` | `note`, `attachments` (uploaded file refs), `ref` | Records a message and starts the reply. The message may be only attachments. Prints `sent <message id>`; with no `serve` it prints `recorded <id>; it is answered when operad serve runs`. A closed chat refuses it. |
| `chat:model` | `model` | Changes the model the next reply uses. The model must be one the chat's agent lists; prints `chat <id> now uses <model>; the next reply uses it`. |
| `chat:effort` | `effort` | Changes the effort the next reply uses, from the agent's list; prints `chat <id> now uses effort <effort>; the next reply uses it`. |
| `chat:close` | none; asks to confirm | Records `chat.closed` and ends the chat. Prints `closed <id>`. The transcript stays readable; no other action appears. |

A message is an event: source `ios`, `telegram`, `cli`, `tui` or `other`, key is
the message id, object is the chat. The `chat` plugin's own rule starts
`chat:reply` for these sources automatically; a rule of yours in `triggers.json`
with the same source and type replaces it. The reply reads the messages no reply
answers yet from the chat's own record, continues the agent session, records the
reply, and goes round again while new messages came in meanwhile (at most 20
rounds). After a restart a reply that was already recorded is not given twice.

The `transcript` section is live: it shows user messages, the agent's
intermediate text, `Thinking`, tool calls with their result, duration and a short
output, and the final reply. Tool output is cut in the transcript; the full output
is in a file in the chat's directory. A run that is still replying shows its
unfinished text and thinking as a `tail`; `mark` and `after` let a client append
only the finished part (see [Reading a section](http.md#reading-a-section)).
The records do not depend on the agent's own session files, so a cleaned or
compacted session does not erase the chat's history; the agent's context still
belongs to the agent, which continues its own session.

A chat's filters are `open` (the default) and `closed`; the kernel adds `all`,
so `operad list chat --filter all` still shows closed chats. A chat on a
repository works in the main clone, read-only: a shell command runs there only
when it is on a short list of commands that only read (`git status`, `ls`,
`cat`, `grep`, `sed -n`, `bun test`, ...); every other command, and every write
or edit, becomes the worktree question, which names the command or the path.
When the agent wants to change code it asks whether to open a worktree. A no
tells the agent the call was refused because the chat is read-only, and that it
should answer in the chat or use read-only commands. On yes, `dev` opens
`work/chat-<id>` and the chat works there from then on, once; the main clone
stays read-only. The worktree's changes reach main only through a task that
points at it, through the normal gate and integrate.

Attachments are files a client uploaded (`POST /v1/uploads`), stored under the
chat's attachment directory in the operad home. A message may be only files.
The transcript shows each as a line with its name (an image as an image, another
file as an `Attachment:` link). The reply gives an image to `claude` and `pi` as
image input (up to 5 MB each) and every file to the agent as a path in the
prompt; the chat's access profile gains read access to that chat's attachment
directory and nothing else. The MCP tools cannot pass a file; a client uploads
it.

The agent reaches operad through its tools (`list`, `show`, `section`, `pending`,
`answer`, `running`, `history`, `command`, `act`, under the same allow lists as
`operad mcp`), never by running `operad` in a shell.

## Bots

The `bot` plugin has no tab. Its objects live under Settings: a bot page is that
bot's settings page, and the bots are listed in a section named Bots. A bot is
written in `config.json` under `plugins.bot.settings`; the `default` bot exists
even when it is not written. The section is read at every use, so an edit
applies to the next reply without a restart.

| Key | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `bot.bots` | object | `{ "default": {} }` | One entry per bot name | Read when a bot is resolved, every reply. A bot removed from the map is marked removed and its chats stop answering. |
| `bot.bots.<name>` | object | `{}` | The keys below | One bot. A name is lowercase letters, digits, `-` and `_`, and starts with a letter or digit; any other name is `bot "<name>": a name is lowercase letters, digits, "-" and "_", and starts with a letter or digit`. |
| `bot.bots.<name>.cwd` | string | `$OPERAD_HOME/bot` for `default`, `$OPERAD_HOME/bot/<name>` otherwise | A path | The working directory of the bot's chats. It must be inside `$OPERAD_HOME/bot` or outside the operad home; another path is refused when the bot is resolved. |
| `bot.bots.<name>.harness` | string | the first loaded agent | A loaded agent name | The agent a new chat uses when it names none. An unloaded name is refused when a chat opens: `agent "<name>" is not loaded; the loaded ones are: …`. |
| `bot.bots.<name>.skills` | array of strings | `[]` | Directories with a `SKILL.md`; a relative path is under the working directory | Every reply; the directories are given to the agent. A missing or unreadable skill is reported at the reply. |
| `bot.bots.<name>.model` | string | the agent's default | A model the chat's agent lists | When a new chat starts; an unlisted model is refused by name. The chat can change it later with `chat:model`. |
| `bot.bots.<name>.effort` | string | the agent's default | An effort the chat's agent lists | When a new chat starts; an unlisted effort is refused by name. The chat can change it later with `chat:effort`. |
| `bot.bots.<name>.speaker` | string | `chat.speaker` | Any non-empty string | Every reply: how the transcript labels the model's messages. |
| `bot.bots.<name>.mcpServers` | object | `{}` | One entry per local MCP server name | At every reply of a chat on an agent that takes MCP servers natively (`claude`, `radian`); a server is mounted only when its `digest` is set. `pi` does not mount them yet. |
| `bot.bots.<name>.mcpServers.<name>` | object | none | The keys below | One local server. A name is lowercase letters, digits and `-`, with single `_` between parts; `operad` is reserved. |
| `bot.bots.<name>.mcpServers.<name>.command` | string | required | The program that starts the server | When the server is proposed and when a chat starts it. |
| `bot.bots.<name>.mcpServers.<name>.args` | array of strings | `[]` | The server's arguments | When the server is proposed and when a chat starts it. |
| `bot.bots.<name>.mcpServers.<name>.package` | string | absent | A package name | The package the command runs, when it runs one; recorded from a pinned package command (`npx`, `bunx`, `uvx`, `pipx`). |
| `bot.bots.<name>.mcpServers.<name>.version` | string | absent | An exact version | The pinned version of that package. A tag or range is refused before the server starts. |
| `bot.bots.<name>.mcpServers.<name>.secrets` | array of strings | `[]` | Environment variable names | The server receives each value from the bot plugin's secret store, as `<server>.<variable>`, only when it starts. |
| `bot.bots.<name>.mcpServers.<name>.tools` | array of objects | absent | `{ "name", "description" }` entries | The tools the server offered when a person approved it; compared with the tools it offers at a start. |
| `bot.bots.<name>.mcpServers.<name>.tools.name` | string | required | A tool name | One approved tool. |
| `bot.bots.<name>.mcpServers.<name>.tools.description` | string | required | The tool's description | The description that was approved with the name; together they make the digest. |
| `bot.bots.<name>.mcpServers.<name>.digest` | string | absent | The digest of the approved tools | When a chat starts the server: a different tool list is not mounted, and a changed-tools proposal waits in Pending. |
| `bot.bots.<name>.mcpAllow` | array of strings | `[]` | `<server>.<tool>` or `<server>.*` | Every MCP tool call of the bot's chats: a listed tool runs without asking; an unlisted one counts as a write and asks first. |
| `bot.bots.<name>.access` | object | `{}` | The keys below | Every reply: it is added to the default access profile. A bot can tighten the default, never loosen it. |
| `bot.bots.<name>.access.denyPaths` | array of strings | `[]` | Paths | Appended to the default deny list. |
| `bot.bots.<name>.access.denyCommands` | array of strings | `[]` | Command patterns | Appended to the default deny list. |
| `bot.bots.<name>.access.askCommands` | array of strings | `[]` | Command patterns | Appended to the default ask list; a match asks before it runs. |
| `bot.bots.<name>.access.askPaths` | array of strings | `[]` | Paths | Appended to the default ask list. |
| `bot.bots.<name>.access.readOnly` | boolean | `false` | `true`, `false` | Every reply: `true` refuses every write and every command that is not known to only read. |
| `chat.speaker` | string | `"Operad Bot"` | Any non-empty string | Every reply of a chat that does not use a bot's `speaker`; editable with `operad settings set chat.speaker <value>`. |

The default access profile denies credentials and secrets (`~/.ssh`, `~/.gnupg`,
`~/.aws`, `~/.config/gh`, keychains and browser profiles), the operad home
(except the bot's own directory), `.git/config`, `.git/hooks`, and commands such
as `sudo`, `operad`, `mkfs`, `dd`, `shutdown`, `pkill` and `killall`; it asks
before `git push`, `brew install`, `npm install -g`, `pip install`, `osascript`
and `open`. See [Access](access.md) for `access-user.json` and always allow.

### Bot objects and proposals

A bot page has the `bot` section. A bot that cannot be used stores its problem
and its row says so; `bot:chat` then refuses with that problem. A bot taken out
of the settings is marked removed; a new one appears at the next use.

A change a bot proposes to itself is a `bot-proposal` object. It is pending
until a person approves or rejects it; nothing on disk changes before that. A
proposal is one of:

- a skill (`bot skill`): the files before and after, applied to the skill
  directory and added to the bot's `skills`;
- a settings change (`bot setting`): the bot's settings before and after;
- an MCP server (`bot mcp`): a new server, an upgrade, or a server whose tools
  changed.

`bot:approve` applies a pending proposal and `bot:reject` rejects it. A proposal
that is not pending still shows its state.
The `bot-proposal` filters are `pending` (the default), `applied` and
`rejected`; each pending proposal is also a pending item of its bot, so it
appears in Pending and in the app.

### Bot commands

`operad bot skill <bot> <name> [--from <dir>]` proposes a new or changed skill.
Without `--from`, stdin is a JSON object with `skill_md` and `files`; with it,
the directory's files are read. The skill needs a `SKILL.md`. It prints
`proposed skill "<name>" for bot <bot>; review it in pending`.

`operad bot mcp <bot> <name> <command> [args…]` starts a local MCP server once,
reads its tool list and proposes registering it. With no command, stdin is a
pasted `mcpServers` entry. Only a local server (a command with arguments) can be
registered; an address (`url`, `type: "http"`, `type: "sse"`, `headers`) is
refused. A package command must name an exact version: `npx -y pkg@1.2.3` is
accepted; `pkg@latest` or a range is refused with the version it needs. The
server is started in the bot's working directory with the bot's access profile
and its secrets. It prints
`proposed MCP server "<name>" for bot <bot> (<n> tools); review it in pending`.

`operad bot setting <bot>` reads a JSON object from stdin and proposes the
change. It cannot add or change `mcpServers`; that is what `bot mcp` is for. It
prints `proposed settings for bot <bot>; review it in pending`.
