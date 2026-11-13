---
description: Every operad command and option, its arguments, output and exit code.
---

# The command line

`operad help` prints the command table; this page says what each command does,
which options it takes and what it prints. The commands of the `dev` plugin are
also on [its page](dev.md); the terminal client is on [its page](tui.md),
`pair` on [the app page](app.md), `mcp` on [the MCP page](mcp.md), and the
environment variables on [the environment page](environment.md).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The command did what it was asked, or had nothing to do. |
| `1` | An error: a bad id, a config or plugin that does not load, a refused check, an editor that failed. |
| `2` | A usage error: an unknown command or option, a missing argument, a bad value. `operad help` is printed after the message. |
| `3` | The state does not allow it: a plugin is disabled, a run is active, a task phase does not allow the change, a `serve` did not stop in time. |
| `4` | Another process holds the home lock, or a second `serve` for the same home. |
| `141` | The reader closed the pipe (128 + SIGPIPE). Later output is dropped. |

## Commands

The commands the CLI owns accept `--help` after the command name where it is
noted below; a plugin verb receives its arguments unchanged. `operad --help`
and `operad help` print the whole table.

| Command | Arguments | What it does and prints |
|---|---|---|
| `operad init` | none | Creates `config.json` when it is missing and checks each loaded plugin. Prints `created <file>` or `using <file>`, then one `<plugin>: <result>` line per check. Exit `1` when a check fails. |
| `operad serve` | none | Runs the loop for this home: starts waits, runs steps, serves HTTP and runs notify. Prints `http <url>` for each listen address and `serving <home>`. Exit `4` when another `serve` holds the home. |
| `operad serve stop` | `--timeout <secs>` | Stops this home's `serve` with SIGTERM; see [Stopping serve](#stopping-serve). |
| `operad pending` | `--json` | Lists what waits for a person: the run, the step, the object's title, the prompt, the choices and the actions. Prints `nothing is waiting` when empty. |
| `operad list <type>` | `--filter <name>`, `--repo <name>`, `--parent <id>`, `--root`, `--where <field=value>`, `--limit <n>`, `--cursor <c>`, `--json` | Lists the rows of one object type. See [Filtering a list](#filtering-a-list) and [Levels](#levels). Prints `no objects of type "<type>"` when empty, `next: operad list … --cursor …` when more follows, and `N hidden (--filter all to show)` when the filter left rows out. |
| `operad show [<id>]` | `--section <id>`, `--page <label or number>`, `--cursor <c>`, `--full`, `--raw`, `--json`, `--repo <name>` | With an id: prints the row, its parent, its children, the section names and the available actions, then the first section (or `--section`). With no id: the ten objects that changed last and `operad show <id>`. |
| `operad history <id>` | `--json` | Prints the steps of a run, or every run of an object, in the [History](#the-history-section) form. A bare id that several object types own is refused as ambiguous. |
| `operad running` | `--json` | Lists the runs in progress: object, step, step time, title, run age and queued time. Prints `nothing is running` when empty. |
| `operad flows` | `--json` | Lists the loaded flows, the plugin each belongs to, and why one cannot start. Prints `no flows loaded` when empty. |
| `operad plugin list` | none | Lists the configured plugins with their version and `enabled` or `disabled`. |
| `operad plugin enable <name>` | none | Enables a plugin at the next command; a shipped plugin that is not in the config is added. Prints `<name>: enabled`. |
| `operad plugin disable <name>` | none | Disables a plugin at the next command. Refuses with exit `3` while a run uses one of its steps. Prints `<name>: disabled`. |
| `operad plugin check <path>` | none | Loads a plugin declaration without starting a run. Prints `<name>: ok` or the problem; exit `1` on a problem. |
| `operad secret set <plugin> <name>` | none | Reads the value from the terminal without echo, or the first line of stdin, and stores it. Prints `secret "<name>" set for plugin "<plugin>"`; the value is never printed. |
| `operad secret list <plugin>` | none | Prints the secret names of one plugin, one per line, never a value. Prints `no secrets for plugin "<plugin>"`. |
| `operad secret delete <plugin> <name>` | none | Deletes one secret. Prints `secret "<name>" deleted for plugin "<plugin>"`. |
| `operad settings` | `--repo <name>`, `--json` | Lists every setting: scope, name, value, default, `editable` or `read-only`, whether it asks to confirm, and its description. |
| `operad settings set <name> <value>` | `--repo <name>`, `--yes` | Changes one setting. The value is JSON when it parses, otherwise a plain string. A setting that asks to confirm needs `--yes`. Prints `<name> = <value>`. |
| `operad http token rotate` | none | Replaces the bearer token at once. Prints `http token rotated`. |
| `operad pair` | `--url <url>`, `--show-token` | Shows the address and token for the app as a QR code; see [Pairing](app.md#pairing-the-app). |
| `operad tui` | `--url <url>`, `--token <token>`, `--no-start`, `--theme <name>` | Opens the terminal client and starts `serve` when none answers; see [the terminal client](tui.md). |
| `operad mcp` | `--claude-channel`, `--types <t,…>` | Runs the MCP server on stdio for a lead agent; see [the MCP page](mcp.md). |
| `operad trigger <source> <key>` | `--type <type>`, `--object <id>`, `--summary <text>`, `--data <file>` | Sends one event through the rules. Prints `started <run>`, `waiting <pending id>`, `recorded in <run>`, `observed <flow> on <object>`, `not started: <reason>` or `recorded <id>`. |
| `operad trigger rules` | none | Prints the rules in force, with the file each came from. Prints `no trigger rules`. |
| `operad:start <id>` | none | Starts the pending item an event created. Prints `started <run>`. |
| `operad:dismiss <id>` | none | Dismisses the pending item an event created. Prints `dismissed <id>`. |
| `operad <plugin>:<action> <id>` | the action's arguments, `--yes`, `--repo <name>` | Runs one action on one object; see [Actions](#actions). |
| `operad <plugin> <verb>` | the verb's arguments | Runs a verb a plugin declares. `<verb>` alone works when exactly one plugin declares it and no kernel command has that name. |
| `operad dev repo add <path>` | `--name <name>` | Registers a repository; see [dev commands](#dev-commands). |
| `operad dev repo list` | none | Lists the registered repositories. |
| `operad dev repo remove <name>` | none | Removes a registered repository. |
| `operad dev plan add` | `--slug`, `--title`, `--concurrency`, `--flow`, `--repo` | Creates a plan and prints its id. |
| `operad dev task add` | `--plan`, `--slug`, `--title`, `--after`, `--area`, `--flow`, `--repo`, `--chat` | Creates a task and prints its id. |
| `operad dev task edit <id>` | `--repo` | Replaces a proposed or ready task's brief with stdin or `$EDITOR`. Prints the task id. |
| `operad dev task update <id>` | `--title`, `--after`, `--area`, `--flow`, `--repo` | Changes a task and prints its id. |
| `operad dev start <task>` | `--repo` | Asks for a ready task to start. Prints `start requested for <id>`. |
| `operad dev reruns` | none | Lists tests that passed only on a rerun, with the task they are attached to. |
| `operad bot skill <bot> <name>` | `--from <dir>` | Proposes a new or changed skill; a person approves it. |
| `operad bot mcp <bot> <name> [<command> [args…]]` | none of its own; the command's words are the server's | Proposes a local MCP server after reading its tools. With no command, reads a pasted `mcpServers` entry from stdin. |
| `operad bot setting <bot>` | none | Proposes a settings change for one bot from JSON on stdin; a person approves it. |

## Options

| Option | Commands | Meaning |
|---|---|---|
| `--help` | the commands the CLI owns | Prints the usage of that command. A plugin verb gets its arguments as they are, so `--help` is passed to the plugin and may be refused as an unknown option; use `operad help` for the command table. `operad --help` prints the whole table. |
| `--version`, `-V` | `operad` | Prints `operad <version>`. |
| `--timeout <secs>` | `serve stop` | How long to wait for the stopped `serve`: a whole number from 1, default 30. `0`, a missing value or a non-number is a usage error. |
| `--json` | `pending`, `history`, `running`, `flows`, `list`, `show`, `settings` | Prints JSON instead of lines. `settings set` does not take it. |
| `--filter <name>` | `list` | The filter to use; `all` shows every row. A type without filters refuses it. |
| `--repo <name>` | `list`, `show`, `settings`, `settings set`, actions, plugin commands | Keeps the list to one repository, or says which repository a bare id lives in. |
| `--where <field=value>` | `list` | One exact match on a field the type's rows carry; may be repeated. |
| `--limit <n>` | `list` | How many rows one page holds. |
| `--cursor <c>` | `list`, `show` | The `next` cursor of an earlier page. |
| `--parent <id>` | `list` | The rows whose parent is that object. Cannot be used with `--root`. |
| `--root` | `list` | The rows with no parent. Cannot be used with `--parent`. |
| `--section <id>` | `show` | The section to print; `history` is always the last one. |
| `--page <label or number>` | `show` | A page of a section that has pages. Cannot be used with `--cursor`. |
| `--full` | `show` | Skips the section size cap. |
| `--raw` | `show` | Prints the section Markdown as it is, with no colours. |
| `--yes` | actions, `settings set` | Answers a confirmation with yes, or answers a confirmation the action asks. |
| `--type <type>` | `trigger` | The event type; `event` when absent. |
| `--object <id>` | `trigger` | The object the event is about. |
| `--summary <text>` | `trigger` | A one-line summary of the event. |
| `--data <file>` | `trigger` | The event's data, read from a file. |
| `--claude-channel` | `mcp` | Turns the one-way Claude Code channel on. |
| `--types <t,…>` | `mcp` | Limits the channel to these object types, separated by commas. |
| `--url <url>` | `pair`, `tui` | The address to name. For `pair` it must be `http` or `https`, without credentials, query or fragment. |
| `--show-token` | `pair` | Prints `url`, `token` and `link` as plain lines, with no QR code, even when the output is not a terminal. |
| `--token <token>` | `tui` | The bearer token of the running `serve`. |
| `--no-start` | `tui` | Never starts `operad serve`. |
| `--theme <name>` | `tui` | The theme for this session; beats `tui.json`. |
| `--name <name>` | `dev repo add` | The name to register the repository under. |
| `--slug <slug>` | `dev plan add`, `dev task add` | The short name in the new id. |
| `--title <title>` | `dev plan add`, `dev task add`, `dev task update` | The title. |
| `--concurrency <n>` | `dev plan add` | How many of the plan's tasks run at once, a whole number from 1 to 16 (default 1). |
| `--flow <name>` | `dev plan add`, `dev task add`, `dev task update` | The flow of the plan or task. |
| `--plan <plan>` | `dev task add` | The plan the task belongs to. |
| `--after <task>` | `dev task add`, `dev task update` | A task to wait for; may be repeated. `--after ""` clears them. |
| `--area <area>` | `dev task add`, `dev task update` | The task's area; `--area ""` clears it. |
| `--chat <id>` | `dev task add` | The chat whose worktree the task uses. |
| `--from <dir>` | `bot skill` | The directory to read the skill from. |

The flags of an action are made from its arguments: an argument named `note`
becomes `--note <text>`, a boolean becomes `--flag` or `--flag=true`, and an
array or object takes JSON. An action that declares `creates` is not offered on
a parent's page; it is run from the new-object entry or the command line.

## Stopping serve

`operad serve stop [--timeout <secs>]` stops the `serve` of the current
`OPERAD_HOME`. It reads `serve.lock`:

- With no lock, or a lock whose process is gone, it prints
  `no operad serve runs for <home>` and exits 0. It signals nothing and does not
  delete a stale lock; the next `serve` replaces it.
- With a live process it first checks that the process is a `serve`: it asks
  the OS for the process's command line (`ps -p <pid> -o command=`, the same on
  macOS and Linux) and requires `serve` as a word of it. The lock alone is not
  enough, because a PID can be reused after a `serve` died. When the process is
  not a `serve` the command prints an error naming the PID, signals nothing and
  exits 3.
- Otherwise it sends SIGTERM, the stop `serve` already handles, prints
  `stopping operad serve (pid <pid>)`, waits until the process is gone or the
  lock is released, prints `stopped` and exits 0. It never sends SIGKILL.

`--timeout <secs>` is how long it waits: a whole number of seconds, at least 1,
default 30. If the `serve` is still running after that, it prints an error that
it did not stop, with `kill -9 <pid>` as the way to force it, and exits 3. A
`--timeout` of 0, one with no value, or one that is not a whole number, is a
usage error (exit 2). `operad serve` with no subcommand runs the loop as before.

What happens to running work: SIGTERM ends the loop after its current pass, then
`serve` stops the notifier, the HTTP server and the trigger sources, releases
the lock and exits. It does not kill a step. A step that is running in its own
process when `serve` stops keeps running, and the next `serve` for the home
picks the run up again. Nothing starts new work or advances waits and timers
while no `serve` runs; `operad serve` or `operad tui` resumes it.

A step cleans up after itself: when it ends, every process it started that is
still running (a loop a worker left in the background, for example) is stopped,
and the step's log lists them. At start, `serve` does the same for the steps of
runs that are no longer active. See "What a step cleans up" in the `dev` README
for how processes are found and what it cannot find.

A restart does not disturb a check or command that is running. Each run is a
process of its own, and the command a step starts is held by that run, not by
`serve`: stopping and starting `serve` sends no signal to it, does not stop its
line and does not run it a second time. The command ends on its own, and the run
records its exit code as if nothing had happened. Only the death of the run's
own process stops its command (and the next `serve` then starts the step
again).

## Changed code

`serve` and each run's process keep running the code they loaded only until the
files change. `serve` watches the kernel's code (`engine`, `cli`), each loaded
plugin's package (source, flows, schemas) and the workspace packages that
package depends on. After the files have been quiet for a second it starts a
fresh process to check that the new code loads. If it does, `serve` stops the
way `operad serve stop` does, prints `reloading: <what changed>` and starts again
from the same command line and environment, under the process you started (it stays
in your terminal, passes Ctrl-C on, and ends with the serve's exit code). A step that is running keeps the
code it started with and finishes; a run's process looks at the files between
steps, and when they changed it stops so that a new process takes the next step.
`operad history` shows one line, `continuing on updated code`, for that.

New code that does not load (a syntax error, an invalid schema) takes nothing
down. `serve` keeps running the old code and prints `code changed (...) but
does not load; the old code keeps running: <problems>` on its error output; it
reloads when the files load again, also when it was a settings file
(`config.json`, `triggers.json`, `keys.json`) that did not read and was fixed. A
run's process does not take its next step on code that does not load: it prints
the same line into the run's log (`<store>/logs/runs/<run id>.out`) and waits for
the files to load. Settings files are read again at their next use; a change to
them alone does not restart `serve`.

While `serve` runs older code than the files on disk, `operad pending` shows one
item: `serve runs older code than the files on disk: restart serve to load them
(operad serve stop, then operad serve)`. It appears when the new code does not
load (see above), or when the restart could not listen on its addresses and the
old code serves again. It has no actions, and it leaves when `serve` runs the
code on disk again: after the files load and `serve` reloads, or after you
restart it, or when the files go back to what `serve` loaded.

When the restart could not listen and the old code serves again, that serve does
not try the same change again. What it still runs from before is `operad` itself
and the plugins given by package name (and the files a path plugin imports), so a
change to those leaves the item above showing. A plugin given as a path, and a
plugin enabled since `serve` first started, are loaded again from the files on
disk, so a change to those alone shows nothing. The next different change goes
through the load check and reloads as usual.

## The History section

Every object has a History section (`operad show <id> --section history`, the
last tab in the web page and the terminal screen). It groups by run, then by
attempt of each step. A run's heading names the flow and when it started; the
run id comes once at the end of the run's block, in small text, for support.
A step attempt is one line: the local time of the host that serves it, the step,
the attempt when it is above 1, why it started when that is not the plain next
step (`after fail`, `after reverify`), the outcome, how long it took (a running
step shows `running` and how long so far) and the outcome's detail cut to one
line with `…`. People's answers and events keep their own line. A date line
starts each new day.

```
## dev run · started 21:38
**2026-11-08**
- 21:38:41  worktree  ready  1s
- 21:38:44  work  done  41m
- 22:20:01  review  fail  58s  packages/dev/src/gate.ts:1059 major …
- 22:21:01  work  attempt 2  after fail  done  1m
- 22:22:02  confirm  reverify  8m
- 22:30:02  you chose merge: via plugin, as dev
- 22:30:04  verify  after reverify  running  2m
```

`operad show <id> --section history --full` keeps each detail whole.
`operad history <id>` prints every step with a UTC time; `--json` prints one
object per step, or one object per run when the id names several runs.

## Levels

A plugin can arrange its objects in levels. A row may carry `parent`: the id of
the object one level up, either a full id (`plan:repo/P-0001`) or a bare id
that resolves the way `operad show` resolves it. The kernel passes it through
and never makes one up. A row without `parent` is at the top level.

- `operad list <type> --root` lists the rows of that type with no parent;
  `operad list <type> --parent <id>` lists the rows whose parent is that
  object. Plain `operad list <type>` stays flat.
- `GET /v1/objects?root` and `GET /v1/objects?parent=<id>` do the same. `type`
  is optional with them. Without `type` they list across the types of all
  plugins in a stable order: the types in the order `GET /v1/types` gives them
  (plugin load order, then the order each plugin declares its types), and
  within a type the rows in the order a plain list of that type has (by id).
  `next` pages through that whole order. `root` and `parent` cannot be used
  together.
- The type's filters apply inside the level: a request with `type` uses the
  named filter or the type's default; without `type` each type uses its own
  default (or the named filter, where the type has it). `hidden` counts the
  rows of that level the filters left out.
- A `parent` that names no object is not an error: the list is empty. A row
  whose `parent` names an object that does not exist still lists under
  `parent=<that id>`, and not under `root`.
- `operad show <id>` prints `parent: <id>` under the row when it has one.
- The MCP `list` tool takes `root` and `parent` too; see [the MCP page](mcp.md).

## Filtering a list

A plugin can give an object type filters, so a list does not show every old
object. In the plugin, the object type has an optional `filters` field, an
ordered list of `{ "name": string, "states": string[], "default"?: boolean }`:

```ts
objects: [
  {
    name: "task",
    filters: [
      { name: "active", states: ["proposed", "ready", "running"], default: true },
      { name: "done", states: ["merged"] },
    ],
  },
],
```

A filter is data: a row matches when its `state` is one of `states`. A row whose
`state` is `error` (its view failed) is shown by every filter, so a broken row
is never hidden. At most one filter has `default: true`; with none marked, the
first is the default. Loading the plugin refuses an empty or duplicate name, two
defaults, an empty `states`, and the name `all`, and names the field.

The kernel adds the filter `all`, which tests no state, right after the
default. The tasks above list as `active`, `all`, `done`.

`operad list <type> [--filter <name>] [--repo <name>]` uses the type's default
filter when it has one and `--filter` is not given. `--filter all` lists
everything. When the filter left rows out, the last line is
`N hidden (--filter all to show)`. `--repo` keeps the objects of one
repository, and works together with `--filter`. A type without filters refuses
`--filter` with "this type has no filters". The HTTP interface takes the same
choice as `filter` (see the endpoints below).

The `dev` plugin declares these filters (`all` follows `active`):

| Type | Filter | States |
|---|---|---|
| task | `active` (default) | proposed, ready, running, review, integrating, waiting, paused |
| task | `done` | merged |
| task | `cancelled` | cancelled |
| plan | `active` (default) | draft, confirmed, paused |
| plan | `done` | finished |
| plan | `cancelled` | cancelled |
| repo | `active` (default) | active |
| repo | `removed` | removed |

The `chat` plugin declares `open` (default) and `closed`; `all` follows `open`.
The `bot` plugin declares `open` (default) and `removed`; `all` follows `open`.
The `bot` proposal type declares `pending` (default), `applied` and `rejected`.

## Actions

An action is run as `<plugin>:<action> <id>`, or as `<plugin> <action> <id>`,
or as `<action> <id>` when only one plugin offers that action. The command line
builds one flag per argument the action declares:

```sh
operad dev:reject T-0003 --note "cover concurrent writers"
operad dev confirm T-0003 --yes
operad chat:send C-0001 --note "why does the gate fail on main?"
operad dev:model C-0001 --model sonnet
```

A required note with no `--note` is asked for in a terminal, and refused in a
pipe; a `confirm: true` action asks `[y/N]`, and `--yes` skips the question.
The action's record is printed when it returns a value. An action that opens an
object (`opens`) only prints its line; the terminal and the app open the object.
An action that records an answer prints `recorded; it runs when `operad serve`
is running` when no `serve` holds the home.

## dev commands

`operad dev repo add <path> [--name <name>]` registers a directory that is a git
work tree with a remote. It writes nothing when the directory has no remote and
prints the reason. `operad dev repo list` prints `no repositories` or one
`<name>  <path>` line per repository. `operad dev repo remove <name>` prints
`removed <name>`.

`operad dev plan add --slug <slug> --title <title> [--concurrency <n>]
[--flow <name>] [--repo <name>]` creates a plan and prints its id. The request
is read from stdin when there is any. `--concurrency` is a whole number from 1
to 16 and defaults to 1 when it is left out.

`operad dev task add --plan <plan> --slug <slug> --title <title> [--after
<task>]… [--area <area>] [--flow <name>] [--repo <name>] [--chat <id>]` creates
a task in the named plan and prints its id. The brief is read from stdin when
there is any. `--after` may be repeated; the task waits until each named task
is merged. A task of another repository is named `<repository>/<task id>`. A
task cannot follow itself or close a cycle. `--chat` uses the worktree that chat
asked for.

`operad dev task edit <id> [--repo <name>]` replaces the brief of a proposed or
ready task. The new brief is the text on stdin when it is not a terminal and
carries some, otherwise what you save in `$EDITOR` (or `$VISUAL` when `EDITOR`
is unset). With no editor and no input the command fails and says so. It prints
the task id.

`operad dev task update <id> [--title <title>] [--after <task>]… [--area
<area>] [--flow <name>] [--repo <name>]` changes a task and prints its id.
`--after ""` clears the tasks it waits for; `--area ""` clears the area. The
flow can change only before the first attempt; after that the command refuses.

`operad dev start <task> [--repo <name>]` asks for a ready task to start and
prints `start requested for <id>`; the next `serve` pass claims it.

`operad dev reruns` prints one line per test that passed only on a rerun:
`<count>  <test name>  <task id>`; it prints `no test has passed on a rerun yet`
when there is none.

The short forms `operad repo …`, `operad plan …`, `operad task …`,
`operad start …` and `operad reruns` work because only `dev` declares those
verbs.

## bot commands

`operad bot skill <bot> <name> [--from <dir>]` proposes a new or changed skill.
Without `--from`, stdin is a JSON object with `skill_md` and `files`; with it,
the directory's files are read. The skill needs a `SKILL.md`. Nothing is written
until a person approves the proposal in pending.

`operad bot mcp <bot> <name> <command> [args…]` starts a local MCP server once,
reads its tool list, and proposes registering it. With no command, stdin is a
pasted `mcpServers` entry. A package command (`npx`, `bunx`, `uvx`, `pipx`) must
name an exact version, as `name@1.2.3`; a tag or range is refused before the
server starts. A remote server (an address) cannot be registered yet.

`operad bot setting <bot>` reads a JSON object from stdin and proposes the
change. A bot can tighten the default access profile, never loosen it. MCP
servers are not changed here; use `bot mcp`.

## Runnable examples

Each command below works in a fresh home and is run by the documentation test.

```sh runnable
operad --version
operad pending
operad running
operad flows
operad plugin list
operad settings
operad show
operad trigger rules
```
