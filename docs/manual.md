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
  "notify": { "command": null, "on": ["waiting"] }
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
- `notify`: a command `serve` runs when something waits for a person; see
  [Notifications](#notifications). It is off while `command` is `null`.

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
| `POST /v1/act` | Runs one action. The body is `{ "action": "plugin:action", "id": "<id>", "args": {...}, "note": "...", "confirmed": true }`; only `action` and `id` are required. An action with `confirm: true` needs `"confirmed": true`. The body is at most 1 MiB; a larger one gets `413`. |
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
