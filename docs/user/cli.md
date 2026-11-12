---
description: The operad command: serve, listing and showing, history, and how a changed file reloads serve.
---

# The command line

`operad help` lists every command and option; this page says what each does. The commands of the `dev` plugin are on [its page](dev.md), the terminal client on [its page](tui.md), `pair` on [the app page](app.md), `mcp` on [the MCP page](mcp.md), and the environment variables on [the environment page](environment.md).

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

Exit codes: 0 stopped, or nothing to stop; 2 usage error; 3 the process is not a
`serve`, or it did not stop in time.

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
`operad history <id>` is unchanged: it prints every step with a UTC time.

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
