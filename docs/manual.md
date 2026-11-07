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
  "http": { "enabled": false, "port": 7480, "listen": ["127.0.0.1"] }
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

### Endpoints

All endpoints are under `/v1`. Responses are JSON unless the endpoint says
otherwise. An object id in a path is URL-encoded; `<id>` may be the bare id or
`<type>:<id>`.

| Method and path | What it returns |
|---|---|
| `GET /v1/types` | `{ "types": [{ "type": "task", "title": "Task" }] }`: the object types with views and their display names. |
| `GET /v1/objects?type=<type>&cursor=<c>` | `{ "rows": [...], "next": "<c>" }`: one page of the list. `rows` carry the plugin's `id`, `title`, `state` and optional `note`, plus `waiting` and `running`; an error row also carries `error`. |
| `GET /v1/pending` | The same list as `operad pending`, with the actions each item offers. |
| `GET /v1/running` | The same list as `operad running`. |
| `GET /v1/objects/<id>` | `{ "id", "type", "row", "sections", "actions" }`: the row, the section directory, and the actions available now with their `args` schema, `note` field and `confirm` flag. |
| `GET /v1/objects/<id>/sections/<section>?cursor=<c>&full=<bool>` | `{ "markdown": "...", "next": "<c>" }`. `full=true` skips the size cap. |
| `POST /v1/act` | Runs one action. The body is `{ "action": "plugin:action", "id": "<id>", "args": {...}, "note": "...", "confirmed": true }`; only `action` is always required, and an action that targets an object also needs `id`. An action with `confirm: true` needs `"confirmed": true`. The body is at most 1 MiB; a larger one gets `413`. |
| `GET /v1/events` | An SSE stream of changes. |

`POST /v1/act` records the caller as `{ "via": "http", "id": "operad app" }`.
It records the action the same way the command line does, and a running
`operad serve` carries on the steps a waiting run asks for.

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
