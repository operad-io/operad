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

A bot's directory is `$OPERAD_HOME/bot/<name>`; the default bot is `$OPERAD_HOME/bot/default`, beside the other bots rather than above them. Its `memory/` directory is made when missing. A bot may read and write its own directory and its memory, and every other bot's directory is refused for reading and writing. The default bot's old home at `$OPERAD_HOME/bot` is not emptied: only the `skills/` and `memory/` directories operad made there move into `$OPERAD_HOME/bot/default`. Every other file and directory a person or the bot put in the old home stays where it is, and the default bot may still read, write and run there; only another bot's directory is refused. Grants in `access-user.json` whose working directory is exactly the old home are rewritten once to `$OPERAD_HOME/bot/default`; grants for other directories are unchanged. A bot with a written `cwd` keeps it.

The plugins are deliberately cautious. A chat on a repository is read-only until you agree to open a worktree. A bot cannot change its own skills, settings or MCP servers; it can only propose a change, and nothing on disk changes until a person approves.

## How it works

1. A chat is opened by a plugin: `dev:chat` on a repository, `bot:chat` on a bot. The agent is chosen then and does not change; the model, effort and access level can be changed later with `chat:model`, `chat:effort` and `chat:access`.
2. `chat:send` records a message. A message is an event whose source is `ios`, `telegram`, `cli`, `tui` or `other`, and the `chat` plugin's own rule starts `chat:reply` for it (see [Chats](#chats)).
3. `chat:reply` takes the messages that no reply answers yet from the chat's own record, continues the agent's session, and records the reply. A message sent while the reply is being written is given to the agent in that same reply when its agent takes messages mid-run (`claude`, `pi`, `codex`); otherwise, or when it has an attachment, it waits for the next round as a **queued** message. If messages are still waiting it goes round again, at most 20 rounds. Without `operad serve` the message is only recorded and is answered when `serve` runs. A reply being written can be stopped; its half-written text stays in the transcript, and `/retry` answers the last message again after a failed or stopped reply. A `pi` chat retries a failed model request by itself with pi's bounded backoff; the live transcript shows the attempt, the time of the next try and why, and a successful retry leaves no line behind.
4. While the agent works, the `transcript` section shows the messages, tool calls and the unfinished text of the current reply.
5. Each tool call is checked against the chat's access profile with the chat's access level composed into it (see [Access](access.md) and [Access level](#access-level)). For a bot chat the profile is the default profile plus the bot's own `access` settings; the bot's settings are read again at every reply (see [Bots](#bots)).
6. A chat on a repository starts in the main clone as read-only. A write, or a command that is not known to only read, becomes the worktree question, which offers Allow once, Always allow, Deny and opening a worktree; the worktree offer has `dev` open `work/chat-<id>`, ends the asking reply and answers the same message again there, so the agent continues with write access.
7. When a bot proposes a skill, a settings change, an MCP server or a scheduled prompt (`operad bot skill`, `bot setting`, `bot mcp`, `bot schedule`), a `bot-proposal` object waits in Pending. `bot:approve` applies it and `bot:reject` drops it (see [Bot objects and proposals](#bot-objects-and-proposals)).
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
chats. A repository chat starts at `plan`; a bot chat starts at `ask`. The
access level is changed in the chat with `/access <level>` (see [Access
level](#access-level)). `bot:chat` offers every loaded agent; its default is
the bot's `harness`,
or the first loaded.

A chat has these actions:

| Action | Arguments | What it does |
|---|---|---|
| `chat:send` | `note`, `attachments` (uploaded file refs), `ref` | Records a message and starts the reply. The message may be only attachments. Prints `sent <message id>`; with no `serve` it prints `recorded <id>; it is answered when operad serve runs`. A closed chat refuses it. |
| `chat:withdraw` | `message` | Withdraws a queued message before any run takes it. The message leaves the transcript, is not sent to the agent, and one history entry says it was withdrawn. A message a run has taken is refused. Prints `withdrew message <id>`. |
| `chat:edit` | `message`, `text` | Changes the text of a queued message before any run takes it; its attachments stay. A message a run has taken is refused. Prints `changed message <id>`. |
| `chat:model` | `model` | Changes the model the next reply uses. The model must be one the chat's agent lists; prints `chat <id> now uses <model>; the next reply uses it`. |
| `chat:effort` | `effort` | Changes the effort the next reply uses, from the agent's list; prints `chat <id> now uses effort <effort>; the next reply uses it`. |
| `chat:stop` | none | Stops the reply being written. What was written stays in the transcript, marked stopped. Messages that arrived meanwhile stay unanswered and no new reply starts by itself; prints that and points to `/retry`. With no reply running it says so and changes nothing. The client's button word is **Stop**. |
| `chat:retry` | none | Answers the last message again after a reply failed, was stopped or was interrupted. It appears only while it would answer: the chat is open, a message waits for a reply and no reply is being written. The failed or stopped attempt stays in the record and the agent's session continues. Otherwise typing it says why and starts nothing. |
| `chat:status` | none | Shows the agent, the model and effort in force, whether a reply is being written and since when, how many messages wait, the session's cost and token usage, and the last reply's usage and time to first output. It reads only, costs no tokens and works while a reply is being written. An agent that reports no cost leaves it `unknown`. |
| `chat:close` | none; asks to confirm | Records `chat.closed` and ends the chat. Prints `closed <id>`. The transcript stays readable; no other action appears. |

A message is queued from when it is sent until a run takes it: the messages of
a run's first prompt are taken when it starts, and a message handed to an agent
mid-run is taken then. A chat's row and its `transcript` section carry the
queued messages in `data.queued`, in sending order, with `data.queuedCount`; the
row and the section have neither field when nothing is queued. A client shows
"N queued" above the composer and offers `chat:withdraw` and `chat:edit` on
each of them. A message a run has taken never changes, and both actions refuse
it with a line naming the message.

A line that starts with `/` and names one of the chat's actions runs that action
instead of going to the agent: `/model sonnet`, `/effort high`, `/stop`, `/retry`,
`/status`, `/close`, `/help`. `chat:withdraw` and `chat:edit` are actions of the
queued message, not chat commands.
The rest of the line is the action's arguments, in the order its fields are
declared; one field takes the whole rest, and with more than one the last field
takes what is left. A `/xxx` that names no action, or a slash later in the line,
is an ordinary message. `/close` asks for the action's confirmation: `/close`
alone does nothing and says to send `/close yes`. `/help` lists the actions this
chat accepts, each with its one-line description, then the skills it can type
by name. Every attempt leaves one entry
in the transcript, naming who typed it, the line and what happened or why it was
refused; that entry is not a message, so the agent never sees it. A command runs
at once while a reply is being written and does not start a reply of its own.
A command works from every client because `chat:send` handles it.

A chat's skills are typed as `/name rest` too. A bot chat can type its bot's
skills; a repository chat can type the skills its `dev.json` gives it. When the
name is not one of operad's commands, the line is an ordinary message to the
agent: an agent that loads skills itself gets `/name rest` unchanged, and any
other agent gets the skill's `SKILL.md` body in the prompt, after a line naming
the skill and before `rest`. The transcript keeps the line as typed. A skill
whose name is an operad command yields to the command. The chat's view carries
`skills: [{ name, description? }]` beside its actions, so a client shows the
skills and the commands from one `GET /v1/objects/<id>` (or MCP `show`); each
description comes from `SKILL.md`.

A message is an event: source `ios`, `telegram`, `cli`, `tui` or `other`, key is
the message id, object is the chat. A scheduled prompt's first message has the
source `bot`, and the bot plugin's own rule starts `chat:reply` for it. The
`chat` plugin's own rule starts `chat:reply` for the client sources
automatically; a rule of yours in `triggers.json` with the same source and type
replaces it. The reply reads the messages no reply
answers yet from the chat's own record, continues the agent session, records the
reply, and goes round again while new messages still wait (at most 20 rounds).
An ordinary message sent during the reply is given to an agent that takes
messages mid-run in the same reply; a command still runs at once and never
reaches the agent. After a restart a reply that was already recorded is not
given twice.

The `transcript` section is live: it shows user messages, the agent's
intermediate text, `Thinking`, tool calls with their result, duration and a short
output, and the final reply. It shows a reply's lines and any message the reply
takes during it in the order they happened: what the agent did before the
message stays above it and what it did after stays below it, and the message
that started the reply stays above all of them. A message the reply does not
take waits for the next round and shows below the finished reply. An older chat
whose lines were recorded without a time keeps the order it was recorded in. It
also carries how
full the agent's context is
(`used`, the model's `window` when known, and the `model`) from the last
finished reply; the chat's object view carries the same `context`. A new session
leaves it out until the next reply. The clients label it with the approved words
**Context used** and **上下文用量**. A reply that fails leaves one line saying it failed
and why, so a failure is not mistaken for a slow reply. Tool output is cut in the
transcript; the full output is in a file in the chat's directory. A reply that is
still being written shows its unfinished text and thinking as a `tail`; `mark`
and `after` let a client append only the finished part (see
[Reading a section](http.md#reading-a-section)). While a `pi` chat waits to try
a failed model request again, the live section also carries `retry`: the attempt,
how many there are, when the next one starts and the provider's reason, so a
client can count down.
The records do not depend on the agent's own session files, so a cleaned or
compacted session does not erase the chat's history; the agent's context still
belongs to the agent, which continues its own session.

A chat's filters are `open` (the default) and `closed`; the kernel adds `all`,
so `operad list chat --filter all` still shows closed chats. A chat on a
repository works in the main clone, read-only: a shell command runs there only
when it is on a short list of commands that only read (`git status`, `ls`,
`cat`, `grep`, `sed -n`, `bun test`, ...); every other command, and every write
or edit, becomes the worktree question, which names the command or the path.
The question offers Allow once (this call only), Always allow (the exact call
and working directory go into `access-user.json`, so it is not asked again in
any chat), Deny, and opening a worktree. Deny tells the agent the call was
refused because the chat is read-only, and that it should answer in the chat or
use read-only commands. The worktree offer has `dev` open `work/chat-<id>`, and
the chat works there from then on, once; the main clone otherwise stays
read-only. The reply that asked ends, and the same message is answered again in
the worktree, so the agent continues there with write access. A yes that comes
after the reply has ended opens the worktree but starts no second reply. The
transcript says `This chat now works in a worktree.` once. The worktree's changes
reach main only through a task that points at it, through the normal gate and
integrate.

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

### Access level

Every chat has an access level: `plan`, `ask`, `edits` or `full`. `/access
<level>` changes it, or `operad chat:access <chat> --level <level>`; the level
is recorded on the chat and every tool call from then on uses it, including a
reply already being written, across restarts and clients. A question open when
the level changes is checked again under the new level. A repository chat starts
at `plan` (read-only) and a bot chat at `ask`. The row shows the level when it
is not the chat's starting level. A repository chat that still works in the main
clone and is raised to `edits` or `full` first opens `work/chat-<id>` and moves
there; if the worktree cannot be opened the level stays as it was and the
command says why. A chat already in its worktree applies the level there. `plan`
and `ask` never open a worktree, and `ask` in the main clone keeps the worktree
question for a write. A bot chat at any level works in the bot's own directory,
with no worktree.

| Level | What runs without asking |
|---|---|
| `plan` | Reading, and commands known to only read; a write asks. |
| `ask` | Reading; every write and every command not known to only read asks. |
| `edits` | Reading and writing files in the working directory; a command not known to only read asks. |
| `full` | Everything the profile does not deny; the level adds no question. A command the matcher cannot follow (inline code, a shell expansion, a path after a directory change it cannot follow) runs too, unless a deny plainly matches. |

The profile's deny lists and its own ask rules still hold at every level,
`full` included. At `full`, an `askCommands` or `askPaths` rule still asks when
it plainly matches, and a background run still asks before an outward write. The
approved words in the interface are **Access** for the menu, and **Plan only**,
**Ask each time**, **Accept edits** and **Full access**
for the levels. `claude` and `pi` carry every level; a chat whose agent cannot
carry a level refuses the reply with a message naming the level instead of
ignoring it. See [Access](access.md) for the profile itself.

## Bots

The `bot` plugin has no tab. Its objects live under Settings: a bot page is that
bot's settings page, and the bots are listed in a section named Bots. A bot is
written in `config.json` under `plugins.bot.settings`; the `default` bot exists
even when it is not written. The section is read at every use, so an edit
applies to the next reply without a restart.

A bot is created by the `bot:create` action on an existing bot. It takes the
new bot's `name` and `agent`, optionally its `model`, `effort` and `speaker`,
and the skills and MCP servers to give it. The skills offered are the ones
another bot already mounts and the skills in `~/.agents/skills` when it exists;
a path may be given instead. The MCP servers offered are the ones a person
already approved on another bot: each is copied with its pin, tools, digest and
secret names, and is not asked about again. The new bot has exactly what was
chosen; nothing is inherited from `default`, and one that chooses none has no
skills and no servers. A name is checked like any bot name, and an existing one
is refused. The result opens the new bot, and names the secrets a copied server
needs before it starts. The page of the new bot shows its skills by name and its
MCP servers.

| Key | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `bot.bots` | object | `{ "default": {} }` | One entry per bot name | Read when a bot is resolved, every reply. A bot removed from the map is marked removed and its chats stop answering. |
| `bot.bots.<name>` | object | `{}` | The keys below | One bot. A name is lowercase letters, digits, `-` and `_`, and starts with a letter or digit; any other name is `bot "<name>": a name is lowercase letters, digits, "-" and "_", and starts with a letter or digit`. |
| `bot.bots.<name>.cwd` | string | `$OPERAD_HOME/bot/<name>`, so `$OPERAD_HOME/bot/default` for `default` | A path | The working directory of the bot's chats. It must be inside `$OPERAD_HOME/bot` or outside the operad home; another path is refused when the bot is resolved. A bot directory has a `memory/` directory, made when missing. |
| `bot.bots.<name>.harness` | string | the first loaded agent | A loaded agent name | The agent a new chat uses when it names none. An unloaded name is refused when a chat opens: `agent "<name>" is not loaded; the loaded ones are: …`. |
| `bot.bots.<name>.useOwnSettings` | boolean | `false` | `true`, `false` | Every reply: when `true`, the bot's agent reads your own configuration of that agent (see [Using your own agent settings](#using-your-own-agent-settings)). The bot's access profile still refuses what it refuses. |
| `bot.bots.<name>.skills` | array of strings | `[]` | A directory with a `SKILL.md`, a directory whose direct subdirectories each hold one (such as `~/.agents/skills`), or a `.agents` directory (such as `~/.agents`) whose `skills` directory is read that way; a relative path is under the working directory | Every reply; every skill directly inside a listed directory is given to the agent, including one added later, and the agent may read but not change it. A missing or unreadable skill is reported at the reply. |
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

### Using your own agent settings

A bot has `useOwnSettings`, titled **Use my own agent settings**, off by default. When it is on, the bot's agent reads your own configuration of that agent. The switch is read at every reply, including for messages that arrive from a channel such as Telegram; with it off nothing changes for `claude` or `pi`.

**claude.** The settings from `~/.claude/settings.json`, project and local Claude settings, `CLAUDE.md` instruction files, auto memory, allow and deny rules, hooks, skills, commands, subagents, plugins and MCP servers. Telemetry, error reporting and background tasks stay off, and a reply is still one foreground turn. Before any allow rule in your settings can approve a tool call, the call is judged in the `PreToolUse` hook the claude harness already runs: a path, command or read-only refusal of the profile denies it. A call the profile allows and your settings allow runs without a question; a call the profile says to ask is asked through operad as before. operad's own tools, the skills the bot lists, the MCP servers the bot lists and its log hooks stay; when both sides define a skill or an MCP server, operad's is the one used. The MCP servers in your own Claude configuration are available to the bot without the bot's MCP approval. Hooks from your settings run on the bot's tool calls after it is on, and the bot's access profile is judged first.

**pi.** Your pi settings and resources from your pi directory (`~/.pi/agent`, or what pi's `PI_CODING_AGENT_DIR` names): settings, context files (the global `AGENTS.md` of pi and those pi finds from the working directory), skills, prompt templates and extensions. Nothing is copied into operad's directory. The session stays operad's, under the operad home, so a chat still finds it; the model and login are yours as before. operad's inline extension and tools stay, and a skill the bot lists wins a skill of the same name in your pi. Every tool call, including one from a tool your extension added, is judged by the access profile in the `tool_call` hook before it runs; a tool the profile cannot check is refused while the profile has rules. An extension also runs its own code in the worker process: code it runs at load, its own child processes and its own network calls are not tool calls and cannot be stopped by the profile. Your pi's compaction settings stay off. A chat reply turns pi's automatic retry on, using your attempt count and delays when your pi settings name them and pi's defaults otherwise; a task keeps it off.

**codex.** Codex reads your own Codex configuration whether the switch is on or off, because a bot starts your own `codex app-server`: `~/.codex/config.toml` with its model defaults, hooks, rules and MCP servers, the `AGENTS.md` instruction files Codex reads, and the project settings it applies there. operad adds its thread sandbox, approval policy and MCP servers. The switch changes nothing here. The access profile answers the approvals Codex asks operad about; a command that stays inside Codex's own sandbox is bounded by that sandbox, not by the profile.

**radian.** Radian reads your own radian configuration whether the switch is on or off, because a bot runs your `radian exec`: `RADIAN_CONFIG` or `~/.radian/config/config.toml` with its model, permissions, skills, hooks and MCP servers, the global and project context files it discovers (`AGENTS.md` and the other names it reads), and trusted project resources. operad gives it a copy of that config with its `PreToolUse` hook and its own MCP config. The switch changes nothing here.

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
  changed;
- a scheduled prompt (`bot schedule`): adding, changing or removing one entry,
  shown with its name, schedule in words and as cron, prompt, model and effort.

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

`operad bot schedule <bot> add|edit|remove <name>` proposes a change to the
bot's scheduled prompts. `add` needs `--schedule <cron>`, `--words <schedule in
words>` and `--prompt <text>`; `edit` needs at least one of `--schedule`,
`--prompt`, `--model` and `--effort`, with `--words`; `remove` takes the name and
`--words`. Optional `--model` and `--effort` set or clear those fields. It prints
`proposed scheduled prompt "<name>" for bot <bot>; review it in pending`. A
chat's agent calls this command through operad's `command` tool; a schedule it
writes is a proposal, never an immediate entry.

### Scheduled prompts

A bot can hold scheduled prompts. The user word is **Scheduled** (Chinese
定时任务). An entry has a name, a five-field cron schedule in the machine's local
time zone, the prompt, an optional model and effort, and whether it is paused.
The bot page lists the entries with their next run and the last run's result and
chat id.

To schedule something from a chat, say it in words ("every morning at 8, collect
the day's news"). The bot writes a proposal with the name, the schedule in words
and as a five-field cron expression, the prompt, and the model and effort. It
waits in Pending: `bot:approve` adds it, `bot:reject` drops it, and until then no
entry exists. Editing or removing an existing entry from a chat is a proposal
too; a change made through the actions below is your own edit and applies at
once.

```sh
operad bot:schedule-add default --name Morning --schedule "0 8 * * *" --prompt "Collect the day's news."
operad bot:schedule-edit default --name Morning --schedule "0 9 * * *"
operad bot:schedule-pause default --name Morning
operad bot:schedule-resume default --name Morning
operad bot:schedule-remove default --name Morning
```

| Action | Arguments | What it does |
|---|---|---|
| `bot:schedule-add` | `name`, `schedule`, `prompt`, optional `model`, `effort`, `paused` | Adds an entry. The name is unique on that bot; the schedule is a five-field cron expression in local time. |
| `bot:schedule-edit` | `name`, optional `schedule`, `prompt`, `model`, `effort` | Changes an entry. A changed schedule starts fresh, so no time missed under the old schedule is caught up. |
| `bot:schedule-pause` | `name` | Stops it firing; a paused entry collects no missed times. |
| `bot:schedule-resume` | `name` | Lets it fire again at its next planned time. |
| `bot:schedule-remove` | `name` | Deletes it. |

When an entry fires, the bot opens a new chat under itself, titled with the
entry's name and the date, and sends the prompt as the first message. The chat
runs as the bot, with its skills, MCP servers and access profile. It is a
background run: an outward write asks, and the access rules for a run no person
started apply. You can keep talking in the new chat.

After `serve` has been down or the machine has slept, the latest missed run in
the last seven days fires once; older ones are skipped. A catch-up run adds one
line to the prompt saying when it was planned and how late it runs.

When the reply ends, the entry's last result is a short summary of it, and the
`notify` command runs with that summary as `OPERAD_REASON` (see
[Notifications](notifications.md)). A failed reply records and notifies its
failure line instead.
