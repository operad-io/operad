# `@operad-io/bot`

The `bot` plugin. Its object is a **bot**: a working directory, a default
agent, skills, a speaker and an access profile. A bot is one row in lists and
the parent of its chats. The chat itself belongs to the `chat` plugin.

Optional: `operad plugin enable bot`.

## Settings

The `bot` section of `config.json` (`plugins.bot.settings`), checked against
`bot.schema.json` and editable through the settings interface:

```json
{ "bots": { "reader": { "harness": "pi", "speaker": "Nova", "skills": ["~/skills/brain"], "access": { "readOnly": true } } } }
```

`default` exists even when it is not written. A bot name is lowercase letters,
digits, `-` and `_`. Fields: `cwd`, `harness` (the default agent),
`useOwnSettings`, `skills`, `speaker`, `writeWiki`, `tidyTime`,
`runWithoutAsking`, `backgroundModel`, `mcpServers`, `mcpAllow` and `access`.

- **Working directory**: `~/.operad/bot/<name>` for every bot, so the default
  bot is in `~/.operad/bot/default`, created when missing along with its
  `memory/`. A `cwd` that is the operad home, holds it, or is inside it outside
  `bot/` is refused: the chat works in a subdirectory, never the home. A bot's
  memory lives in `memory/` inside its directory; the knowledge base is shared
  and is not part of a bot's directory. An old home at `~/.operad/bot/` keeps
  every entry a person or the bot put there. Only `skills/` and `memory/`, which
  operad made there, move into `default/` when the bots are read; an entry that
  is another bot's directory is left alone. The move is idempotent and each
  entry is renamed, so a crash halfway leaves the rest for the next read; when
  both homes hold the same file, the new home's copy stays. A home with no old
  directory is marked handled once, so its journals are not read again. The
  default bot keeps read and write access to the rest of `~/.operad/bot`,
  except every other bot's directory. A grant whose `cwd` is exactly the old
  home is rewritten once to `default/`, in `access-user.json` and any per-bot or
  per-repo `access-user.json` the home knows; other grants keep their bytes. A
  bot whose settings name a `cwd` keeps it and no move happens.
- **Sessions after the move**: `claude` finds a session under the project
  directory named for its working directory, so its old project directory is
  moved beside the new one. `pi` stores a session file path under the operad
  home and `codex` resumes a thread id in its own home, so neither depends on
  the working directory. `radian` binds a session to the workspace recorded in
  its journal, so the old workspace is rewritten to the new one in the journals
  that name it. Claude's project directory waits while a kept claude worker is
  alive; the next read retries it.
- **Access profile**: the default one (no credentials, no shell profile writes, no
  `operad` command; the agent uses operad's tools) plus what the bot adds. A bot
  can tighten it, never loosen it. Everything in the operad home except `bot/` is
  in `denyPaths` (what is there now, and `store`, `secrets`, `config.json`), so
  the fact log, secrets and the token are out of reach. The bot's own directory,
  including its `memory/`, is what it may use; every other bot's directory is in
  `denyPaths` for reading and writing. The bot's skill directories, and
  `<cwd>/skills`, are in `denyPaths` for writing and in `readPaths` for reading:
  the agent can read a skill but proposes a change through operad's tools and
  never writes one itself.
- **Use my own agent settings**: `useOwnSettings` is off by default. With it
  on, the bot's agent reads your own configuration of that agent. For `claude`
  that is your settings, `CLAUDE.md` files, memory, skills, commands, subagents,
  plugins and MCP servers. The bot's access profile still refuses what it
  refuses, judged before any allow rule in your settings; operad's own tools,
  the skills the bot lists, the MCP servers the bot lists and its log hooks
  stay, and a name both sides define is operad's. It is changed like any other
  bot setting, through a proposal.
- **Skills**: a directory with a `SKILL.md`, given to the agent as `skills` in
  its step params. A listed directory whose direct subdirectories each hold a
  `SKILL.md` (such as `~/.agents/skills`) gives every one of them, and a
  `.agents` directory (such as `~/.agents`) gives the skills in its `skills`
  directory. Every skill is read again at each reply, so one added later is
  included. A missing `SKILL.md` fails the reply and names the directory.
- **Speaker**: how a chat of this bot labels the model's messages in its
  transcript; without it, the chat plugin's `speaker` is used.

## `bot:chat <bot> [--agent <name>] [--model <name>] [--effort <level>] [--title <text>]`

Creates a `chat` with the bot as parent, titled `Bot (<name>)` unless given a
title. The agent is the one given, else the bot's, else the first loaded one;
it is fixed once chosen. The model and effort are the ones given, else the
bot's own, else the agent's default; each must be one the agent lists and can
change later. The chat reaches repositories only through operad's
tools (`operadTools`) and `dev`'s verbs, never by editing their files: the paths
of the repositories `dev` knows are in `denyPaths` (read again at every reply, so
a repository added later is covered), its directory is not a repository and
`operad` is a denied command.

At every reply the chat runs the step `bot/settings`, which reads `config.json`
again: tightening access or adding a skill applies to the next reply of the same
chat. A bot taken out of the settings, or one that cannot be used, fails the
reply; it is never answered from an older copy.

The step also returns the bot's `memory/index.md` and `memory/instructions.md`
as `notes`, read through `memoryNotes` from the memory plugin. The chat puts
them on the message, whole for a new session or after a compaction and only
when changed since the session last saw them otherwise (ADR 0026 D18). The
index carries `maxChars` 8,000, the plugin's `MEMORY_INDEX_MAX`.

## `bot:create <bot> --name <name> --agent <agent>`

Creates a new bot with exactly the skills and MCP servers chosen. The model,
effort and speaker are optional. A known skill is chosen by name from the ones
another bot mounts and the ones in `~/.agents/skills`; a path may be given
instead. An MCP server is chosen from the ones a person already approved on
another bot and is copied with its command, pinned version, tools, digest and
secret names, without a second question. Nothing is inherited from `default`;
with no skills or servers chosen the new bot has none. The name is checked like
any bot name and an existing one is refused. The result opens the new bot and
names any secrets its servers need before they start.

## A bot changes itself only through a proposal

A bot does not write its skills or `config.json`. Its access profile denies
those paths, so a direct write is refused like any other denied path. It asks
for the change through operad's own tools instead. An agent with operad's MCP
tools calls the `command` tool:

```json
{ "plugin": "bot", "verb": "skill", "args": ["default", "brain"],
  "input": "{\"skill_md\": \"---\\nname: brain\\n---\\n...\", \"files\": {\"scripts/save.sh\": \"...\"}}" }
```

`bot skill <bot> <name> [--from <dir>]` proposes a new or changed skill. Without
`--from`, its stdin is JSON with `skill_md` and an optional `files` map; with
`--from`, it reads that directory. A changed skill is the one the bot already
mounts under that name; a new one goes to `<cwd>/skills/<name>` when approved.
Files under `scripts/`, and executable files, are listed as scripts.

`bot setting <bot>` proposes a change to the bot's settings. Its stdin is a JSON
object with the fields to change (`speaker`, `harness`, `skills`, `access`, and
so on); the fields it does not name keep their value. The kernel validates the
result against `bot.schema.json` before the proposal exists.

`bot schedule <bot> add|edit|remove <name> [--words <text>] [--schedule <cron>]
[--prompt <text>] [--model <model>] [--effort <effort>]` proposes adding,
changing or removing a scheduled prompt. `add` needs the cron expression, the
same schedule in words and the prompt; `edit` needs a field to change and the
schedule in words; `remove` takes the name and the schedule in words. An empty
`--model ""` or `--effort ""` clears that field. The proposal shows the name,
the schedule in words and as cron, the prompt, the model and the effort, and no
entry is written before a person approves it.

Each proposal is one pending item of its bot, with the actions `approve`,
`reject` and `Review`, in that order: a client's main button is `approve`. The
proposal's Review section already shows the change, so `Review` stays for the
command line and MCP. `Review` shows the full `SKILL.md`, the file list with
scripts apart and, for a changed skill, the diff; a settings proposal shows the
settings before and after. `approve` applies the change and `reject` leaves
every file and setting as it was. Nothing changes until the person acts, and an
unanswered proposal neither changes anything nor blocks the chat.

An approved skill is on disk before the approval returns, so the bot's next
reply reads it (`bot/settings` already reads `config.json` again at every
reply). A settings proposal is written to `config.json` the same way. A run
nobody started on the spot, such as a scheduled or event-started run, can make
the same proposals; it still cannot approve one.

## Telegram

Chats bound from Telegram are not built here. When they are, they open with
`openChat` on `default`; a rule that names another bot goes in the same place.

## MCP servers

A bot can use local MCP servers: a command with arguments, started on this
machine. Remote servers (an HTTPS address) are not supported yet. operad talks
to no marketplace and does no search; you bring the command.

`bot mcp <bot> <name> <command> [args...]` proposes a server. With no command,
stdin is a pasted `mcpServers` entry of the same form (a whole `mcpServers` map
works when it holds one server or one called `<name>`):

```
operad bot mcp default notes npx -y @acme/notes-mcp@1.2.3
echo '{"mcpServers":{"notes":{"command":"npx","args":["-y","@acme/notes-mcp@1.2.3"],"env":{"TOKEN":"…"}}}}' | operad bot mcp default notes
```

An agent with operad's MCP tools calls the `command` tool the same way as for
a skill. Registering is a pending item of the bot, never applied without a
person (`approve`, `reject`, `Review`, in that order). `Review` lists the
command, the package and its pinned version, the tools the server offers (name
and description) and the secrets it needs, and says that **approving trusts the
package**: it runs on your machine as you and nothing contains it yet (there is
no shell). The tools are read by starting the server once, in the bot's working
directory with a bare environment (`PATH`, `HOME`, `TMPDIR`, `LANG`) and the
bot's access profile applied to the command; a server that does not start is
not proposed.

- **Pinned versions only.** A package runner (`npx`, `bunx`, `pnpm dlx`, `uvx`,
  …) must name an exact version, `name@1.2.3`. `@latest`, a tag, a range
  (`^1.2.0`, `1.x`) or no version is refused with a message saying to pin it, and
  the server is not started. A command that is not a package runner (a program
  or script you already have) has no version to pin.
- **Upgrades.** Registering the same name again is its own pending item, showing
  the version and the tool-list change (added, removed and changed tools).
- **Settings.** On `approve` the server is written to the bot's `mcpServers`
  setting (`command`, `args`, `package`, `version`, `secrets`, `tools`, `digest`;
  see `bot.schema.json`). The digest is of tool names and descriptions. `bot
  setting` cannot add or edit `mcpServers`; only this review can.
- **Secrets.** The names of the environment variables a server needs are kept
  (from the `env` keys of a pasted entry); the values never are. A value pasted
  with the entry is used once, to start the server for the tool list, and then
  dropped. Store each value with `operad secret set bot <name>.<VARIABLE>`. The
  value reaches the server only at its start, from the bot plugin's secrets, in
  the server's environment: not in the transcript, not in the agent's
  environment, not in the settings the harness is given.
- **What a chat mounts.** Only the servers in the bot's `mcpServers`, and only
  on the harnesses that take MCP servers natively: `claude` and `radian`. A chat
  on `pi` does not mount them, and the bot's page says so rather than leaving it
  silent. Each server is started through a guard (`src/guard.ts`) that the
  harness runs in its place; the guard starts the real server and holds its
  secrets.
- **A server whose tools change is switched off.** Each time a chat starts a
  server, and each time the agent asks for its tool list, the guard compares the
  tool names and descriptions with the stored digest. If one differs, the guard
  offers no tools for that server, refuses calls to it, and leaves a report;
  the bot plugin turns the report into a pending item that shows the difference
  (`+` added, `-` removed, `~` changed with before and after). The chat goes on
  without the server. `approve` accepts the new tools and switches it on;
  `reject` keeps it off, and the same list is not proposed again.
- **Tool results are material.** The text a tool returns is passed to the agent
  after a line saying it is material from an MCP server, not instructions.
- **Calling a tool asks.** The bot's access profile carries `allowMcp`, the tools
  that run without asking (`<server>.<tool>` or `<server>.*`), set from the bot's
  `mcpAllow` setting (changed with `bot setting`, so a person approves it). A tool
  not listed counts as a write and asks first, as one-time or always-allow
  permission like any other call. `radian` cannot ask, so it refuses a tool that
  is not listed.

## Scheduled prompts

The `bot` plugin is also its own source for scheduled prompts. Each entry is
stored on its bot object (`scheduled`), so the source and the actions read and
write the same place without a `serve` reload. An entry is `name`, `schedule`
(a five-field cron expression in local time), `prompt`, optional `model` and
`effort`, `paused`, and the last firing (`plannedAt`, `firedAt`, `schedule`,
`chatId`, `result`, `notified`).

The source checks once a second, fires the latest planned minute at or before
now, and catches up the latest missed minute in the last seven days after
`serve` starts or the machine wakes. A firing calls `bot:chat` with the actor
`{ via: "bot", id: <entry name> }`: the new chat starts at the access level
`full`, so only the profile's deny rules, `readOnly` and a write under
`readPaths` can stop a call; a person may change the level with `/access`
afterwards. The new chat's first message has the event source `bot`, which the
bot's own rule sends to `chat:reply` as a background run, and the chat's data
records `scheduled: { bot, entry }`. At `full` the background flag adds no
outward question. A catch-up firing appends `latenessLine` to the prompt.

The source watches the new chat's facts. On the first assistant message, or on
a failure entry, it records `replySummary` as the entry's `result`, runs the
`notify` command from `config.json` with the summary as `OPERAD_REASON`, and
marks `notified`. A firing whose reply ended before `serve` stopped is found the
same way at the next start; a command that fails is logged and not retried.

Actions: `schedule-add`, `schedule-edit`, `schedule-pause`, `schedule-resume`
and `schedule-remove`, all on a bot. The adding and editing arguments are
`name`, `schedule`, `prompt`, `model` and `effort`; the others take `name`.
A name is unique on the bot. A changed schedule drops the old last time, so the
next run is calculated fresh.

A schedule asked for in a chat goes through `bot schedule`, not through these
actions: the chat's agent turns the words into a five-field cron expression and
the proposal waits in Pending until a person approves it. `bot/settings` returns
the line a bot chat starts with, saying that a schedule is proposed this way.


## The nightly memory tidy

`BotTidySource` is the bot's second source. It creates one `bot-tidy` object per
bot (`TIDY_TYPE`, id the bot name) with the last planned check and the card's
state. `tidyTime` (`03:30` by default) is read in local time, and a missed night
is caught up once by checking only the latest planned time. The first check only
sets a baseline. `tidyWork` reads `memoryTidyState` from the memory plugin and
the bot's chats since the last tidy commit; a night with no changed note and an
index under its limit writes no card and calls no model. It also refreshes the
link index and asks `linkReport` for the wiki and this bot's memory. Those lists
never decide whether a run happens; when every list is empty the prompt gains
nothing about links.

With work and `runWithoutAsking` off, the object becomes a pending card. Its
actions are `run` and `skip`, offered by the plugin on `TIDY_TYPE`; `tidyItems`
turns the pending, result and failed states into the bot's pending items. `run`
only marks the card requested, because an action has no client to open a chat;
the source starts the chat on its next poll, and waits while any chat of the bot
is writing a reply. The model is `backgroundModel`, else the harness's declared
`capabilities.backgroundModel`, else the bot's model.

The tidy chat is opened through `bot:chat` with the actor
`{ via: "bot", id: TIDY_ORIGIN }`, so its chat data records the tidy origin and
the memory plugin commits it as `tidy:`. The prompt carries the changed notes,
the period's chat records and, when there is link work, the wiki's and the bot
memory's broken links with their source lines, orphans, targets three or more
notes link to, and unlinked mentions, with guidance to fix a clear broken link,
leave a link to an unwritten page, consider linking an orphan, and suggest but
not force linking a mention. A note marked `untrusted: true` is left out of
those lists, so the tidy is never pointed at one to link. The source watches for the memory plugin's
`memory.tidy` fact and then reads the run's diff summary, from the last tidy
commit to the tidy commit. A non-automatic run leaves a result card with the
cost and diff; a failure leaves a failed card. An automatic run returns to idle
and calls `notify` when the run changed something or the run failed. A card left
running without a chat, such as after a crash between starting the chat and
recording it, becomes a failed card on the next start.
