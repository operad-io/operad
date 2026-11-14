# Changelog

All notable changes to operad are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and operad uses
[Semantic Versioning](https://semver.org/). Every `@operad-io` package carries
the same version.

## [0.1.1] - 2026-11-14

### Fixed

- `operad init` now installs `pool`, which `dev` needs to run workers. Without
  it no task started.
- The README quickstart now starts the task: a new plan's auto level is off, so
  it runs `operad dev:auto <plan> --level run`.
- Two commands in the user manual were wrong: `operad show <id> --section` and
  `operad chat:model`.
- A task cancelled while the batch it was claimed into was being pushed could
  still be merged with that batch. Cancelling and the push now take turns: either
  the batch lands without the task, or the cancel says the task was already
  merged.
- When `operad serve` stopped after a merge moved the main clone but before the
  repository's `prepare` lines finished, they were not run again on restart.
  They now finish after the restart.

### Changed

- A worker's fallback no longer takes over when the harness step fails with an
  error. It is used only when the model is unavailable, the quota is used up, or
  the harness cannot start.
- The docs write the dev commands with the dev prefix (`operad dev repo add`,
  `operad dev plan add`, `operad dev task add`), and the message for a missing
  repository says `operad dev repo add <path>`.

## [0.1.0] - 2026-11-13

The first public release. Install it with `bun add -g @operad-io/cli`; it needs
[Bun](https://bun.com), `git`, and one of `claude`, `pi` or `radian` on your
`PATH`. operad is in development, so expect rough edges.

### Kernel

- Three words are all a user of the kernel sees: **flow** (the path a piece of
  work follows), **pending** (everything that waits for a person, each item with
  the actions its plugin offers) and **history** (what each step did, and why).
- Work is kept on disk in the home (`$OPERAD_HOME`, by default `~/.operad`). A
  run that was stopped, or whose process was killed, continues where it left off
  when `operad serve` runs again.
- `operad init`, `operad serve` (and `operad serve stop`), `operad pending`,
  `operad list`, `operad show`, `operad history`, `operad settings`,
  `operad secret`, `operad trigger` and `operad plugin` (list, enable, check)
  work on any plugin without a change to the command line. A plugin's actions
  appear as `operad <plugin>:<action>`.
- Triggers start flows from an event, such as a message, on rules you write in
  `triggers.json`.
- `config.json` and the other configuration files are JSON, each with a schema.
- `serve` reloads when the code it runs changes, and `operad pending` says when
  it runs older code than the files on disk.
- Plugins are TypeScript files loaded without a build step. `operad plugin check`
  type-checks one before it runs, and a plugin can require other plugins by
  version range. The plugin guide is in `docs/plugins/`.

### The dev plugin

- Plans and tasks on a repository, from a request to a merge: `operad plan add`,
  `operad task add`, `operad dev:confirm`, `operad dev:merge`, `operad dev:reject`,
  `operad dev:rework`, `operad dev:cancel`.
- Each task gets its own git worktree and a brief. A worker commits there.
- The commands you list in `.operad/dev.json` check the commit. A check that
  stops writing is stopped, and a test that only times out is run again alone.
- A reviewer reads the change and writes a report. Findings send the task back
  for rework, up to a limit. The reviewer can have a list of fallbacks tried in
  order.
- Any agent can work and any agent can review, chosen per repository in
  `.operad/dev.json`.
- A setup prompt (`docs/user/setup-prompt.md`) has your coding agent write and
  check `.operad/dev.json` for you.
- `operad dev:chat` opens a chat on a repository. It is read-only until you
  agree to open a worktree.

### Chat and bot

- A chat is a long conversation with an agent. Messages from the command line,
  the terminal client, the phone app or Telegram land in one transcript that
  operad keeps itself, so it does not depend on the agent's session files.
  `chat:send`, `chat:model`, `chat:effort` and `chat:close` act on it.
- A bot is a working directory, a default agent, skills, an access profile and
  MCP servers for chats that are not about a repository (`operad bot:chat`).
  A bot can only propose a change to its own skills, settings or MCP servers;
  the change waits in pending until you approve it.
- Access profiles say which tool calls an agent may make, and "always allow"
  remembers your answers (`access-user.json`).

### Pool

- Workers shared by runs, so an agent's limits hold across all flows. Pools are
  set up in `.operad/dev.json`.

### Telegram

- `@operad-io/telegram` is optional: `operad plugin enable telegram` and
  `operad secret set telegram token`.
- A listed Telegram user's private messages open and continue a chat on a bot.
  Each reply of that chat is sent back to Telegram, and pending items of a bound
  chat, and of the plugins you list, are sent too. A restart neither repeats a
  reply nor loses one.

### Terminal client

- `operad tui` lists what is pending and running and opens an object beside the
  list. It starts `serve` when none runs, and has themes and keys.

### MCP server

- `operad mcp` is an MCP server on stdio for a lead agent such as Claude Code.
  It reads pending, running and history and takes the actions `config.json`
  allows, but never takes your decision: merge stays with you.

### Agents

- Harnesses for `claude` (Claude Code), `codex`, `pi` and `radian`. operad runs
  your own installation of each and bundles none of them. `operad init` checks
  the ones you enable.

### Phone app

- `operad pair` prints the address and token of `serve` as a QR code for the
  iPhone app. The app shows pending, running and each object's history, answers
  and acts on items, sends notifications, and holds chats. It reaches `serve`
  over the HTTP interface, which listens on loopback unless you name another
  private address; every request needs the token, and
  `operad http token rotate` replaces it. The app itself is not in this
  repository.

[0.1.1]: https://github.com/operad-io/operad/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/operad-io/operad/releases/tag/v0.1.0
