# Changelog

All notable changes to operad are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and operad uses
[Semantic Versioning](https://semver.org/). Every `@operad-io` package carries
the same version.

## [Unreleased]

### Changed

- A new home turns every shipped plugin on: `chat`, `bot`, `memory`, `cron`, `shell`, `pool`, `dev`, `telegram`, `terminal`, `pi`, `codex` and `radian`, and `claude` when `claude` is on your `PATH` (it needs a download).
- `terminal` no longer holds up a start: `operad serve` installs its package once it is serving and reloads. Until then it is not set up (Setup Terminal), and a failed download is tried again at the next start of `serve`. A home you already have is not rewritten: the plugins it lacks show as off in the plugin list and in their setup guides, and you turn one on there or with `operad plugin enable <name>`.
- A plugin that is not set up is quiet. A harness whose agent is not on the machine is not offered as an agent and asks for no login; `operad init` and `operad doctor` say it is not set up, and its setup guide (`/setup codex`, Setup Codex) walks you through it. Telegram without a token no longer logs a failure at each start of `serve`.
- A repository that names no worker uses the first enabled agent that is on the machine.
- `operad init` installs operad's own pi only when it finds no `claude`, `pi` or `radian`.

### Added

- Terminals, the `terminal` plugin (on in a new home; elsewhere `operad plugin enable terminal`): `operad serve` runs any command or your login shell in a repository or one of its worktrees, keeps it when a client disconnects, and replays its screen to a client that comes back. Starting and using one works only from the machine `serve` runs on. See [terminals](docs/user/terminal.md).

## [0.4.1] - 2026-11-24

### Fixed

- The cron source (`operad routines`) is published and loaded by default; 0.4.0 from npm did not have it. A home made by `operad init` from now on loads the cron source. A home made with 0.4.0 runs `operad plugin enable cron` once.

### Changed

- The README and the manual now say that orchestrating agents in operad means composing the flow a task follows, not handing out roles.

## [0.4.0] - 2026-11-24

The release turns scheduled prompts and scheduled flows into Routines, adds
Dreaming, a recap when you come back, `/private`, and a way to start a fresh
session with a brief, and keeps long chats working with segments and
compaction. `operad scheduled` is removed.

### Added

- Routines: one list for what runs on a schedule, bot routines and flow routines
  together, with `operad routines list|add|edit|pause|resume|remove`.
  `operad routines add --command "<line>" --cwd <dir>` runs one command line on
  a schedule through the `shell:command` flow.
- `operad routines to-flow <id>` turns a routine that runs a command into a flow
  file in your home that you can edit (`<home>/flows/<name>.flow.ts`); flows in
  `<home>/flows` load as `home:<file>`.
- A routine's result is delivered to its bot's main chat and shown in the chat
  transcript with the routine's name.
- Dreaming (梦境整理): the nightly memory tidy, now a built-in routine, dates
  the notes it keeps.
- Recap: when you write after being away (`chat.awayMinutes`, 240 minutes by
  default, 0 turns it off), the chat adds one recap of the routine results and
  replies that came meanwhile.
- `/private` in a bot chat starts a stretch that is not remembered; `/private`
  again ends it. Telegram lists it in its command menu.
- `/new` starts a new agent session in the same chat, and `/new <goal>` starts
  it with a short brief of the old one; its first message points to the chat's
  earlier record.
- `/compact`, and automatic compaction of a long chat with the pi agent after
  one silent turn to save memory; old tool results are pruned once the prompt
  cache has expired.
- Segments in a long chat: a divider shows the title and the date.
- A reply shows the memory it wrote and used.
- A chat row shows its channels, including Telegram, and a repository row shows
  its counts as "1 plan · 3 tasks open".
- A set of regression questions can be built from the chat record to check that
  memory still answers with the exact details.

### Changed

- Scheduled flows are Routines too: `operad routines list|add|edit|pause|resume|remove`
  is the command for them, and its output says "routine". `operad scheduled`
  is removed; there is no alias. Config keys such as
  `schedule` and the cron source's ids are unchanged.
- Scheduled prompts are now Routines (Chinese 定时任务): each is an object of its
  own under its bot, with a row (name, bot, next run, last result) and a page
  (prompt, schedule, its runs as history, and edit, pause, resume, Run now and
  remove). A run is no longer a chat: it has no chat id, is not in the chat list,
  and is kept in the routine's history for 30 days. The nightly memory tidy is
  now Dreaming (梦境整理), a built-in routine. The `bot:schedule-*` actions and
  the `bot schedule` command keep their names. Existing routines move over once,
  and the chats the old scheduled prompts and tidies opened are closed once.
- `operad` with no command returns to the default bot's main chat (its Telegram
  chat, else its latest open chat) instead of starting a new one; with no open
  chat it starts one as before. `bot:chat` is how to start another.
- Idle chats that no bot or repository holds are closed after 7 days, and a
  routine's runs older than 30 days are removed together with their records.
- A compaction that leaves the context full is not repeated, and its summary
  keeps the file lists.

### Fixed

- A routine's run no longer appears in chat lists or chat search.
- The memory tidy cannot change `instructions.md` while it runs, and its card
  ends as failed when its run ends without a commit, also after a restart.
- Waiting work finishes before the old store closes when the bot reloads or
  stops, and items already read are kept after a late failure.
- The `/private` lines are shorter and use no internal words.

## [0.3.1] - 2026-11-23

### Fixed

- In a long chat, the oldest replies are no longer cut to nothing: each keeps the
  first two lines of its answer, and the thinking, tool input and other text
  are shortened first.

## [0.3.0] - 2026-11-23

The release lets `dev` work in a folder without git until the first task, adds
a branch way of working next to worktrees, gives bots follow-ups and scheduled
prompts that can run now, and makes Setup Dev's chat readable. Folders without
git, repositories without a remote and machines without git are all accepted.

### Added

- A folder without git, or a machine without git, can be added
  (`operad dev repo add`) and chatted with; the chat may change files there.
  Git is needed only to create a task. Creating a plan or a task, and the step
  that prepares a task's working place, refuse a folder whose git is not ready
  and say in one sentence what to do: install git, set up git here, make the
  first commit, or add the repository's root instead of a subfolder.
- Set up git here: at the first task in a folder without git, the bot proposes
  one pending item with the `.gitignore`, the list of files the first commit
  would hold, and the name and email for it. Approving runs `git init` when
  needed and the first commit of exactly the listed files, and the folder
  becomes a repository that works in a branch with no remote. An existing
  `.gitignore` is kept: a proposal that would drop one of its lines is refused.
  Secret names (`.env*`, keys) must stay ignored. The home folder and a disk
  root are refused, and above 5000 files the item asks to check the
  `.gitignore` first. When git is not installed, the bot's guide walks through
  installing it, each command a pending item.
- `workIn` in `.operad/dev.json`: `worktree` (each task in its own worktree, as
  before) or `branch` (each task on its own branch in the main clone, one task
  at a time). Setup Dev explains the two and asks which to use. A branch-mode
  task holds the main clone until it ends; meanwhile a repository chat is
  read-only there, and a task does not start while a chat reply that can write
  is live.
- A repository with no remote works: merges move the local main branch.
- Follow-ups: a bot's agent can set follow-ups for itself in a chat (at most 5
  per chat, at most 30 days ahead); `operad bot follow-up` and
  `operad bot follow-ups` set, list and cancel them.
- Scheduled prompts: Run now runs one at once without moving its next timed
  run, and is refused while the previous firing is still replying. A scheduled
  prompt can end quietly and carries its last results into the next firing.
  The bot row carries the server's IANA time zone so clients show the next run
  in it.
- `operad doctor` says when git is not installed (chat works without it; a task
  needs it).
- A bot's memory and the shared wiki are plain folders when git is not
  installed, and become repositories, with no question, once it is.
- A task's Review section shows each review round with its fix level.

### Changed

- Setup Dev's chat (and any `Setup <plugin>` chat) shows only its title as the
  first message; the prepared prompt goes to the agent without being shown.
- `.operad/dev.json` is read when an attempt starts and used for that attempt.
- Finding git never opens the macOS install dialog; a missing git is reported
  as "git is not installed" instead of an error.
- The dev list is titled Projects.

### Fixed

- A failed git call (dubious ownership, an unreadable `.git`) is no longer
  taken for a folder without a repository.
- An empty change left by a worker that did not finish (for example stopped by
  a usage limit) goes back to work instead of passing review and reaching
  merge; `dev:reverify` refuses such a task.
- A commit made on the main clone during an attempt is reported.
- In a long chat, a page over its size cap no longer cuts the newest replies:
  the oldest replies are shortened first, and every shortened text is marked
  `cut: true`; reading the page with `full=true` gives it whole.
- A task's retries use the `.operad/dev.json` its attempt started with, like
  its other steps.
- A chat that moved to its worktree is no longer read-only.
- A new chat gets an agent that carries its access level, or is refused at
  creation.
- `operad serve stop` also stops the supervisor, so a reload in flight does not
  start a serve after it.
- The main clone fast-forwards past untracked files.
- Terminal client marks and the folder icon use characters common terminal
  fonts carry.

## [0.2.0] - 2026-11-22

The release adds a first-run path (`operad` alone opens a chat, `operad doctor`
checks the home), memory for bots, access levels for chats, scheduled prompts
and flows, a Codex connection that no longer needs a bridge, and many fixes to
chats and to the `dev` plugin. The default HTTP port changed, so a paired
client needs pairing again.

### Added

- First run: `operad` with no arguments creates the home when there is none,
  starts `serve` when none answers, and opens the terminal client on the default
  bot's new chat. `operad init` enables `radian`, `claude` and `pi` for the
  agent commands it finds on `PATH`, installs `@operad-io/harness-claude` and
  its SDK when `claude` is found, and with no agent found enables `pi` and
  installs operad's own pinned pi in the home.
- `operad doctor` checks the home and changes nothing: the config, each enabled
  plugin, each agent with its version and whether it is signed in, whether
  `serve` answers and the test host. A problem line ends with the command to
  type next, and the command exits `1` when any line is a problem. A bot whose
  agent is not signed in offers `operad bot:login <bot>` for the agents operad
  can log in to, and a pending item says so too.
- The ChatGPT plan login is pi's own command, `pi auth login openai-codex`:
  operad does not run that login itself. The bot login offers API keys only and
  tells where to run the command (the full path of operad's own pi when `pi` is
  not on `PATH`); operad picks the login up once it is done, with no restart of
  `serve`.
- Setup guides: a plugin can ship a guide (`guide`, a `SKILL.md`) and a `check`
  that returns what is missing, item by item. A bot follows only the steps for
  what is missing: `/setup <plugin> [target]` in a bot chat, the `bot:setup`
  action, and `operad bot setup <bot> <plugin> [target]`. `GET /v1/plugins`
  marks a plugin that has a guide, and `GET /v1/plugins/<name>/setup` says what
  is missing. Setup Dev is the first guide.
- Setup Dev (配置开发流程): a bot reads a repository and proposes the
  `.operad/dev.json` that turns `dev`, `shell` and `pool` on for it. Start it
  with the `bot:setup-dev` action or by asking in a bot chat; approving the
  pending item turns the plugins on, writes the file and registers the
  repository. `operad plugin enable dev` also enables the plugins `dev` needs.
- The `memory` plugin: the shared wiki, whose directory is a setting and which
  is created and made a git repository when it is not one; a `memory` skill every
  bot mounts; and a git commit after each bot reply that wrote to the bot's
  memory or the wiki. The default bot writes the wiki and every other bot reads
  it; each bot's `writeWiki` setting changes that.
- Each bot has a memory of its own inside its working directory, with an
  `index.md` that every reply carries, and a nightly tidy at the bot's
  `tidyTime` that waits for a Run (运行) or Skip (跳过) unless `runWithoutAsking`
  is on. `operad memory search` searches the wiki, the bot's memory and its
  chats with a full-text index, and `operad memory read` reads a document, a line
  range, and the Backlinks of a note. The app shows the wiki's folders and notes.
- Access levels for chats: **Plan only**, **Ask each time**, **Accept edits**
  and **Full access**, set with `/access <level>` or `operad chat:access`, applying
  to a reply already being written. A bot's `accessLevel` setting sets
  the starting level. A repository chat that is raised to Accept edits or Full
  access moves into its own worktree. A command known to only read no longer
  asks, and **Always for this flow and target** lets a background flow keep
  writing to a target you allowed (`operad dev:allow` lists and removes the
  grants).
- Chat commands: a slash command (`/model`, `/effort`, `/access`, `/close`,
  `/help` and the commands of a chat's skills) runs at once, leaves one entry in
  the transcript and never reaches the agent. A command with one choice answers
  with buttons when sent without it. They work in the terminal client, the app
  and Telegram, and Telegram shows them in the command menu.
- Chat usability: a message sent during a reply is delivered into it, and a
  queued message can be withdrawn (`chat:withdraw`); a reply that was interrupted,
  failed or hit a retryable error offers stop and retry; the running reply is
  pushed live; a question can take a choice with a label and a hint, or a form;
  a plan can be reviewed before it runs; the reply shows its status, the model's
  context use and the model's details; and Telegram marks a received message
  with a reaction and shows progress while the bot replies.
- Skills reach every agent: skills in the standard `.agents` directories are
  handed to each agent by operad, a repository chat reads the repository's
  `dev.skills`, and a bot can be created with only chosen skills and MCP servers.
- Scheduled prompts and flows: a bot holds scheduled prompts (Scheduled,
  定时任务), proposed from chat with `operad bot schedule` and approved in
  pending, and `operad scheduled list|add|edit|pause|resume|remove` manages cron
  flows in `triggers.json`. After `serve` was down, a rule runs its most recent missed tick once.
  A scheduled prompt's chat starts at Full access.
- The Codex harness talks to Codex's own app-server, without a bridge, and
  carries the access profile, skills and cancel.
- A bot's chats can use your own agent settings for `claude`, `pi` and
  `radian`, and a bot's pi or claude worker is kept between replies.
- `operad plugin add <package>` installs an npm plugin with its install scripts
  off, and plugins can be listed, enabled and installed over HTTP. Repositories
  can be added from a client, and a flow's stages can be read and changed with
  `operad settings`.
- Testing on another machine: the `dev.testHost` and `dev.testSlots` home
  settings. A gate, integration or rerun command gets them as `OPERAD_CHECK_HOST`
  and `OPERAD_CHECK_SLOTS`, so a restart of `serve` no longer loses the test
  host. An explicit variable in `serve`'s own environment wins. When a
  repository's check commands use `scripts/remote-check.sh` and no host is set,
  `serve` logs one line, the repository gets a pending item, and its Overview
  says the commands run here; `remote-check.sh` says so on stderr when it falls
  back to local. A check that waits for a slot says so while it waits.
- `dev` flows are written with the stages `code`, `test`, `review` and `human`
  (the older `work` and `check` still load); a task's merged diff can be read,
  and a plan or a task can be created and started from a client.
- A page on Tailscale (`docs/user/tailscale.md`): on reaching `serve` from the
  phone app over the HTTPS name that `tailscale serve` gives.

### Changed

- The default HTTP port is `8765` (it was `7480`). A client paired at the old
  port needs `operad pair` again, or `http.port` set to `7480`.
- A repository's `.operad/dev.json` that writes no `worker` or `workers`, and
  no `reviewer.use`, now uses the first harness enabled in the home, in the
  order `radian`, `claude`, `pi`, `codex`, instead of always `radian/agent`. A
  new `.operad/dev.json` written by `operad dev repo add` leaves the worker out.
  `codex` is still off until `operad plugin enable codex`; `init` does not look
  for Codex.
- A task worker is never stopped by the default access profile or by a call the
  matcher cannot follow. A task whose work changed the main checkout gets a
  major finding from `dev` itself.
- `serve` no longer exits when the store is busy for a moment.
- A bare id that several object types own is refused as ambiguous by
  `operad show` and `operad history`; use the full id, such as `plan:repo/P-0001`.
- Errors for a user are short: they say what to do next and not what failed
  inside operad. A plugin that is off says so when you run its command.
- Setting names come with titles that the app and the terminal client show.

### Fixed

- `operad init` with no agent on `PATH` now fails with a message naming the
  three agents and how to install one instead of leaving a home that cannot
  chat.
- Setup and Dev: `operad init` now installs `pool`, and a repository registered
  from a client or with `operad dev repo add` again after its folder moved no
  longer fails.
- A chat reply that failed is shown with the reason and can be sent again; a
  slash message sent while a reply is running is no longer lost; the end of a
  chat's tail no longer drops lines; attachments that are symlinks are refused.
- A reviewer no longer misses a file the task deleted.
- A task an older `dev` recorded no longer stops scheduling.
- `serve` kept old code after a change; it now runs the new code.

### Removed

- The `radian` benchmarks no longer ship with operad; they stay in `radian`.

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

[Unreleased]: https://github.com/operad-io/operad/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/operad-io/operad/compare/49eb3b93...v0.4.1
[0.4.0]: https://github.com/operad-io/operad/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/operad-io/operad/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/operad-io/operad/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/operad-io/operad/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/operad-io/operad/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/operad-io/operad/releases/tag/v0.1.0
