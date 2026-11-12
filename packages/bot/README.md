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
digits, `-` and `_`. Fields: `cwd`, `harness` (the default agent), `skills`,
`speaker`, `access`.

- **Working directory**: `~/.operad/bot/` for `default`, `~/.operad/bot/<name>`
  for another bot, created when missing. A `cwd` that is the operad home, holds
  it, or is inside it outside `bot/` is refused: the chat works in a
  subdirectory, never the home.
- **Access profile**: the default one (no credentials, no shell profile writes, no
  `operad` command; the agent uses operad's tools) plus what the bot adds. A bot
  can tighten it, never loosen it. Everything in the operad home except `bot/` is
  in `denyPaths` (what is there now, and `store`, `secrets`, `config.json`), so
  the fact log, secrets and the token are out of reach. The bot's skill
  directories, and `<cwd>/skills`, are in `denyPaths` too: the agent proposes a
  skill through operad's tools and never writes one itself.
- **Skills**: directories with a `SKILL.md`, given to the agent as `skills` in
  its step params. A missing `SKILL.md` fails the reply and names the directory.
- **Speaker**: how a chat of this bot labels the model's messages in its
  transcript; without it, the chat plugin's `speaker` is used.

## `bot:chat <bot> [--agent <name>] [--title <text>]`

Creates a `chat` with the bot as parent, titled `Bot (<name>)` unless given a
title. The agent is the one given, else the bot's, else the first loaded one;
it is fixed once chosen. The chat reaches repositories only through operad's
tools (`operadTools`) and `dev`'s verbs, never by editing their files: the paths
of the repositories `dev` knows are in `denyPaths` (read again at every reply, so
a repository added later is covered), its directory is not a repository and
`operad` is a denied command.

At every reply the chat runs the step `bot/settings`, which reads `config.json`
again: tightening access or adding a skill applies to the next reply of the same
chat. A bot taken out of the settings, or one that cannot be used, fails the
reply; it is never answered from an older copy.

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

Each proposal is one pending item of its bot, with the actions `Review`,
`approve` and `reject`. `Review` shows the change: the full `SKILL.md`, the file
list with scripts apart and, for a changed skill, the diff; a settings proposal
shows the settings before and after. `approve` applies the change and `reject`
leaves every file and setting as it was. Nothing changes until the person acts,
and an unanswered proposal neither changes anything nor blocks the chat.

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
person (`Review`, `approve`, `reject`). `Review` lists the command, the package
and its pinned version, the tools the server offers (name and description) and
the secrets it needs, and says that **approving trusts the package**: it runs on
your machine as you and nothing contains it yet (there is no shell). The tools
are read by starting the server once, in the bot's working directory with a bare
environment (`PATH`, `HOME`, `TMPDIR`, `LANG`) and the bot's access profile
applied to the command; a server that does not start is not proposed.

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
