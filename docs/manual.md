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
  "http": { "enabled": false, "port": 7480, "listen": ["127.0.0.1"] },
  "notify": { "command": null, "on": ["waiting"] },
  "mcp": {
    "actions": ["dev:rework", "dev:reverify", "dev:reject", "dev:priority"],
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
| `actions` | array of `plugin:action` strings | `["dev:rework", "dev:reverify", "dev:reject", "dev:priority"]` | The actions `operad mcp` may run. Every other action is refused with a message naming it and saying the owner runs it. |
| `confirmActions` | array of `plugin:action` strings | `[]` | The allowed actions that also carry `confirm: true`. Such an action is refused even when `actions` names it unless this list names it too. |

Both lists take effect the next time `operad mcp` starts. They do not change an
action already running. The MCP server never offers the owner's actions as its
own; `show` lists them separately so the lead can tell the owner what to run.

### http

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | Start the HTTP interface with `operad serve`. |
| `port` | integer | `7480` | The port to listen on; `0` asks the system for one. |
| `listen` | array of strings | `["127.0.0.1"]` | The IP addresses to listen on. |

Each `listen` entry is an IP literal. `serve` accepts a loopback address, an
RFC 1918 address (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), a link-local
address (`169.254.0.0/16`, `fe80::/10`) or a Tailscale address
(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). It refuses a wildcard (`0.0.0.0` or
`::`) and every other address, before it opens a port, naming the entry. The
default listens on the machine only.

The first `operad serve` with `http.enabled` creates one bearer token, 32 random
bytes in base64url, in `secrets/http.json`. Every request must carry
`Authorization: Bearer <token>`; a request without it, or with a token that is
not current, gets `401`. `operad http token rotate` replaces the token at once:
a running `serve` refuses the old one from the moment the command returns and
ends the event streams opened with it. No endpoint shows the token.

`serve` prints one line per address it listens on:

```text
http http://127.0.0.1:7480
```

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
`operad://pair?url=<url>&token=<token>`. It needs `http.enabled`, and with no
`--url` an address in `http.listen` that is not loopback.

`pair` is the one command that prints the token. It refuses when its output is
not a terminal, so a pipe or a log never receives it; `--show-token` overrides
that and prints `url`, `token` and the pairing `link` as plain lines, with no
QR code. If you paste the token anywhere, rotate it with `operad http token
rotate`.

### Endpoints

All endpoints are under `/v1`. Responses are JSON unless the endpoint says
otherwise. An object id in a path is URL-encoded; `<id>` may be the bare id or
`<type>:<id>`.

| Method and path | What it returns |
|---|---|
| `GET /v1/types` | `{ "types": [{ "type": "task", "title": "Task" }] }`: the object types with views and their display names. |
| `GET /v1/objects?type=<type>&cursor=<c>` | `{ "rows": [...], "next": "<c>" }`: one page of the list. `rows` carry the plugin's `id`, `title`, `state` and optional `note`, plus `waiting` and `running`; an error row also carries `error`. |
| `GET /v1/pending` | The same list as `operad pending`, with the actions each item offers. An item that is about an object also carries `object` (`<type>:<id>`) and its `link`. |
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

## Limiting runs of one model

A provider may answer HTTP 429 when several runs use one model at once. The
`harness-radian` and `harness-pi` plugins can limit that. Set `concurrency` in
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
`harness-radian` and `harness-pi` declare `done`, `failed` and `interrupted`.
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
