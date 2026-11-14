---
description: The /v1 HTTP interface: the http section, the token, endpoints, events and errors.
---

# The HTTP interface

`operad serve` exposes the `/v1` interface to clients such as the app and the terminal client. This page has the `http` keys and the token, then every endpoint, the row marks and links, the events and the errors. Pairing a phone is on [the app page](app.md); the terminal client is on [its page](tui.md).

## Why it exists

The app and the terminal client run on a different device or in a different process from `operad serve`, and they need the same things the command line has: lists, an object's sections, pending items, actions and settings. This interface gives them that over HTTP. It carries no knowledge of any plugin: a client asks which object types exist, reads each object's row, sections and available actions, and draws them, so a new plugin shows up in a client without a change to the client. Because it can be reached from other machines, it listens on the local machine by default, accepts only loopback, private, link-local and Tailscale addresses, and requires a bearer token on every request.

## How it works

1. `operad serve` binds the addresses in [`http.listen`](#the-http-section) on `http.port` when `http.enabled` is true, and prints `http <url>` for each. The first start creates the bearer token in `secrets/http.json`.
2. A client sends `Authorization: Bearer <token>` with every request, and may name itself in `X-Operad-Client`. A wrong or missing token gets `401`.
3. It learns the shape of the home from `GET /v1/types`, then lists rows with `GET /v1/objects?type=…`. Each row carries a state and optional [marks](#row-marks) the client renders.
4. It opens one object with `GET /v1/objects/<id>`, which returns the row, the section directory, the actions available now and a [link](#links). Each section is read with `GET /v1/objects/<id>/sections/<section>`; see [Reading a section](#reading-a-section).
5. What waits for a person is `GET /v1/pending`. An answer goes to `POST /v1/answer`, and any other action to `POST /v1/act`. Both are recorded the same way a command-line action is, and `serve` carries the run on. An action that asks for confirmation needs `"confirmed": true`.
6. The client does not poll. It keeps `GET /v1/events` open, and each [event](#events) names an object that changed, which the client refetches. After a reconnect with `Last-Event-ID`, the server replays what it still holds or sends `reset`, and the client refetches its lists and open sections.
7. Settings go through `GET /v1/settings` and `POST /v1/settings` ([Settings](#settings)), and files for an action through `POST /v1/uploads`. A failure is a JSON `error` body with a status from the [errors](#errors) table.

## The `http` section

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `http` | object | `{ "enabled": true, "port": 7480, "listen": ["127.0.0.1"] }` | an object with the keys below; a missing section means these defaults | At every command start; `serve` binds when it starts and after a reload | Refused: `http: must be an object` |
| `http.enabled` | boolean | `true` | `true` or `false` | When `serve` starts; a reload opens or closes the interface with the new value | Refused: `http.enabled: must be a boolean` |
| `http.port` | integer | `7480` | `0` to `65535`; `0` asks the system for a port | When `serve` binds; after a reload it binds the new port | Refused: `http.port: must be an integer from 0 to 65535` |
| `http.listen` | array of strings | `["127.0.0.1"]` | at least one non-empty IP literal: loopback, RFC 1918, link-local or Tailscale; a wildcard and every other address are refused | When `serve` binds; after a reload it binds the new addresses | Refused: `http.listen: must be an array of IP addresses`, `http.listen: needs at least one address`, `http.listen: "<address>" is not an IP address`, `http.listen: "<address>" is a wildcard address; name each address to listen on`, or `http.listen: "<address>" is not a loopback, private, link-local or Tailscale address` |

An unknown key inside `http` is ignored; only the keys above are read. Each
`listen` entry is an IP literal. `serve` accepts a loopback address, an
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

A client names itself in the `X-Operad-Client` header, a lowercase word of at most 32 letters,
digits, `-` or `_` (`ios`, `tui`). A message it sends in a chat is recorded and shown as
"via" that name. A request without the header, or with a value that is not such a word, is
recorded as `http`; it is never recorded as `cli`.

`serve` prints one line per address it listens on:

```text
http http://127.0.0.1:7480
```

A second `operad serve` for a home that already has one exits with code 4 before it
reads the store or opens the port.

## Endpoints

All endpoints are under `/v1`. Responses are JSON unless the endpoint says
otherwise. An object id in a path is URL-encoded; `<id>` may be the bare id or
`<type>:<id>`.

| Method and path | What it returns |
|---|---|
| `GET /v1/types` | `{ "types": [{ "type": "task", "title": "Task", "plugin": "dev" }] }`: the object types with views, their display names and the name of the plugin each belongs to (a client groups types by it). A type that declares filters also carries `"filters"`, in display order (`[{ "name": "active", "states": ["proposed", ...] }, { "name": "all" }, ...]`), and `"defaultFilter"`. A type without filters carries neither. Every type of a plugin that declares `objectsUnderSettings` also carries `"settings": true`: such a plugin gets no tab of its own, and its top-level objects belong under settings. |
| `GET /v1/keys` | `{ "keys": [{ "key": "m", "action": "dev:merge", "source": "plugin" }] }`: the key bindings in force, the plugins' defaults with the person's `keys.json` overrides applied; `source` is `user` for an override. |
| `GET /v1/objects?type=<type>&filter=<name>&cursor=<c>` (also `root` and `parent=<id>`, see [Levels](cli.md#levels)) | `{ "rows": [...], "next": "<c>", "hidden": 3 }`: one page of the list. `rows` carry the plugin's `id`, `title`, `state` and optional `note`, `wait`, `mark` and `badge` (see [Row marks](#row-marks)), plus `waiting` and `running`; an error row also carries `error`. `filter` keeps the rows the named filter shows, and `hidden` counts the rows of the type it left out (the whole type, not only this page). Without `filter` the type's default filter applies when it has filters; a type without filters lists every row and has no `hidden`. `filter=all` lists every row and has no `hidden`. An unknown name is a `400` that names the allowed ones. `next` pages within the filtered list. |
| `GET /v1/pending` | The same list as `operad pending`, with the actions each item offers. A question carries `waitId`, the id an answer quotes. A wait that its plugin is about to answer automatically (dev: a passed review of a task in a plan at auto merge) is not listed, so the count does not flicker; it is listed if the automatic answer does not come. An item a plugin raises without a run waiting (`kind` `standing`, no actions, `runId` `<plugin>:<id>`) is in the list too, and goes when the plugin stops reporting it. An item that is about an object also carries `object` (`<type>:<id>`), its `link` and its `row`: the same row `GET /v1/objects?type=…` returns for that object (`id`, `title`, `state`, optional `note`, `mark`, `badge`, `waiting`, `running`), so a client does not read each object. When the row cannot be built (the object is gone, no loaded plugin shows its type, or the plugin's row fails) the item carries the error row the list shows for a bad row, with `state` `error` and an `error` message; the list itself never fails for one object. A candidate has no object and no `row`. `operad pending` prints the row's title under each line that has one. |
| `GET /v1/running` | The same list as `operad running`. Each item has `runId`, `flow`, `step`, `stepLabel`, `queued`, `startedAt` and `elapsedMs` (the run's age), and: `object`, the object's id as rows and `operad show` name it (for example `operad/T-0048-type-filters`), or `null` for a run with no object; `title`, that object's row title, or `null` when there is no object or the lookup failed (a failed lookup never fails the list); `stepStartedAt` and `stepElapsedMs`, when the current step's current attempt started and how long it has run (`null` before the first step); `mark`, the object's row mark (one of the [row marks](#row-marks)), left out when the row has none or cannot be built. The step time starts again when the step changes and on a new attempt. |
| `GET /v1/objects/<id>` | `{ "id", "type", "link", "row", "sections", "actions" }`: the link that opens the object, the row, the section directory, and the actions available now with their `args` schema, `note` field and `confirm` flag. An object whose newest run has ended also carries `lastRun`: `{ "outcome": "done" | "failed" | "cancelled", "reason"?, "endedAt" }`, read from the run's ending, not from the History text. `reason` is the line the run recorded when it ended or, for a failure that recorded none, the message of the step that failed; it is left out when there is neither; `endedAt` is milliseconds since the epoch. An object with no run, or whose newest run is still going, has no `lastRun`. It is not part of the row. |
| `GET /v1/objects/<id>/sections/<section>?cursor=<c>&full=<bool>&after=<mark>` | `{ "markdown": "...", "next": "<c>", "mark": "<m>", "tail": "..." }`. `full=true` skips the size cap. `mark` is an opaque position the finished content goes to and `tail` is the Markdown of the part still changing; a plugin that does not use them sends neither. With `after=<mark>` from an earlier read, `markdown` holds only the finished content after that mark; the answer then also carries `delta`: true when it is that part alone, false when the plugin answered with a whole page and a client must replace instead of append. The size cap covers `markdown` and `tail` together but never cuts `tail`: when both do not fit, `markdown` is shortened first; when even the tail and the truncation note do not fit, the call is refused with an over-cap message naming `--full`. A mark from another section or object is refused with `400`. |
| `POST /v1/act` | Runs one action. The body is `{ "action": "plugin:action", "id": "<id>", "args": {...}, "note": "...", "confirmed": true }`; only `action` is always required, and an action that targets an object also needs `id`. An action with `confirm: true` needs `"confirmed": true`. The body is at most 1 MiB; a larger one gets `413` with `the request body is larger than the 1 MB limit`. An argument the action's schema declares with `"format": "file"` (a string, or a list of strings) takes the `ref` of an upload; the action runs with the path the file is stored at. |
| `GET /v1/settings?scope=<scope>` | Lists the settings a person may tune: `{ "settings": [{ "name", "scope", "value", "default", "description", "type", "enum", "editable", "confirm" }] }`. Without `scope` it lists the global settings and every repository scope; a scope names one repository. A setting that cannot be read in a scope is left out. |
| `POST /v1/settings` | Changes one setting. The body is `{ "name": "<plugin>.<path>", "value": <any>, "scope"?: "<repo>", "confirmed"?: true }`; `name` and `value` are required, and `value` may be `null`. The answer is the changed setting, the same shape as one entry above. An unknown setting name is `404`; a value the schema refuses is `422` with the reason; a setting that is not editable, or asks to confirm without `confirmed`, is `409`. |
| `POST /v1/uploads?name=<file name>` | Uploads a file for an action's file argument. The body is the file itself, streamed; its `content-type` header is kept as the file's type. The answer is `201` and `{ "ref", "name", "type", "size" }`. A file larger than 20 MB gets `413` and a message naming the limit. The `ref` works once: the action that takes it moves the file into the target object's attachment directory under the operad home (`attachments/<type>/<id>/`), and a second use is refused with `400`. An upload no action took within an hour is removed. |
| `GET /v1/attachments/<type>/<id>/<ref>/<name>` | Serves a stored file of an action's file argument, with the type its upload gave. The transcript of a chat links its attachments here. | 
| `POST /v1/answer` | Answers an open question of a pending item. The body is `{ "runId": "<item runId>", "waitId": "<item waitId>", "choice": "<one of the item's choices>", "note": "...", "confirmed": true }`; `runId`, `waitId` and `choice` are required, and `note` and `confirmed` are optional. When every choice is also an action on the item's object (a `dev` wait), it runs that action, so the action's note and confirmation apply; a confirmed action needs `"confirmed": true` just as it does for `/v1/act`. An answer to a question that is already closed gets `409` and is not applied. |
| `GET /v1/events` | An SSE stream of changes. |

An action's `args` may carry JSON Schema conditionals that narrow a field by another: `allOf` holds `{ "if": { "properties": { "agent": { "const": "claude" } }, "required": ["agent"] }, "then": { "properties": { "model": { "enum": [...], "default": "..." }, "effort": { ... } } } }`, one per agent. The new-chat actions (`bot:chat`, `dev:chat`) use it: the top-level `model` and `effort` enums list every loaded agent's choices (a client that reads nothing else still works), and the `then` of the chosen agent holds the list and default that agent takes (the bot's configured model or effort when that agent lists it, else the agent's default). An agent that lists no model or effort has no `model` or `effort` in its `then`: nothing can be picked for it. A client shows the chosen agent's enum and default, and falls back to the top-level one until an agent is chosen. The server does not evaluate the conditionals when it checks a request; it refuses a model or effort the agent does not list by name.

`POST /v1/act` records the caller as `{ "via": "http", "id": "operad app" }`.
It records the action the same way the command line does, and a running
`operad serve` carries on the steps a waiting run asks for. `POST /v1/answer`
records its caller the same way and answers with the same rules as the command
line and a plugin action.

## Reading a section

`GET /v1/objects/<id>/sections/<section>` reads one section. `cursor` takes the
`next` of an earlier read; `full=true` (or `1`) skips the size cap. A section
that has `pages` also answers with the table of contents, so a client can jump:
the first page has no cursor, every other page carries its own.

A live section also carries `mark` and `tail`. `mark` is an opaque position of
the finished content; `tail` is the Markdown of the part still changing (a chat's
unfinished reply and thinking, a running tool call), the whole tail on each
read. To append instead of replacing, pass `after=<mark>` from the last read:
the answer's `markdown` then holds only the finished content after that mark,
and `delta` is `true` when that is all it holds. A plugin that cannot answer
with a delta answers a whole page and `delta` is `false`; the client replaces
its content then. A mark from another section or object is a `400`.

The size cap covers `markdown` and `tail` together, but never cuts `tail`: it
shortens `markdown` first. When even the tail and the truncation note do not
fit, the call is a `400` naming `--full`.

## Settings

`GET /v1/settings?scope=<scope>` reads the settings the same way `operad
settings` does. Without `scope` it returns the global settings and every
repository scope; with it, one repository's settings. Each entry has `name`,
`scope`, `value`, `default`, `description`, `type`, `enum` when it has one,
`editable` and `confirm`. An absent `value` means the setting is not set.

`POST /v1/settings` changes one. The body is `{ "name": "<plugin>.<path>",
"value": <any>, "scope"?: "<repo>", "confirmed"?: true }`. `name` and `value`
are required; `value` may be `null`. The answer is the changed entry. A name
that is not a setting is `404`; a value the schema refuses is `422` with the
schema's reason; a setting that is read-only, or asks to confirm and does not
receive `confirmed`, is `409`. A successful change writes the file atomically
and keeps every other key.

For a setting that holds a map or an object and is editable (`bot.bots`), `name`
may go deeper: `bot.bots.<name>` sets one entry and `bot.bots.<name>.<field>`
one field of it. The server reads the file and writes the entry under the same
lock, so an entry another client changed meanwhile is kept; a client that wrote
the whole map would overwrite it, so prefer the deeper name. The value is checked
against the schema of that entry, and the parent setting's `editable` and
`confirm` rules apply. A path the schema has no entry for is `404`. A `null`
value at a deeper name removes the entry or field. The flows of a repository are settings too. `dev.flows` (scope: the repository)
is editable, whole or by name (`dev.flows.<name>`, `null` removes one), and `dev`
checks the whole `dev.json` as it would be written before it writes it: the
schema, the two hard rules of a flow and a name a TypeScript flow also has. A
change `dev` refuses is `422` with `dev`'s own reason, word for word, and
nothing is written; a client does not repeat the rules. `dev.flowList` is a
read-only setting whose value lists every flow of the repository, TypeScript
ones included: `[{ "name", "source": "dev.json" | "typescript" | "built-in",
"stages"?, "steps"?, "refused"? }]`. A `dev.json` flow carries its `stages`; a
TypeScript flow carries the `steps` (`id`, `kind`, `use`) `dev` reads when it
loads the file, or `refused` with `dev`'s reason when the file breaks a rule. A
TypeScript flow is still saved as a file.

`POST /v1/act` also records the caller as `{ "via":
"<client>", "id": "<token label>" }`; the token label is `operad app` unless the
secret store names another.

## Row marks

A plugin's `row` may return a `mark` and a `badge` besides `id`, `title`, `state`
and `note`. `GET /v1/objects`, `GET /v1/objects/<id>`, the row of a pending
item and the MCP `list` and `show` results pass them through unchanged.

A row may also carry `wait`: why the object waits, as one text, separate from
`note` (dev puts the same text in both, so the note reads as before). A client
that wants the wait on its own line reads `wait` instead of splitting the note
on ` · `, which fails when the wait text contains ` · ` itself. It is a protocol
field; a row that waits for nothing has no `wait`. `operad show --json` and
the HTTP and MCP rows include it.

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

`operad dev task add` and `operad dev task update` take `--after <task>` for a task of the same
repository (any plan) or `--after <repository>/<task>` for a task of any registered
repository. The task is blocked until every task it follows is merged, wherever it is,
and its note says what it waits for (`waiting for operad/T-0188` for another repository).
The named task must exist, and a task cannot follow itself or close a cycle.

`operad dev plan add` and `operad dev task add` take `--flow <name>`, one of the flows the
repository's `.operad/dev.json` defines. A task without `--flow` takes its plan's flow,
and a plan without one takes `default`. `operad dev task update <id> --flow <name>` changes
a task's flow only before its first attempt; after that the command refuses. A task
whose flow dev.json does not define stays ready, and its row and its plan's row say
`flow <name> is not defined in .operad/dev.json`. When the repository defines more than
one flow, the task row's note and the Brief section name the task's flow, and History
names the flow at the start of each run.

`badge` is a short text the client shows as it is, after the state: one line of
at most 16 characters, or the row is an error row. The `dev` plugin sets a
task's badge to `#<attempt>` (`#0` before the first attempt) and marks its tasks
and plans from their phase, the step the attempt has reached and the holds the
scheduler records. `operad list` and the first lines of `operad show` print a
row's badge after its state; a row without one prints as it did without badges.

## Links

An object link is `operad://objects/<id>`, where `<id>` is the object as `get`
takes it, `<type>:<id>`, URL-encoded: `item:a b/c` is
`operad://objects/item%3Aa%20b%2Fc`. `GET /v1/objects/<id>` and each pending
item carry it as `link`, and a notification command gets it as `OPERAD_LINK`.
Opening it in the app shows that object. Following the link's path
(`/v1/objects/<the part after objects/>`) finds the same object.

## Events

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

## Errors

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
| `405` | The endpoint exists but not for that method; the body says `this endpoint takes GET` or `this endpoint takes POST`. |
| `413` | The request body is larger than 1 MiB, or an upload is larger than 20 MB. |
| `422` | The action's plugin refused it; `message` is the plugin's own message. |
| `504` | A section did not load in time. |
| `500` | Anything else; the body carries no stack trace. |
