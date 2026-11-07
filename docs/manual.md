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
  relative path resolves against the home.
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
| `--token` | string | The token in `$OPERAD_HOME/secrets/http.json` | The bearer token of the running `serve`. |
| `OPERAD_HOME` | environment variable | `~/.operad` | The directory holding `config.json`, `secrets/http.json`, `serve.lock` and the `serve.log` a started `serve` writes. |
| `http.listen` | array of strings in `config.json` | `["127.0.0.1"]` | IP literals `serve` may listen on; the first one is the default TUI address. |
| `http.port` | integer in `config.json` | `7480` | `0` to `65535`; the TUI needs the port `serve` actually uses, so `0` needs `--url`. |

`operad tui` uses the terminal size: at 100 columns or wider the list and the
object pane sit side by side, and below 100 columns the list fills the screen
and an open object replaces it until `escape`. The header counts Pending and
Running and then names every object type from `/v1/types`. The right pane says
`select an object` until a row is opened. `enter` opens the selected row with
`GET /v1/objects/<id>`: the pane starts with that row (id, title, state, note
and mark), then the section tabs in the server's order (History last), then the
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
Switching tabs closes the object. Every key the app reads is below.

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
| `r` | key | none | Fetch every list again, and the open object with its live sections. |
| `?` | key | none | Show or hide the key list. |
| `q` | key | none | Quit. |
| `Ctrl-C` | key | none | Quit at once. The terminal restores itself; no other Ctrl or Meta chord does anything. |
| `escape` | key | none | Close the key list, or close the open object and stop its requests. While the key list is open only `?`, `escape` and `q` act; the others leave the list alone. |

### Endpoints

All endpoints are under `/v1`. Responses are JSON unless the endpoint says
otherwise. An object id in a path is URL-encoded; `<id>` may be the bare id or
`<type>:<id>`.

| Method and path | What it returns |
|---|---|
| `GET /v1/types` | `{ "types": [{ "type": "task", "title": "Task" }] }`: the object types with views and their display names. |
| `GET /v1/objects?type=<type>&cursor=<c>` | `{ "rows": [...], "next": "<c>" }`: one page of the list. `rows` carry the plugin's `id`, `title`, `state` and optional `note`, plus `waiting` and `running`; an error row also carries `error`. |
| `GET /v1/pending` | The same list as `operad pending`, with the actions each item offers. An item that is about an object also carries `object` (`<type>:<id>`), its `link` and its `row`: the same row `GET /v1/objects?type=…` returns for that object (`id`, `title`, `state`, optional `note`, `waiting`, `running`), so a client does not read each object. When the row cannot be built (the object is gone, no loaded plugin shows its type, or the plugin's row fails) the item carries the error row the list shows for a bad row, with `state` `error` and an `error` message; the list itself never fails for one object. A candidate has no object and no `row`. `operad pending` prints the row's title under each line that has one. |
| `GET /v1/running` | The same list as `operad running`. |
| `GET /v1/objects/<id>` | `{ "id", "type", "link", "row", "sections", "actions" }`: the link that opens the object, the row, the section directory, and the actions available now with their `args` schema, `note` field and `confirm` flag. |
| `GET /v1/objects/<id>/sections/<section>?cursor=<c>&full=<bool>` | `{ "markdown": "...", "next": "<c>" }`. `full=true` skips the size cap. |
| `POST /v1/act` | Runs one action. The body is `{ "action": "plugin:action", "id": "<id>", "args": {...}, "note": "...", "confirmed": true }`; only `action` is always required, and an action that targets an object also needs `id`. An action with `confirm: true` needs `"confirmed": true`. The body is at most 1 MiB; a larger one gets `413`. |
| `GET /v1/events` | An SSE stream of changes. |

`POST /v1/act` records the caller as `{ "via": "http", "id": "operad app" }`.
It records the action the same way the command line does, and a running
`operad serve` carries on the steps a waiting run asks for.

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
`operad running` (and `GET /v1/running`) shows it as
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

`dev` shows a cost that is not `exact` with its quality, such as
`$0.31 (incomplete)`, in a task's row and in its metrics.

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
