# operad manual

The commands are in this file; `docs/dogfood.md` shows one complete workflow.

## The home

`operad` keeps its state in one directory: `$OPERAD_HOME` when it is set, and
`~/.operad` otherwise. The home holds `config.json`, the store and the secrets
directory. A secret file is mode `0600` inside a `0700` directory; nothing in
this manual prints a secret.

## config.json

`config.json` is JSON. A missing file means the defaults below.

```json
{
  "plugins": {
    "shell": { "module": "@operad-io/shell", "enabled": true },
    "harness-radian": { "module": "@operad-io/harness-radian", "enabled": true },
    "dev": { "module": "@operad-io/dev", "enabled": true }
  },
  "store": { "backend": "jsonl", "path": "~/.operad/store" },
  "http": { "enabled": true, "port": 7480, "listen": ["127.0.0.1"] },
  "notify": { "command": null, "on": ["waiting"] },
  "mcp": {
    "actions": ["dev:rework", "dev:reverify", "dev:reject", "dev:priority", "dev:concurrency"],
    "confirmActions": []
  },
  "ask": { "graceSecs": 600 }
}
```

- `plugins`: plugins keyed by name. Each entry is a module name or path, or an
  object with `module`, `enabled` and the plugin's own `settings`. The key can
  also be an array of module names.
- `store`: where the objects and their history live. `backend` is `jsonl` or
  `sqlite`; `path` is a directory for `jsonl` and a file for `sqlite`. A
  relative path resolves against the home. Changing `backend` alone starts from
  an empty store; to keep what you have, see [Moving the store](#moving-the-store).
- `http`: the interface `operad serve` exposes to clients. It is off unless
  `enabled` is true; no other command opens the port.
- `ask`: how long `ctx.ask` waits for an answer by default; see
  [Asking a person from a step](#asking-a-person-from-a-step).
- `notify`: a command `serve` runs when something waits for a person; see
  [Notifications](#notifications). It is off while `command` is `null`.
- `mcp`: the plugin actions the MCP server may run for a lead; see
  [MCP server](#mcp-server).

### mcp

| Key | Type | Default | What it does |
|---|---|---|---|
| `actions` | array of `plugin:action` strings | `["dev:rework", "dev:reverify", "dev:reject", "dev:priority", "dev:concurrency"]` | The actions `operad mcp` may run. Every other action is refused with a message naming it and saying the owner runs it. |
| `confirmActions` | array of `plugin:action` strings | `[]` | The allowed actions that also carry `confirm: true`. Such an action is refused even when `actions` names it unless this list names it too. |

Both lists take effect the next time `operad mcp` starts. They do not change an
action already running. The MCP server never offers the owner's actions as its
own; `show` lists them separately so the lead can tell the owner what to run.

`dev:reverify` merges the current main into the task branch first, then runs verify and review again with no worker. A clean merge goes straight to verify; a conflicting main sends the task to the worker.

### Where the reviewer writes its report

The reviewer runs in the task's gate worktree, and some agents (radian, for one)
cannot write outside the folder they run in. So each reviewer call is told to
write its report to `.operad/review/<run>-attempt-<n>-review-<round>-try-<k>.json`
inside that worktree, a path that is new for every call (`k` counts the calls
before it in the round). `dev` reads the report there, checks it, and keeps its
own copy in the store under `dev/reviews/<run>/`; that copy is the record.
`dev` never deletes, truncates or overwrites a file in the review workspace: it
creates `.operad/review` when missing, and refuses to write through a link or
over an existing file, failing the review with the path instead. The gate
worktree is disposable and is replaced by the next gate step, which removes the
reports with it. A reviewer that finishes without writing a report is shown as
`could not write the report` with its last message; a file that fails the check
is shown as `wrote an invalid report`.

### http

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `true` | Start the HTTP interface with `operad serve`. Set `false` to turn it off; `operad tui` then cannot reach a `serve`. |
| `port` | integer | `7480` | The port to listen on; `0` asks the system for one. |
| `listen` | array of strings | `["127.0.0.1"]` | The IP addresses to listen on. |

Each `listen` entry is an IP literal. `serve` accepts a loopback address, an
RFC 1918 address (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), a link-local
address (`169.254.0.0/16`, `fe80::/10`) or a Tailscale address
(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). It refuses a wildcard (`0.0.0.0` or
`::`) and every other address, before it opens a port, naming the entry. The
default listens on the machine only. A config with no `http` section means
`enabled` true, port `7480`, `listen` `["127.0.0.1"]`. An `http` section without
`enabled` turns the interface on, on the addresses in `listen`.

The first `operad serve` with `http.enabled` true (the default) creates one bearer token, 32 random
bytes in base64url, in `secrets/http.json`. Every request must carry
`Authorization: Bearer <token>`; a request without it, or with a token that is
not current, gets `401`. `operad http token rotate` replaces the token at once:
a running `serve` refuses the old one from the moment the command returns and
ends the event streams opened with it. No endpoint shows the token.

`serve` prints one line per address it listens on:

```text
http http://127.0.0.1:7480
```

A second `operad serve` for a home that already has one exits with code 4 before it
reads the store or opens the port.

### Stopping serve

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

### Changed code

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

### Pairing the app

`operad pair` shows what the app needs to reach this `serve`:

```text
url http://192.168.1.20:7480
token <the token>

Scan this in the operad app:

<a QR code>
```

The URL is `http://<address>:<port>` for the first non-loopback entry of
`http.listen`. Pass `--url <base url>` to name another address, such as a
Tailscale HTTPS name (`operad pair --url https://mac.tail1234.ts.net`); it must
be an `http` or `https` URL without credentials or a query. The QR code encodes
`operad://pair?url=<url>&token=<token>`. It needs `http.enabled` true, and with no
`--url` an address in `http.listen` that is not loopback. With the default `http`
values, `pair` says that `http.listen` has only loopback addresses and asks for
one or `--url`; it names `http.enabled` only when that is false.

`pair` is the one command that prints the token. It refuses when its output is
not a terminal, so a pipe or a log never receives it; `--show-token` overrides
that and prints `url`, `token` and the pairing `link` as plain lines, with no
QR code. If you paste the token anywhere, rotate it with `operad http token
rotate`.

### The terminal client

`operad tui` is the terminal client for the same `/v1` interface. With a fresh
`~/.operad` it needs nothing else: no config edit, no `operad serve` in another
terminal, no token. It never opens the store and never loads a plugin. It finds
or starts the server like this:

- `--url` and `--token` win over the home when they are given. With `--url`
  nothing is ever started.
- Without `--url`, the URL is `http://<address>:<port>` for the first entry of
  `http.listen` and `http.port` in `config.json`; with no `http` section it is
  `http://127.0.0.1:7480`.
- It asks that address for `/v1/types`. If a `serve` answers, it goes on.
- If nothing answers and no `serve` holds this home, it starts `operad serve`
  for this `OPERAD_HOME`, prints `starting operad serve (log: <path>)`, waits up
  to 15 seconds (probe time counts) for it to answer, and opens the screen. The `serve` runs with
  the same runtime and `operad` entry as the command you typed, with
  `$OPERAD_HOME` as its working directory, appends its output to
  `$OPERAD_HOME/serve.log`, and keeps running after you quit the TUI,
  because the hub keeps running flows. Stop it with `operad serve stop` (see
  "Stopping serve") or press Ctrl-C in a terminal where you ran
  `operad serve` yourself. If it exits at once or never answers, `operad tui`
  fails with one error that names `serve.log` and shows its last lines;
  `serve.log` can hold plugin output, so read the lines before you paste them.
  If another `operad tui` started the `serve` first, this one waits for that
  `serve` to answer within the same 15 seconds.
- If a `serve` already holds this home but nothing answers at the address
  (`http.enabled` is false, or `http.port`/`http.listen` differ), it starts
  nothing and says so, naming `http.enabled` and `http.port`.
- If something answers at the address but it is not operad, it fails naming the
  port.
- With `http.port` 0 or an empty `http.listen` it starts nothing and says to set
  `http.port` (or `http.listen`) or pass `--url`.
- With `"enabled": false` in `http` it starts nothing and names `http.enabled`.
- `--no-start` turns the start off: the screen opens as before and shows the
  failure in its footer.
- Without `--token`, the token is the one `operad pair` reads from
  `$OPERAD_HOME/secrets/http.json`. `operad pair --show-token` prints it.

| Input | Type | Default | Allowed values |
|---|---|---|---|
| `--url` | string | `http://<first http.listen address>:<http.port>`, which is `http://127.0.0.1:7480` with no `http` section | An `http` or `https` URL without credentials, a query or a fragment. |
| `--no-start` | flag | off | Never start `operad serve`, even when none answers. |
| `--theme` | string | `theme` in `$OPERAD_HOME/tui.json`, else `auto` | `auto`, `light`, `dark`, `terminal`, a family or a shipped theme (see Themes), or the name of a theme file of your own. Beats `tui.json` for this session. |
| `--token` | string | The token in `$OPERAD_HOME/secrets/http.json` | The bearer token of the running `serve`. |
| `OPERAD_HOME` | environment variable | `~/.operad` | The directory holding `config.json`, `secrets/http.json`, `serve.lock` and the `serve.log` a started `serve` writes. |
| `http.listen` | array of strings in `config.json` | `["127.0.0.1"]` | IP literals `serve` may listen on; the first one is the default TUI address. |
| `http.port` | integer in `config.json` | `7480` | `0` to `65535`; the TUI needs the port `serve` actually uses, so `0` needs `--url`. |

#### Themes

The colours come from a theme. Choose one in `$OPERAD_HOME/tui.json` (its JSON
Schema is `packages/tui/tui.schema.json`) or for one session with `--theme`:

```json
{ "theme": "terminal" }
```

| Name | Look |
|---|---|
| `auto` (default) | `light` or `dark` by the terminal's theme mode, and it switches live when the terminal switches. |
| `light`, `dark` | The operad app's colours. |
| `terminal` | The terminal's own 16 colours (accent magenta, run blue, ok green, error red, weak bright black), so its scheme decides the look; it works without truecolor. |

An unknown name is an error that lists the names. A `tui.json` that is not a
JSON object, is not valid JSON, has a key other than `theme`, or names no known
theme is an error that names the file and the problem; the TUI does not start.

##### Popular themes

operad ships these palettes, each from its project's own repository (the source,
the licence and every contrast adjustment are in the `comment` of its file in
`packages/tui/themes/`, and the licence texts are next to the files). To pick
one, name it in `tui.json` (`{ "theme": "nord" }`) or pass `--theme nord`.

| Family (follows the terminal like `auto`) | Light | Dark |
|---|---|---|
| `catppuccin` | `catppuccin-latte` | `catppuccin-mocha` |
| `solarized` | `solarized-light` | `solarized-dark` |
| `tokyo-night` | `tokyo-night-day` | `tokyo-night-night` |
| `one` | `one-light` | `one-dark` |
| `rose-pine` | `rose-pine-dawn` | `rose-pine-main` |
| `github` | `github-light` | `github-dark` |
| `kanagawa` | `kanagawa-lotus` | `kanagawa-wave` |

Name a family and the TUI shows its light member in a light terminal and its dark
member in a dark one, and switches live like `auto`. Name a member to keep it
whatever the terminal does. These have no pair and are always the same: `dracula`, `nord`,
`catppuccin-frappe`, `catppuccin-macchiato` and `kanagawa-dragon` (all dark).
Gruvbox is not shipped because its repository has no licence file.

##### Your own themes

`theme` may also name a theme file, `$OPERAD_HOME/themes/<name>.json` (JSON
Schema: `packages/tui/theme.schema.json`). It names only the tokens it changes;
`extends` (`light`, `dark`, `terminal`, a shipped theme or another theme file; `dark` when
absent) fills the rest. A colour is `"#rrggbb"` or an ANSI index from 0 to 15:

```json
{ "extends": "dark", "colors": { "accent": "#ff8800", "error": 9 } }
```

A cycle in `extends`, an unknown token, a bad colour or an unknown key is an
error naming the file and the key. A file with the name of a built-in theme
(`auto`, `light`, `dark`, `terminal`, a family or a shipped theme) is refused.

Two examples are in `docs/themes/` and are not installed: `high-contrast.json`
and `low-saturation.json`. To start from one:

```sh
mkdir -p ~/.operad/themes
cp docs/themes/high-contrast.json ~/.operad/themes/mine.json
echo '{ "theme": "mine" }' > ~/.operad/tui.json
```

The TUI watches `tui.json` and the themes directory and repaints when either
changes, without a restart. A file that turns invalid keeps the last good theme
and the footer shows one line, `theme not changed: <why>`, until the next good
change.

Every theme defines the same tokens: `text`, `weak` (secondary text), `rule`
(rules and borders), `accent` (needs you), `run` (in progress), `ok` (success),
`error`, `add` and `remove` (diff lines), `tint` (the selected row's background)
`code` (a code block's background) and `background` (the fill of the palette, note, confirmation and key list boxes).

`operad tui` uses the terminal size: at 100 columns or wider the list and the
object pane sit side by side, and below 100 columns the list fills the screen
and an open object replaces it until `escape`. The header counts Pending and
Running and then names every object type from `/v1/types`. The right pane says
`select an object` until a row is opened. `enter` opens the selected row with
`GET /v1/objects/<id>`: the pane starts with that row (id, title, state, note
badge and mark), then the section tabs in the server's order (History last), then the
section's Markdown. A live section has a dot on its tab and follows its end
while the pane is at the bottom (`following`); scrolling up stops following and
`End` resumes it. A section the server cut at its size cap shows a `Truncated`
hint and `f` loads the whole section. A failed request, or a refused event
stream such as a wrong token, shows its reason in the footer until
a fetch succeeds; the same messages are printed after the screen closes. The
list scrolls to keep the cursor in view, and a refresh keeps the selected object
when it is still there. With 100 columns or more the list and the object sit
side by side: the object follows the selected row (it opens about 150 ms after
the cursor stops), `j` / `k` and the arrows keep moving the list, and the keys
that scroll or switch sections act on the object. Under 100 columns the object
fills the screen: `enter` opens it, `escape` goes back, and `j` / `k` scroll it.
Switching tabs closes the object. On a type tab whose type declares filters,
`f` shows the next filter in the server's order (every start opens each tab on
the type's default; the choice is not saved). The header adds ` · <filter>` after
the tab and, unless the filter is `all`, ` · N hidden`. The selection stays on
the same object when the new filter still shows it, and moves to the first row
otherwise. An object that leaves the filter through a live update leaves the
list. Beside an open object, `f` loads the whole section when it is capped and
cycles the filter otherwise; on a narrow screen with an object open it only
loads the section. Every key the app reads is below.

| Input | Type | Default | Allowed values |
|---|---|---|---|
| `1`–`9` | key | none | The tab with that number. |
| `tab` | key | none | The next tab. |
| `shift-tab` | key | none | The previous tab. |
| `enter` | key | none | Open the selected row as an object (under 100 columns; side by side it is open already). On the row that is already open it does nothing. |
| `↑` / `↓` | key | none | Move the list cursor one row; a list loads its next page near the end. Under 100 columns with an object open, scroll the section one line instead. |
| `j` / `k` | key | none | The same as `↓` / `↑`. |
| `PgUp` / `PgDn` | key | none | Scroll the open section by one page. At the end it asks the section for its `next` page. |
| `b` / `space` | key | none | The same as `PgUp` / `PgDn`. |
| `Home` / `End` | key | none | The top of the open section, or its end; `End` resumes following a live section. |
| `[` / `]` | key | none | Switch to the previous or next section tab. |
| `←` / `→` | key | none | The same as `[` / `]`. |
| `f` | key | none | Load a capped section with `full=true`. |
| `g` | key | none | The first row; under 100 columns with an object open, the top of the section. |
| `G` | key | none | The last row; under 100 columns with an object open, the end of the section (it resumes following a live section). |
| `r` | key | none | Fetch every list again, and the open object with its live sections. When the open section failed to load, it asks for that section again too. |
| `a` | key | none | Run the open object's main action, the first one the object offers now (the footer names it with its key). A key bound to an action (below) wins over `a`. With no action, one footer line says so. |
| a bound key | key | `GET /v1/keys` | Run that action on the open object. A user binding in `keys.json` beats a plugin default on the same key. Reserved keys cannot be bound: `enter`, `return`, `escape`, `esc`, `tab`, the arrows (`up`, `down`, `left`, `right`), `pageup`, `pagedown`, `home`, `end`, `space`, `[`, `]`, `:`, `?`, `/`, `b`, `f`, `g`, `j`, `k`, `q`, `r` (letters in either case) and `1`–`9`, as well as Ctrl-C and any Ctrl or Meta chord. A plugin default or `keys.json` entry on a reserved key is dropped; at start one footer line names each dropped key with its action and source. The action stays reachable from the `:` palette, with no key shown. If the object does not offer the action now, one footer line says it is not available. |
| `:` | key | none | Open the palette: type to fuzzy match the `plugin:action` names the open object offers, each with its key and "needs a note" or "asks to confirm". `↑` / `↓` (or Ctrl-P / Ctrl-N) move, `enter` runs, `escape` closes. With no object open it lists nothing but "no object is selected". |
| note input | key | none | An action with a note field opens a text input. Typing adds text, `backspace` deletes, `shift-enter` or `Ctrl-J` adds a line, `enter` sends and `escape` cancels. A required note cannot be sent empty. |
| confirmation | key | none | An action that asks to confirm shows `<action> <id>? [y/N]` in red. `y` sends it with `confirmed: true`; any other key cancels. |
| `?` | key | none | Show or hide the key list. |
| `q` | key | none | Quit. |
| `Ctrl-C` | key | none | Quit at once. The terminal restores itself; no other Ctrl or Meta chord does anything. |
| `escape` | key | none | Close the key list, or close the open object and stop its requests. While the key list is open only `?`, `escape` and `q` act; the others leave the list alone. |

#### Live updates, states and leaving

The screen follows the event stream. An event for an object fetches that
object's row again in every open list and, if it is the open object, the object
and its open live sections. A `reset` (the server could not resume the stream,
or the stream reconnected with nothing to resume from) fetches every open list
and the open object again. Pending and Running are fetched again on any event.
Events that arrive together are served in one batch, at most one batch every
250 ms.

| State | What the screen shows |
|---|---|
| Server unreachable | One footer line, `no server at <url>: is `operad serve` running? retrying`. The last lists stay on screen, dimmed. The screen asks again after 250 ms, then 500 ms, 1 s, 2 s, 4 s and every 5 s, and returns to normal when the server answers. |
| 401 | `the token was rotated: run the TUI again or pass --token`. Nothing is retried; `q` quits. |
| Empty Pending | `nothing waits for you` |
| Empty list of an object type | `no <type title> yet` |
| A section that failed to load | The server's message and `r retries` in place of the section; `r` asks for that section again (and fetches the lists again). |

`q`, Ctrl-C, SIGINT and SIGTERM all end the screen the same way: the event
stream is closed, the terminal is restored (alternate screen left, cursor
shown), failures collected while the screen was open are printed, and the
command exits 0. A `serve` that the TUI started keeps running.

A refused action shows the server's status and message as they came (for
example `409 …`) in one footer line until the next key. After a success the app
fetches the lists and the open object again.

### Endpoints

All endpoints are under `/v1`. Responses are JSON unless the endpoint says
otherwise. An object id in a path is URL-encoded; `<id>` may be the bare id or
`<type>:<id>`.

| Method and path | What it returns |
|---|---|
| `GET /v1/types` | `{ "types": [{ "type": "task", "title": "Task", "plugin": "dev" }] }`: the object types with views, their display names and the name of the plugin each belongs to (a client groups types by it). A type that declares filters also carries `"filters"`, in display order (`[{ "name": "active", "states": ["proposed", ...] }, { "name": "all" }, ...]`), and `"defaultFilter"`. A type without filters carries neither. |
| `GET /v1/keys` | `{ "keys": [{ "key": "m", "action": "dev:merge", "source": "plugin" }] }`: the key bindings in force, the plugins' defaults with the person's `keys.json` overrides applied; `source` is `user` for an override. |
| `GET /v1/objects?type=<type>&filter=<name>&cursor=<c>` (also `root` and `parent=<id>`, see [Levels](#levels)) | `{ "rows": [...], "next": "<c>", "hidden": 3 }`: one page of the list. `rows` carry the plugin's `id`, `title`, `state` and optional `note`, `mark` and `badge` (see [Row marks](#row-marks)), plus `waiting` and `running`; an error row also carries `error`. `filter` keeps the rows the named filter shows, and `hidden` counts the rows of the type it left out (the whole type, not only this page). Without `filter` the type's default filter applies when it has filters; a type without filters lists every row and has no `hidden`. `filter=all` lists every row and has no `hidden`. An unknown name is a `400` that names the allowed ones. `next` pages within the filtered list. |
| `GET /v1/pending` | The same list as `operad pending`, with the actions each item offers. A wait that its plugin is about to answer automatically (dev: a passed review of a task in a plan at auto merge) is not listed, so the count does not flicker; it is listed if the automatic answer does not come. An item a plugin raises without a run waiting (`kind` `standing`, no actions, `runId` `<plugin>:<id>`) is in the list too, and goes when the plugin stops reporting it. An item that is about an object also carries `object` (`<type>:<id>`), its `link` and its `row`: the same row `GET /v1/objects?type=…` returns for that object (`id`, `title`, `state`, optional `note`, `mark`, `badge`, `waiting`, `running`), so a client does not read each object. When the row cannot be built (the object is gone, no loaded plugin shows its type, or the plugin's row fails) the item carries the error row the list shows for a bad row, with `state` `error` and an `error` message; the list itself never fails for one object. A candidate has no object and no `row`. `operad pending` prints the row's title under each line that has one. |
| `GET /v1/running` | The same list as `operad running`. Each item has `runId`, `flow`, `step`, `stepLabel`, `queued`, `startedAt` and `elapsedMs` (the run's age), and: `object`, the object's id as rows and `operad show` name it (for example `operad/T-0048-type-filters`), or `null` for a run with no object; `title`, that object's row title, or `null` when there is no object or the lookup failed (a failed lookup never fails the list); `stepStartedAt` and `stepElapsedMs`, when the current step's current attempt started and how long it has run (`null` before the first step); `mark`, the object's row mark (one of the [row marks](#row-marks)), left out when the row has none or cannot be built. The step time starts again when the step changes and on a new attempt. |
| `GET /v1/objects/<id>` | `{ "id", "type", "link", "row", "sections", "actions" }`: the link that opens the object, the row, the section directory, and the actions available now with their `args` schema, `note` field and `confirm` flag. |
| `GET /v1/objects/<id>/sections/<section>?cursor=<c>&full=<bool>` | `{ "markdown": "...", "next": "<c>" }`. `full=true` skips the size cap. |
| `POST /v1/act` | Runs one action. The body is `{ "action": "plugin:action", "id": "<id>", "args": {...}, "note": "...", "confirmed": true }`; only `action` is always required, and an action that targets an object also needs `id`. An action with `confirm: true` needs `"confirmed": true`. The body is at most 1 MiB; a larger one gets `413`. |
| `GET /v1/events` | An SSE stream of changes. |

`POST /v1/act` records the caller as `{ "via": "http", "id": "operad app" }`.
It records the action the same way the command line does, and a running
`operad serve` carries on the steps a waiting run asks for.

### Row marks

A plugin's `row` may return a `mark` and a `badge` besides `id`, `title`, `state`
and `note`. `GET /v1/objects`, `GET /v1/objects/<id>`, the row of a pending
item and the MCP `list` and `show` results pass them through unchanged.

`mark` says what the object is doing, and the client chooses the icon and the
colour. It is one of these 17 values, and the kernel turns any other value into
the error row, naming them:

| Mark | Meaning | TUI |
|---|---|---|
| `todo` | not started | `○` |
| `blocked` | waits for another object or a held area | `◌` |
| `retry_wait` | waits for a retry time | `◷` |
| `paused` | paused | `‖` |
| `proposed` | suggested, not yet accepted | `+` |
| `starting` | being set up | `◔` |
| `running` | work in progress | `◐` |
| `reconciling` | being brought in line with a change elsewhere | `↻` |
| `checking` | being verified or reviewed | `⌕` |
| `rework_pending` | asked whether to redo it | `↩` |
| `waiting` | waits for a person | `●` |
| `integrating` | being merged | `⑂` |
| `ready_to_merge` | checked, waits for the merge | `◉` |
| `done` | finished | `✓` |
| `failed` | gave up | `✗` |
| `cancelled` | cancelled | `⊘` |
| `broken` | cannot be used | `!` |

The kernel's `waiting` and `running` flags stay as they are. A client picks what
to draw in this order: an error row draws the error; when `waiting` is true, a
`mark` of `waiting`, `proposed`, `rework_pending` or `ready_to_merge` is kept
and any other mark (or none) draws `waiting`; when `waiting` is false, the
`mark` is drawn if there is one; otherwise `running` true draws `running`; a row
with none of these is plain. The TUI colours the marks by role: `proposed`,
`rework_pending` and `waiting` use the accent, `starting`, `running`,
`reconciling`, `checking` and `integrating` the run colour, `ready_to_merge` and
`done` the success colour, `failed` and `broken` the error colour, and the
rest the weak colour.

`after` lists the ids of siblings (rows with the same `parent`) the object waits
for, in the form row ids have; it is an array of non-empty strings, or the row is
an error row. It is passed through list, get and pending rows unchanged, and
`operad list` and `operad show` do not print it. The `dev` plugin fills a task's
`after` with the task ids it waits for, as stored: a task of another repository shows as
`<repository>/<task id>`.

`operad task add` and `operad task update` take `--after <task>` for a task of the same
repository (any plan) or `--after <repository>/<task>` for a task of any registered
repository. The task is blocked until every task it follows is merged, wherever it is,
and its note says what it waits for (`waiting for operad/T-0188` for another repository).
The named task must exist, and a task cannot follow itself or close a cycle.

`operad plan add` and `operad task add` take `--flow <name>`, one of the flows the
repository's `.operad/dev.json` defines. A task without `--flow` takes its plan's flow,
and a plan without one takes `default`. `operad task update <id> --flow <name>` changes
a task's flow only before its first attempt; after that the command refuses. A task
whose flow dev.json does not define stays ready, and its row and its plan's row say
`flow <name> is not defined in .operad/dev.json`. When the repository defines more than
one flow, the task row's note and the Brief section name the task's flow, and History
names the flow at the start of each run.

`badge` is a short text the client shows as it is, after the state: one line of
at most 16 characters, or the row is an error row. The `dev` plugin sets a
task's badge to `#<attempt>` (`#0` before the first attempt) and marks its tasks
and plans from their phase, the step the attempt has reached and the holds the
scheduler records; `operad list` keeps its columns and does not show them.

### Links

An object link is `operad://objects/<id>`, where `<id>` is the object as `get`
takes it, `<type>:<id>`, URL-encoded: `item:a b/c` is
`operad://objects/item%3Aa%20b%2Fc`. `GET /v1/objects/<id>` and each pending
item carry it as `link`, and a notification command gets it as `OPERAD_LINK`.
Opening it in the app shows that object. Following the link's path
(`/v1/objects/<the part after objects/>`) finds the same object.

### Events

`GET /v1/events` streams server-sent events. Each event is an object that
changed:

```text
id: 3f9c2a1b7d4e5f60-7
data: {"id":"T-0019-http-api"}

```

An `id:` is an opaque string. It changes on every event and starts with a
value the process chose at boot, so an id from an earlier `serve` is not
resumable. A client that reconnects with `Last-Event-ID` receives the events it
missed. When that id is older than the server still keeps, or comes from an
earlier `serve`, the server sends one `reset` event instead; the client then
refetches the lists and the open sections. A comment line keeps the stream open
while nothing changes. A client that stops reading is disconnected once its
backlog reaches the size of the resume window; it reconnects and gets a
`reset`.

### Errors

Every error body is:

```json
{ "error": { "kind": "not-found", "message": "no object \"T-1\"" } }
```

| Status | When |
|---|---|
| `400` | Bad arguments, an unknown filter, a malformed cursor, or an ambiguous id. |
| `401` | A missing or wrong bearer token. |
| `404` | No such object, section or action, or no endpoint. |
| `409` | The action is not available now, it needs confirmation, or its plugin is not loaded. |
| `413` | The request body is larger than 1 MiB. |
| `422` | The action's plugin refused it; `message` is the plugin's own message. |
| `504` | A section did not load in time. |
| `500` | Anything else; the body carries no stack trace. |

## Moving the store

`operad store copy <jsonl|sqlite>` copies the store the config names into a new
store of the other kind, beside it in the same directory (`log.sqlite` and
`plugins.sqlite` for `sqlite`; `runs/`, `inputs.jsonl`, `outcomes.jsonl`,
`plugins/facts.jsonl` and `schema.json` for `jsonl`). It keeps every step, its
time and cause, every run and what each object held. The current store is not
changed, and `triggers/`, `logs/` and the plugins' directories stay where they
are, shared by both. It refuses while `operad serve` or a run is going, and when
the new store's files exist already (move them away first). `operad store use
<jsonl|sqlite>` then changes `store` in `config.json` to the copy; changing it
back is the same command. `use` refuses a copy when the store it was copied from has been written to since; remove the copy's files and copy again.

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
<sub>run 01bb7a85-d171-4d83-81d0-8990b77dab78</sub>
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
- The MCP `list` tool takes `root` and `parent` too; see `docs/mcp.md`.

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
| task | `active` (default) | proposed, ready, running, review, waiting, paused |
| task | `done` | merged |
| task | `cancelled` | cancelled |
| plan | `active` (default) | draft, confirmed, paused |
| plan | `done` | finished |
| plan | `cancelled` | cancelled |
| repo | `active` (default) | active |
| repo | `removed` | removed |

## Where `dev` commands run

A `dev` command takes its repository from the directory, from `--repo <name>`
or from a qualified id such as `operad/T-0045-shell-hang-guards`; a bare id
outside a repository works when only one repository has it. The rules are in
[packages/dev/README.md](../packages/dev/README.md#where-a-command-runs-and-ids).

## Asking a person from a step

A step can ask a person a question and carry on with the answer. The step calls
`ctx.ask`; a flow cannot.

```ts
const answer = await ctx.ask({
  prompt: "Delete the stale branch?",
  choices: ["yes", "no"],
  graceSecs: 120,
  onTimeout: "waiting",
  resume: { session: "abc" },
});
```

`ctx.ask` returns `{ choice, note, actor }`. The question shows up in
`operad pending` and `GET /v1/pending` as one item, with the run's object, like
any other wait.

**The grace.** While the step's process is alive the answer goes straight to the
waiting call and the step goes on. The wait lasts the narrowest of: the
`graceSecs` of the call, the step's `askGraceSecs` param, and `ask.graceSecs` in
`config.json` (default `600`). `0` does not wait. There is no unlimited value.
The step's own timeout does not run while it waits for an answer.

```json
{ "ask": { "graceSecs": 600 } }
```

**When the grace passes.** `onTimeout` decides:

| `onTimeout` | What happens |
|---|---|
| `"waiting"` (default) | The step ends with the result `waiting` and the data `{ waitId, prompt, choices, resume }`. The flow must have an edge `waiting` to a `wait_person` step; that step shows the same item (same wait id) and an answer to it takes the edge the choice names. |
| `"reject_once"` | The call returns `{ choice: undefined, rejected: true }` and the step goes on. |

A step that asks with `onTimeout: "waiting"` (the default) must declare
`waiting` in its `results`. If it does not, `ctx.ask` fails at once, before
anything is asked, with an error that says so; otherwise the question would be
lost when the grace passed. A step that only ever uses `"reject_once"` does not
need `waiting`.

A flow where a step can end `waiting` and has no `waiting` edge to a
`wait_person` step is refused when it loads.

A step asks one question at a time. A second `ctx.ask` while the first has no
answer yet fails at once with `a step asks one question at a time`.

`graceSecs` (the call, the step's `askGraceSecs` and `ask.graceSecs` in
`config.json`) is a number of seconds from `0` to `2147483` (about 24 days);
anything above is refused with a message.

**One answer.** The first answer to a question counts. A second one is refused
with `already answered`. An answer that comes after the step ended, when its
flow wait was not reached, is refused and recorded in `operad history` as
refused. An answer to a question that was already answered is never applied
twice, also not after a crash.

**After a crash.** A question has a stable id, `<run>:<step run>:<n>`. If the
process stops while it waits, a step that is safe to run again asks again with the
same id, so the item stays one; an answer that came in meanwhile is given to the
step from the log. If the process stops after the step ended `waiting`, the
flow wait is reached on restart with the same id.

**Carrying on after the answer.** When the person answers the wait that a
`waiting` step left, the step that asked runs again, also when the flow goes
through other steps on the way from the wait back to it (those run with their own
params; the answer waits for the asking step). The step runs again with its
params plus:

| param | what it holds |
|---|---|
| `resumeSession` | the session the step left in `resume` (`resume` as a string, or `resume.session`) |
| `askAnswer` | `{ prompt, choice, note }`: the question and the answer |

A harness step adds one paragraph to the prompt: `You asked: <prompt>. The answer
is: <answer>. Continue.` The prompt and the choice are put on one line. A note
the person wrote is quoted after it, each line behind `> `, and marked as part
of the answer, not as an instruction.

If `resume` is `{ session, grant: { kind, value } }`, with `kind` `"command"` or
`"path"` and `value` the exact command or path the step asked about, the run
also gets a one-time permission for that call in `access.grants`
(`{ waitId, kind, value, tool? }`). Only the choice that approves gives it:
`grant.choice`, which is required when the question has choices and must be one
of them (`ctx.ask` refuses the question before anyone is asked otherwise). A
question without choices gives the permission only for the answer `approve`.
A path grant also names the `tool` the person approved (`write` is not `read`);
`ctx.ask` refuses a path grant without one. A harness lets a call that
equals `value` exactly through once: it uses the permission up (recorded in
`operad history` as "let one call through that you approved", before the call
runs, so a crash cannot give it twice), a second identical call is checked
against the profile as usual, and a different call is too.

A step type that cannot run again from where it left (`resumable: false` in its
definition) cannot be asked with `"waiting"`: its questions are forced to
`onTimeout: "reject_once"`. `harness-pi`, `harness-claude` and `harness-radian` all resume.
`harness-radian` cannot enforce a one-time permission (no hook sees its tool
calls); a step type that says `grants: false` has `ctx.ask` refuse a question
that offers one, before anyone is asked. If a run still reaches radian with one,
it fails with `grant_unsupported`. A resumed radian run that answers with another
session than the one it was given fails with `session_missing`.

## Limiting runs of one model

A provider may answer HTTP 429 when several runs use one model at once. The
`harness-radian`, `harness-pi` and `harness-claude` plugins can limit that. Set `concurrency` in
the plugin's `settings`:

```json
{
  "plugins": {
    "harness-pi": {
      "module": "@operad-io/harness-pi",
      "settings": { "concurrency": { "opencode-go/deepseek-v4.1-flash": 2 } }
    }
  }
}
```

| Setting | Type | Default | What it does |
|---|---|---|---|
| `concurrency` | object, model name to integer | `{}` | How many agent runs of that model may go at once in this home, across all runs. Each count must be an integer of 1 or more; `0`, a string or a fraction refuses the plugin when `config.json` loads, and the log names `settings.concurrency`. A model that is not listed has no limit. |

The count covers every agent run in the home, including the ones `dev` starts.
A change takes effect with the next agent step that starts; steps already going
keep their place.

The limit is on a key, and the plugin builds it from the step's `args`:

| Plugin | Key | Where the model comes from |
|---|---|---|
| `harness-pi` | `harness-pi:<model>` | the `--model` argument, else the plugin's `model` setting; with neither, the step is not limited |
| `harness-claude` | `harness-claude:<model>` | the `--model` argument, else the plugin's `model` setting; with neither, the step is not limited |
| `harness-radian` | `harness-radian:<provider>/<model>` | the `--provider` and `--model` arguments only (the model alone when there is no `--provider`); radian has no `model` setting, and a step without `--model` is not limited |

The model is read from the step's own `args`, in either `--model value` or
`--model=value` form; when a flag is repeated the last one counts. A model that
only a flow's `args` names is not seen.

A step over the limit waits in line, first come first served, and
`operad running` prints one line per run: the object id (the run id when there is none), the step, the step time, the title and a trailing `run <age>`, for example
`operad/T-0048-type-filters  review  3m 10s  Object type filters  run 4h 09m`.
It (and `GET /v1/running`) shows the step as
`<step> queued (<key>, <n> ahead)`, where `<n>` is how many waiting steps are in
front of it. `operad history` shows `<step> is queued`. If the step is stopped
while it waits (the run is cancelled), it leaves the line, never runs, and ends
as failed with the reason that it was cancelled.

### Long commands under claude

`harness-claude` runs each step as one foreground turn. Nothing moves to the
background, and the tools that only wait for background work are off, so a long
command such as the gate runs to its end inside the turn. The setting
`bashTimeoutSecs` (integer, 1 or more, default `1800`) is the longest one Bash
call may run, in seconds. If claude nevertheless starts a second session after it
gave its result, the step ends `failed` with a message that says so.

### Long commands under pi

`harness-pi` gives each call of pi's bash tool a time limit, so a command that
never ends (a read from a FIFO nobody writes to) cannot hold a run until its
wall time. The setting `bashTimeoutSecs` (integer, 1 or more, default `1800`) is
the longest one bash call may run, in seconds. It is both the default and the
maximum: a call the model gives no timeout runs under it, and a timeout the model
asks for above it is brought down to it. When a call reaches the limit, pi stops
the command and its children and the model gets an error that says the command
timed out; the run goes on, so the model can try something else. A value that is
not an integer of 1 or more (0, a negative number, a string) is refused when the
plugin loads, with the field path. The setting is read when a step starts, so a
change takes effect with the next agent step.

The default is 1800 s (30 minutes), the same as `harness-claude`, because a gate
such as `bash scripts/verify.sh` (install, type-check and the whole test suite)
runs in the foreground inside one call and must not be cut short. A project whose
gate is faster can set a lower value to catch a stuck command sooner.

`stallSecs` is unchanged: it measures silence while no tool call is open, and an
open tool call is not a stall (see the README of `harness-pi`). The time limit
above is what bounds a single tool call.

### The agent's shell and the user's aliases

An alias or function from the user's own shell setup, such as `ls` defined as
`eza --git --hyperlink`, must not change what a command in an agent run does.

- `harness-pi`: pi runs each command as `bash -c` (a non-interactive shell with
  no rc files, so no aliases or functions). The worker also removes `BASH_ENV`
  and `ENV` from its environment, the two variables that make a non-interactive
  shell read a file.
- `harness-radian`: radian runs `/bin/sh -c`, which reads no user setup.
- `harness-claude`: claude's Bash tool sources a snapshot of the user's
  `~/.zshrc` or `~/.bashrc` before each command, and claude has no
  supported switch (environment variable or setting) that turns the snapshot
  off. `CLAUDE_CODE_SHELL` only picks which of zsh and bash is used; the
  snapshot is read from the home directory. operad does not work around this: a
  user whose rc file defines an alias that hangs (or changes the output of) a
  common command should guard it there, for example `[[ -o interactive ]]`
  around the alias, or define it only in a file that agents do not read. The
  `bashTimeoutSecs` limit above still stops a hung command after its time.

## Sharing agents between flows: the `pool` plugin

Agent runs cost an account, not a repository: one Claude or Codex login serves
every repository on the machine. The `pool` plugin has one step, `pool/agent`,
that picks a worker with room, runs that worker's harness step and hands the
result back. A flow that uses it (the `dev` flow does) describes its workers;
the home says how many runs one harness may have in all.

The plugin is shipped but not installed by `operad init`; `operad plugin enable
pool` adds it.

### Home: `settings.harnesses`

```json
{
  "plugins": {
    "pool": {
      "module": "@operad-io/pool",
      "settings": { "harnesses": { "harness-pi": 2, "harness-claude": 1 } }
    }
  }
}
```

| Setting | Type | Default | What it does |
|---|---|---|---|
| `harnesses` | object, harness plugin name to integer | `{}` | How many runs through `pool/agent` may go at once in this home for that harness, across all repositories and flows. A run of `harness-claude/agent` counts under `harness-claude`. Each count must be an integer of 1 or more; `0`, a string or a fraction refuses the plugin when `config.json` loads, and the log names `settings.harnesses`. A harness that is not listed has no cap. |

A change takes effect with the next `pool/agent` step that starts; steps already
going keep their place. Only runs that go through `pool/agent` count: a flow
that calls a harness step directly does not, and the per-model `concurrency`
limit of the harness still applies to every run.

### A flow: `workers` and `pools`

A flow's settings, at every level it can be set, may define workers and group
them into pools. These are the fields; the parser behind them is shared, so
every flow refuses the same mistakes in the same words.

| Field | Type | Default | What it does |
|---|---|---|---|
| `workers` | object, worker name to worker | required | The ways this flow can run an agent. At least one worker. |
| `pools` | object, pool name to list of worker names | one pool named `default` with every worker in the order written | Groups of workers a step picks from. Each list is non-empty and names only workers of `workers`. |

A worker has these fields; any other field is refused.

| Field | Type | Default | What it does |
|---|---|---|---|
| `use` | string | required | The harness step to run, as `<plugin>/<step>`, such as `harness-claude/agent`. |
| `args` | array of strings | `[]` | The arguments given to that step, such as `["--model", "sonnet"]`. |
| `count` | integer, 1 or more | `1` | How many runs of this worker may go at once for this flow. |
| `wallTimeSecs` | number, above 0 | unset | The wall-time limit passed to the harness step. |
| `stallSecs` | number, above 0 | unset | The stall limit passed to the harness step. |
| `fallback` | string | unset | Another worker of `workers` to run once when this worker's model is unavailable. |

Two workers may use the same harness with different arguments (`pi-flash` and
`pi-pro`); together they count against that harness's home cap.

Each refusal names the path of the bad value, for example
`workers.claude.fallback`:

- `workers` or `pools` is not an object, `workers` is empty, `pools` is empty.
- A worker is not an object, has a field not in the table, a `use` that is not
  `<plugin>/<step>`, `args` that is not a list of strings, a `count` that is not
  an integer of 1 or more, or a `wallTimeSecs` or `stallSecs` that is not above 0.
- A pool is not a non-empty list, or names a worker that `workers` does not have
  (`pools.default[1]`).
- A `fallback` names an unknown worker, the worker itself, a worker that has a
  `fallback` of its own (a chain is one step; two workers that name each other
  are a cycle), or is not a string.

### The step `pool/agent`

Its params are `prompt`, `cwd`, `prefix` (the key for the flow's counts; the
caller passes `<repository>/<pool>`), `workers` (the pool's definitions in
order, each with its `name`), optionally `fallbacks` (workers outside the pool
that a member's `fallback` names) and `worker` (a worker the caller requires,
such as the one that did the first attempt), plus anything the harness step takes.

1. It picks the first worker in order whose own count under `prefix` has room
   and whose harness has room under `settings.harnesses`. With `worker` set only
   that worker may run; a name not in `workers` ends the step `failed` with
   `data.reason` `unknown_worker`.
2. When none has room it waits, without an error, until a run ends. It sends
   the event `pool.waiting` once for each reason: `data.full` is `flow` when the
   flow's counts are full and `home` when a harness's home cap is full. A
   stopped step leaves the line and ends `interrupted`.
3. It runs the worker's `use` with the params, the worker's `args`,
   `wallTimeSecs` and `stallSecs`, and returns the result unchanged, adding to
   `data`: `worker`, `harness` and, after a fallback, `fallbackFrom` (the worker
   that failed).
4. When the result's `data.modelError.kind` is `unavailable` or `usage_limit`,
   or the harness step cannot start (it threw, or it ended `failed` with
   `data.reason` `missing` or `spawn`), and the worker has a `fallback`, it runs
   that worker once, after giving back the first worker's places and waiting for
   the fallback's own room. A timeout (wall time or stall) never falls back, and
   the fallback's own failure is returned as it is.

Where the counts live: every step runs in its own worker thread, so the places
are kept in one file under the home, `pool/places.json`, changed under a lock
file. Steps in any thread or process of the home see the same counts. A place
records the process that holds it; when that process is gone (a crashed serve)
the place is dropped the next time a `pool/agent` step looks.

## `dev.json`: workers and pools

The `dev` plugin's work step runs every task through `pool/agent`, so `dev`
needs the `pool` plugin enabled (`operad plugin enable pool`). The repository
chooses its workers in `<repository>/.operad/dev.json`; `dev` reads that file in
the registered repository's main clone, never the copy in a task's worktree,
which carries whatever the task's branch had when it started.

| Field | Type | What it does |
|---|---|---|
| `workers` | object | The repository's workers. Same fields as in [A flow: `workers` and `pools`](#a-flow-workers-and-pools); that table is the one place the worker fields, defaults and refusals are listed. |
| `pools` | object | Pool groups. `dev` uses the pool named `default`, so a `pools` setting must define it. Without `pools`, `default` holds every worker in the order written. |
| `concurrency` | integer, 1 or more | An extra cap on running tasks; see below. |

```json
{
  "workers": {
    "claude": { "use": "harness-claude/agent", "args": ["--model", "sonnet"], "fallback": "pi" },
    "pi": { "use": "harness-pi/agent", "args": ["--model", "opencode-go/deepseek-v4.1-flash"] }
  },
  "pools": { "default": ["claude", "pi"] }
}
```

Errors in `workers` and `pools` name the field path, such as
`workers.claude.fallback` or `pools.default[1]`.

**The old `worker` form.** `worker` (`use`, `args`, `wallTimeSecs`,
`stallSecs`) still works and means one worker named after its harness plugin
(`harness-radian` for `harness-radian/agent`), with `count` equal to
`concurrency`, alone in the pool `default`. Its runs count under the home cap of
its harness like any worker's. A file that has both `worker` and `workers`, or
`pools` without `workers`, is refused when it is read.

**How many tasks run at once.** A repository runs at most as many tasks as the
sum of the `count` of the workers in its `default` pool. When the file sets
`concurrency` it caps that sum further and never raises it. A plan's own
`concurrency` still applies on top of this. A task past the cap waits for a
free place; one past a worker's own `count` or the home cap waits in
`pool/agent`.

**Which worker.** The work step passes the `default` pool and the key
`<repository>/default` to `pool/agent`. The attempt records the `worker` that
ran (after a fallback, the fallback worker, with `fallbackFrom` naming the one
that failed), and the work result says `work: claude` or
`work: pi (fallback from claude)`. After a rework or a reject, the next work
attempt asks for the worker of the attempt before, so it resumes that worker's
session when the harness can. If that worker is busy the work waits for it;
another worker does not take it. If the worker is no longer in the `default`
pool the pool picks any worker with room and the result says
`work: pi; claude is no longer in the pool`.

### One integration at a time

Tasks of one repository integrate one at a time, in the order their merges were
chosen. A task that waits for its turn shows `waiting to integrate: T-0025 is
integrating` in `operad running` and in its step log; it holds no check place and
waits without a time limit. A turn is given back when the integration ends in
any way, including when its process dies.

`integration.batch` in `dev.json` (default `1`, one at a time) lets a turn merge
the tasks queued behind it: up to that many verified commits go onto main in
queue order as one candidate, the key commands run once, and one push lands
them. Each task keeps its own merge commit and its history says `integrated in a
batch with <tasks>`. A conflict between them or a failing key command falls back
to one by one, so only the task at fault goes back to its worker.

### When `dev.json` is not valid

A repository's `dev.json` is read again by every step and every scheduler pass.
When the file stops being valid (a typo, or a shape the running `serve` does
not know yet, such as after a merge changed what `dev.json` may hold):

- The last valid settings of that repository stay in force. Running steps finish
  with them, the next step of a run reads them too, and the scheduler keeps
  starting and repairing tasks in that repository. A `serve` or a step that
  starts while the file is invalid reads the copy of the last valid settings
  kept in `$OPERAD_HOME/dev/settings/`. Another repository is not affected.
- `serve` writes one line to its log, `dev: repository "<name>": <reason>`, each
  time the file changes to a different invalid state, never once per pass.
- `operad pending` and `GET /v1/pending` show one item for the repository (its id
  is `dev:settings:<name>`, it has no actions): `the repository settings are not
  valid: <reason>; the last valid settings are in use`. The item disappears when
  the file is valid again, and the next breakage is logged again.
- A repository that never had valid settings has nothing to fall back on: the
  item says so and no task starts in it until the file is fixed. Its running
  steps are not touched either.

### When a merge changes the code `serve` runs

The main clone follows a merge when it can (a fast-forward on a clean clone), but
a `serve` that is already running keeps the code it loaded until it reloads
(see Changed code).
When a followed merge changes that code, which means any file under the directory of the kernel (`engine`, `cli`) or
of a package the home loads (source, flows, `bin/`, schemas at any depth,
manifests), `operad pending` shows
`serve runs older code than main: restart it when no check runs (merged <commit>
in <repository>)`, once however many merges followed. Markdown files (docs and the
mutation records), `test/` and `fixtures/` do not count. The item is advice: it
may appear for a change that did not need a restart, but a change to a loaded
package's code or schema always raises it. `serve` restarts itself when the new
code loads and the item goes away with the restart; when the new code does not
load, `serve` keeps the old code and the item stays until the files are fixed.

`dev` also needs the plugins its steps run through. When the home does not load
`pool`, `operad pending` shows `plugin pool is not loaded and dev runs its
workers through it: run `operad plugin enable pool` and restart serve; until
then no new work starts`, and ready tasks stay ready instead of failing. The
item goes away once `pool` is loaded.

### What the views say about the worker

- `operad list task` and the first lines of `operad show` end the row's note
  with the worker of the task's last attempt, name only. A name longer than 16
  characters is cut with `…`; Metrics has the whole name.
- `operad history` has the work line above: `work: claude` or
  `work: pi (fallback from claude)`.
- The task's Metrics section adds a table under the attempts, one row per
  worker, summed over the attempts that worker ran: attempts, cost, time and
  first pass (attempts whose first review round passed, out of the attempts
  reviewed).
- A task from before pools has no worker: the row shows none and Metrics has no
  worker table. `dev` has no repository-level metrics, so there is nothing to
  split there.

```
$ operad list task
T-0044-views   Worker views   running   $0.35  pi
$ operad section T-0044-views metrics
| worker | attempts | cost | time | first pass |
| --- | --- | --- | --- | --- |
| claude | 2 | $0.30 | 4m10s | 1/2 |
| pi | 1 | $0.05 | 1m02s | 0/1 |
```

## Usage and end results

Every agent step records what the run used in one field of its data, `usage`,
and ends with one of a fixed list of results. Cost, metrics and budgets read
this one form, whichever harness ran.

`usage` has these fields:

| Field | Type | Meaning |
|---|---|---|
| `harness` | string | The harness plugin that ran, such as `harness-pi`. |
| `model` | string or `null` | The model as `provider/id` when the step named it; `null` when it did not. |
| `tokens.input` | integer, 0 or more | Input tokens. |
| `tokens.output` | integer, 0 or more | Output tokens. |
| `tokens.cacheread` | integer, 0 or more | Tokens read from the provider's cache. |
| `tokens.cachewrite` | integer, 0 or more | Tokens written to the provider's cache. |
| `costMicros` | integer, 0 or more, or `null` | The cost in millionths of a dollar. `null` means the cost is unknown; `0` means the run was free. |
| `costQuality` | `exact`, `estimated`, `incomplete` or `null` | How far to trust `costMicros`. `exact` is the price the provider billed; `estimated` was worked out from a price list; `incomplete` priced only part of the run (some message had no price), so the real cost is higher. `null` exactly when `costMicros` is `null`. |

A count the harness does not report is `0`. Facts written before this field
existed keep their old fields (`usage` with `input`, `output`, `cache_read` and
`cache_write`, and `cost` with `micros`, `incomplete` and `estimated`); they are
still read, and nothing writes them any more. A `usage` that is not in the
standard shape is ignored and the run's log gets one line naming the run and the
field.

`dev` shows a cost's quality as a symbol in a task's row and in its metrics:
`$0.31` is exact, `~$0.31` is estimated and `≥$0.31` is incomplete (at least
that much).

A plan's row note reads `1/8 · ~$4.20 · merge · P2 // 2`: merged tasks over
tasks (cancelled ones are not counted), the total cost of the plan's tasks at
the weakest quality among them (left out while no task has a cost), the auto
level, the priority, and after `//` how many of the plan's tasks may run at
once. A task's note reads `$0.31 · harness-claude · area: app-core`: the cost
(`$0.00` before there is one), the worker, the area (or `waiting for area
app-core (T-0023-action-numbers)`), and last a refused push's message. A
repository's note reads `plans: 1 · tasks: 4`, counting open ones.

A step ends with one of these results:

| Result | Meaning |
|---|---|
| `done` | The work finished. |
| `nothing` | There was nothing to do. |
| `failed` | The step could not do its work. |
| `needs_decision` | The step needs a person to choose. |
| `waiting` | The step stopped to wait, and will continue. |
| `interrupted` | The step was stopped before it finished. |

The end results apply to plugins of the `harness` kind: they run an agent, and
a flow reads any agent the same way. `operad plugin check` refuses a harness
step that declares another name and names it. The agent steps of
`harness-radian`, `harness-pi` and `harness-claude` declare `done`, `failed` and `interrupted`.
Plugins of other kinds name their own results. `shell` is a `stage`, not a
harness: its steps run a command or a check and give a verdict, so they end in
`pass` and `fail` (and `ready` or `waiting` for a check), and the end results
do not apply to them.

## Checking a change

```sh
bash scripts/verify.sh
bash scripts/check-changed.sh
bash scripts/remote-check.sh '<command>'
```

`verify.sh` installs with the lockfile, type-checks and runs the whole test
suite with `scripts/run-tests.sh`. That script runs the test files in parallel
worker processes (`bun test --parallel`), and the `tui` package afterwards, one
file after another, because its terminal library does not load in a parallel
worker. `OPERAD_TEST_PARALLEL` (a whole number of 1 or more, default `2`) is the
number of worker processes; any other value stops the script with a message
that names the variable. Given package names (`bash scripts/run-tests.sh dev
shell`), it runs only those packages' tests. `check-changed.sh` installs and type-checks the same way, then tests only
the packages a change touches: every package with a file changed since the merge
base of `HEAD` and `origin/main` (committed, staged, unstaged or untracked), and
every package whose code loads one of those, directly or through others. A
package whose tests, not its code, load a changed package has its tests run too;
that goes no further. A change outside `packages/` (the lockfile, the root
manifest, `scripts/`, `docs/`, `.operad/`) tests every package. It prints the
packages it chose before the tests (`all`, `none`, or the names).
`OPERAD_CHECK_BASE` (a commit, default the merge base) changes what it compares
with. This repository's task check runs `check-changed.sh`, and its integration
runs `verify.sh`.

`remote-check.sh` runs one command (a shell line) as a check. With
`OPERAD_CHECK_HOST` unset or empty it runs the line here, in the repository
root. With it set to an ssh destination (`user@host`) it copies `HEAD` to that
host as a git bundle, and there, holding one of `OPERAD_CHECK_SLOTS` slots
(the lock `~/.operad-check-<i>.lock`; it waits only when all are taken), fetches
`origin` and the bundle, checks out `HEAD`'s commit detached, removes untracked
files except `node_modules`, and runs the line. Each slot has its own tree, so a
checkout or clean in one never touches another: slot 1 uses the clone
`OPERAD_CHECK_TREE` (`~/Code/operad`), and every other slot uses a git worktree
of that clone made on first use, `<tree>-slot<i>` (for example
`~/Code/operad-slot2`), with its own `node_modules` once the line installs. With
`OPERAD_CHECK_LANE=integration` the check takes the one integration slot instead
(lock `~/.operad-check-integration.lock`, worktree `<tree>-integration`): an
integration never waits for a task check, and a task check never takes that
slot. The line sees `OPERAD_CHECK_SLOTS` on the host, so a check can use
`cores / (N + 1)` test workers. The output comes back as it is written and the
exit code is the line's; a failure before the line runs (bundle, copy,
connection, fetch, checkout) exits 1 with one line that names the step. The host
needs a clone of
the repository and Bun.

| Variable | Type | Default | What it does |
|---|---|---|---|
| `OPERAD_CHECK_HOST` | ssh destination | empty | Where the check runs; empty runs it here. |
| `OPERAD_CHECK_TREE` | path | `Code/operad` | The clone on the host, relative to its home directory. |
| `OPERAD_CHECK_SLOTS` | whole number, 1 or more | `1` | How many task checks run at once on the host; any other value stops the script. |
| `OPERAD_CHECK_LANE` | `integration` | unset | `integration` takes the integration slot instead of a task slot; any other value stops the script. |
| `OPERAD_CHECK_PATH` | directories | `$HOME/.bun-operad/bin:$HOME/.bun/bin` | Put first on the host's `PATH` before the line runs, expanded on the host. |
| `OPERAD_CHECK_SSH` | command | `ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=4` | The ssh command. |
| `OPERAD_CHECK_SCP` | command | `scp -q -o BatchMode=yes` | The scp command. |

Each variable is read when the script starts.

## Reproducing a flaky test

```sh
bash scripts/stress.sh [--runs N] [--load K] [-t <name pattern>] <test files...>
```

The script runs `bun test` on the files with `--rerun-each N` (default 50) and
`--timeout 30000`. `-t` limits the run to tests whose name matches the pattern.
`--load K` starts K busy background processes for the length of the run (one
loops forking a short process, the rest spin), never more than the CPU count, to
imitate a gate under load; they are stopped when the script exits, however it
exits.

It prints the number of runs, passes and failures, each failing test name with
its count, and the path of the full log, and exits 1 when anything failed, when
no test ran, or when bun itself failed. A fix for a flaky test is done when a
stress run with `--load 2` passes whose `--runs` is chosen to take about ten
minutes (at least 20, at most 200); run one stress run at a time.

## Notifications

`notify` in `config.json` names a command for `serve` to run when something
starts waiting for a person:

```json
{ "notify": { "command": "sh ~/.operad/notify.sh", "on": ["waiting"] } }
```

| Key | Type | Default | What it does |
|---|---|---|---|
| `command` | string or `null` | `null` | A shell line, run with `sh -c` in the operad home. `null` turns notifications off. |
| `on` | array | `["waiting"]` | What starts the command. `waiting` is the only value: an object now waits for a person. |

The command runs once per item and wait, with these in its environment:

| Variable | Value |
|---|---|
| `OPERAD_ID` | The object, as `<type>:<id>`. |
| `OPERAD_TITLE` | The object's title, or its id when the title cannot be read. |
| `OPERAD_REASON` | What it waits for: the prompt shown in `operad pending`. |
| `OPERAD_LINK` | The object link, `operad://objects/<id>`. |

For a task of the `dev` plugin the prompt names the step it stopped at; the
specific reason (`ready to merge`, `review findings`, ...) is in the task's
`dev.waiting` notice, which `docs/dogfood.md` lists.

The token is never in the environment. A command runs for at most 30 seconds,
then it is stopped. Any exit other than 0, a timeout, or a command that cannot
start is logged by `serve` with its exit code and the last lines of its output,
and is not retried.

Each wait notifies once. A wait is one run reaching one step one time: the same
item that waits again, after you answered, is a new wait and notifies again. A
restart of `serve` does not notify again for a wait that already did. The
notice is recorded after the command has ended, so if `serve` is killed in
the moment between the two, the next `serve` runs the command once more for
that wait: at most one extra notification, never a lost one. Stopping `serve`
cancels a command that is still running, and the next `serve` runs it again.

Example with [ntfy](https://ntfy.sh): a push to your phone that opens the item
in the app when tapped.

```sh
#!/bin/sh
# ~/.operad/notify.sh
curl -s \
  -H "Title: $OPERAD_TITLE" \
  -H "Click: $OPERAD_LINK" \
  -d "$OPERAD_REASON" \
  https://ntfy.sh/my-operad-topic
```

with `"command": "sh ~/.operad/notify.sh"`. A topic name is a password for
anyone who guesses it; pick a long random one or use a self-hosted server.

## Chats

A chat is a long conversation with an agent. The `chat` plugin comes with
`operad init`; a chat belongs to the plugin that opens it. `dev` opens one on a
repository:

```
operad dev:chat --repo operad --title "The build" [--harness harness-pi]
operad chat:send C-0001 --note "why does the gate fail on main?"
operad show C-0001 --section transcript
```

`dev:chat` offers `harness-claude` and `harness-pi` (the first one loaded when `--harness` is left out): they can stop a tool call before it starts, which a read-only chat needs. `harness-radian` is refused there and stays for assistant chats.

`chat:send` records the message and sends an event (source `ios`, `telegram` or
`cli`, key = the message id, about the chat). The plugin's own rule starts
`chat:reply` for each of the three sources, automatically; a rule of yours in
`triggers.json` with the same source and type replaces it. The reply reads the
messages no reply answers yet from the chat's own record, continues the harness
session, records the reply, and goes round again while new messages came in
meanwhile (at most 20 rounds). After a restart a reply that was already
recorded is not given twice.

A chat on a repository works in the main clone, read-only: a shell command runs
there only when it is on a short list of commands that only read (`git status`,
`ls`, `cat`, `grep`, `sed -n`, `bun test`, ...); every other command, and every
write, becomes the worktree question. When the agent wants
to change code it asks whether to open a worktree. On yes, `dev` opens
`work/chat-<id>` and the chat works there from then on, once; the main clone
stays read-only. The worktree's changes reach main only through a task that
points at it, through the normal gate and integrate.

The agent reaches operad through its tools (`list`, `show`, `section`, `pending`,
`running`, `history`, `command`, `act`, under the same allow lists as
`operad mcp`), never by running `operad` in a shell.

## MCP server

`operad mcp` runs an MCP server on stdio for a lead agent. It reads the same
objects, pending items, running items, sections and history as the commands,
and it runs the plugin verbs and lead actions `config.json` allows. It never
starts a step or takes an owner decision; only `operad serve` runs steps, and
the actions left out of `mcp.actions` stay in the command line or the app. The
protocol, tools and error mapping are in `docs/mcp.md`; stdout carries only
JSON-RPC and logs go to stderr.

Claude Code finds the server in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "operad": {
      "command": "operad",
      "args": ["mcp"]
    }
  }
}
```

The server uses `$OPERAD_HOME`, or `~/.operad` when it is unset. Set
`OPERAD_HOME` in the entry's `env` when the agent should read another home.

### Claude Code channel

`operad mcp --claude-channel` turns the server into a one-way channel: it
declares the experimental `claude/channel` capability and sends
`notifications/claude/channel` when an object's state, waiting flag or running
flag changes. It never declares `claude/channel/permission` and never relays a
permission prompt. Without the flag the server sends no notification and
declares no experimental capability.

The server watches both the objects and the flows, so a wait that opens or a
step that starts is reported even when no object is written (a change another
process makes is found by a poll, 500 ms by default). It sends nothing until the
client has sent `notifications/initialized`, then sends what changed since the
start. At start the server reads the current rows and sends nothing for them. Every
later notification has a one-line `content`, `<id> <old state> -> <new state>`
with `: <note>` when the row has one, and string `meta` with `id`, `type`,
`state`, `previous`, `waiting` and `running`. An object seen for the first time
after the starting read has `previous` set to `new`. The channel is one-way;
use `show`, `section`, `pending` and `history` for the details.

`--types <t,…>` limits the channel to some object types, separated by commas.
The default is every type with views; a name that is not one is a usage error.
For example:

```json
"args": ["mcp", "--claude-channel", "--types", "task"]
```

Claude Code enables the extension with its development-channel flag, naming the
server from `.mcp.json`:

```sh
claude --dangerously-load-development-channels server:operad
```
