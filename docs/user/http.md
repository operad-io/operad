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
| `http` | object | `{ "enabled": true, "port": 8765, "listen": ["127.0.0.1"] }` | an object with the keys below; a missing section means these defaults | At every command start; `serve` binds when it starts and after a reload | Refused: `http: must be an object` |
| `http.enabled` | boolean | `true` | `true` or `false` | When `serve` starts; a reload opens or closes the interface with the new value | Refused: `http.enabled: must be a boolean` |
| `http.port` | integer | `8765` | `0` to `65535`; `0` asks the system for a port | When `serve` binds; after a reload it binds the new port | Refused: `http.port: must be an integer from 0 to 65535` |
| `http.listen` | array of strings | `["127.0.0.1"]` | at least one non-empty IP literal: loopback, RFC 1918, link-local or Tailscale; a wildcard and every other address are refused | When `serve` binds; after a reload it binds the new addresses | Refused: `http.listen: must be an array of IP addresses`, `http.listen: needs at least one address`, `http.listen: "<address>" is not an IP address`, `http.listen: "<address>" is a wildcard address; name each address to listen on`, or `http.listen: "<address>" is not a loopback, private, link-local or Tailscale address` |

An unknown key inside `http` is ignored; only the keys above are read. Each
`listen` entry is an IP literal. `serve` accepts a loopback address, an
RFC 1918 address (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), a link-local
address (`169.254.0.0/16`, `fe80::/10`) or a Tailscale address
(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). It refuses a wildcard (`0.0.0.0` or
`::`) and every other address, before it opens a port, naming the entry. The
default listens on the machine only. A config with no `http` section means
`enabled` true, port `8765`, `listen` `["127.0.0.1"]`. An `http` section without
`enabled` turns the interface on, on the addresses in `listen`. A Tailscale
address in `listen` serves a client that accepts plain HTTP; the phone app does
not, so over Tailscale it needs the HTTPS name that `tailscale serve` gives
(see [Tailscale](tailscale.md)).

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
http http://127.0.0.1:8765
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
| `GET /v1/pending` | The same list as `operad pending`, with the actions each item offers. A question carries `waitId`, the id an answer quotes, and may carry `choiceInfo`, keyed by a choice with optional `label`, `hint`, `role` and `note`. A question the agent asked as a form (a chat agent asking one or more questions) also carries `questions`: `[{ "id", "text", "body"?, "header"?, "choices"?: [{ "label", "description"? }], "multiple"?, "freeText"? }]`. Its answers name a question by `id`; `multiple` says more than one label may be picked, and `freeText` says the person may answer in their own words. A question may also carry `body`, Markdown too long for its text. A plan review is a form of one question: its `text` is the plan's title, its `body` is the plan's Markdown, and its `choices` are `Approve` and `Request changes`. A form has no `choices` of its own: when it has exactly one question with choices and does not take more than one label, `choices` carries that question's labels, so a client that cannot draw the form still answers it. A wait that its plugin is about to answer automatically (dev: a passed review of a task in a plan at auto merge) is not listed, so the count does not flicker; it is listed if the automatic answer does not come. An item a plugin raises without a run waiting (`kind` `standing`, no actions, `runId` `<plugin>:<id>`) is in the list too, and goes when the plugin stops reporting it. An item that is about an object also carries `object` (`<type>:<id>`), its `link` and its `row`: the same row `GET /v1/objects?type=…` returns for that object (`id`, `title`, `state`, optional `note`, `mark`, `badge`, `waiting`, `running`), so a client does not read each object. When the row cannot be built (the object is gone, no loaded plugin shows its type, or the plugin's row fails) the item carries the error row the list shows for a bad row, with `state` `error` and an `error` message; the list itself never fails for one object. A candidate has no object and no `row`. `operad pending` prints the row's title under each line that has one. |
| `GET /v1/running` | The same list as `operad running`. Each item has `runId`, `flow`, `step`, `stepLabel`, `queued`, `startedAt` and `elapsedMs` (the run's age), and: `object`, the object's id as rows and `operad show` name it (for example `operad/T-0048-type-filters`), or `null` for a run with no object; `title`, that object's row title, or `null` when there is no object or the lookup failed (a failed lookup never fails the list); `stepStartedAt` and `stepElapsedMs`, when the current step's current attempt started and how long it has run (`null` before the first step); `mark`, the object's row mark (one of the [row marks](#row-marks)), left out when the row has none or cannot be built. The step time starts again when the step changes and on a new attempt. |
| `GET /v1/objects/<id>` | `{ "id", "type", "link", "row", "sections", "actions", "skills"? }`: the link that opens the object, the row, the section directory, and the actions available now with their `args` schema, `note` field, `confirm` flag and `command` description when a chat can run it after `/`. A chat also carries `skills: [{ "name", "description"? }]` beside its actions, so one request gives the commands and the skills: each is a skill the chat can type as `/name`, with the description from its `SKILL.md` cut to the menu length; a skill whose file cannot be read is left out. A skill whose name is also a command is not run as a skill: `/name` runs the command. A chat also carries `context: { "used", "window"?, "model"? }` when its last finished reply reported one: `used` is the last model call's input plus cache read and cache write, `window` is the model's context window when known, and `model` is the model that answered when known. A new session leaves `context` out until its next reply. An object whose newest run has ended also carries `lastRun`: `{ "outcome": "done" | "failed" | "cancelled", "reason"?, "endedAt" }`, read from the run's ending, not from the History text. `reason` is the line the run recorded when it ended or, for a failure that recorded none, the message of the step that failed; it is left out when there is neither; `endedAt` is milliseconds since the epoch. An object with no run, or whose newest run is still going, has no `lastRun`. It is not part of the row. |
| `GET /v1/objects/<id>/sections/<section>?cursor=<c>&full=<bool>&after=<mark>` | `{ "markdown": "...", "next": "<c>", "mark": "<m>", "tail": "..." }`. A section may also carry `data`, an object the plugin defines for its clients, on every read including one with `after`. A chat's `transcript` also carries `context: { "used", "window"?, "model"? }` from its last finished reply, like the object view, on every read including one with `after`; `data.queued` with `data.queuedCount`, the messages sent but not yet taken by a run, in sending order, each with `id`, `text`, `at` and `attachments`; and `data.replies`, the structured form of each reply beside the Markdown (see [A chat's replies](#a-chats-replies)). `data.replies` follows the read's window: a page carries the replies on that page, a read with `after` carries the replies finished since the mark and the one still running, and a `tail` event carries the running reply. `full=true` skips the size cap. `mark` is an opaque position the finished content goes to and `tail` is the Markdown of the part still changing; a plugin that does not use them sends neither. With `after=<mark>` from an earlier read, `markdown` holds only the finished content after that mark; the answer then also carries `delta`: true when it is that part alone, false when the plugin answered with a whole page and a client must replace instead of append. The size cap covers `markdown`, `tail` and the plugin's `data` together but never cuts `tail`: a chat cuts tool output text inside `data.replies` first, keeping its lines and setting `truncated`, and only then is `markdown` shortened; when even the tail, data and the truncation note do not fit, the call is refused with an over-cap message naming `--full`. A mark from another section or object is refused with `400`. |
| `POST /v1/act` | Runs one action. The body is `{ "action": "plugin:action", "id": "<id>", "args": {...}, "note": "...", "confirmed": true }`; only `action` is always required, and an action that targets an object also needs `id`. An action with `confirm: true` needs `"confirmed": true`. The body is at most 1 MiB; a larger one gets `413` with `the request body is larger than the 1 MB limit`. An argument the action's schema declares with `"format": "file"` (a string, or a list of strings) takes the `ref` of an upload; the action runs with the path the file is stored at. |
| `POST /v1/commands` | Runs a plugin verb as `operad <plugin> <verb>` does. The body is `{ "plugin": "cron", "verb": "scheduled", "args": ["list", "--json"], "input": "..." }`; `plugin` and `verb` are required, `args` is an array of strings, and `input` is the text the command reads from stdin. The answer is `{ "plugin", "verb", "value" }`, where `value` is what the command returned. A verb no loaded plugin declares is `404`; a command that refuses gets `422` with its reason. The scheduled flows command lists, adds, edits, pauses, resumes and removes cron rules in `triggers.json`; see [`triggers.json`](config.md#triggersjson). |
| `GET /v1/plugins` | `{ "plugins": [{ "name": "dev", "version": "0.4.0", "enabled": true, "origin": "builtin" }] }`: the configured plugins, in config order, with what `operad plugin list` prints. `version` is `null` for a plugin that is off or did not load, where the command line prints `-`. `origin` is `builtin` for a package operad ships and `home` for any other plugin the home's `config.json` names (a path or another package); plugins of a project are not loaded, so there is no third value. A loaded harness plugin also carries `signedIn`: `true` or `false` when its agent can tell whether the user is signed in, absent when it cannot (and absent for a plugin that is off or not a harness). Only the yes/no is exposed; it never shows a credential, and a client needs no session to read it. A loaded harness plugin also carries `models`: `{ "list", "default", "windows"?, "info"? }`. `list` is the model ids a chat may pick, and `info` maps an id to `{ "id", "name"?, "provider"?, "window"?, "capabilities"? }`; `capabilities` is a subset of `vision`, `reasoning`, `tools` and `web`. A field the harness does not know is absent, never guessed; a client that reads only `list` keeps working. |
| `POST /v1/plugins` | Turns one plugin on or off, or installs one from npm. To switch, the body is `{ "name": "<plugin>", "enabled": true, "confirmed"?: true }`; `name` and `enabled` are required. To install, it is `{ "install": "<package>[@version]", "confirmed": true }`; the answer is `{ "plugin": { ... } }`, the new entry turned off. See [Plugins](#plugins). |
| `GET /v1/settings?scope=<scope>` | Lists the settings a person may tune: `{ "settings": [{ "name", "scope", "value", "default", "title", "description", "type", "enum", "editable", "confirm" }] }`. Without `scope` it lists the global settings and every repository scope; a scope names one repository. A setting that cannot be read in a scope is left out. |
| `POST /v1/settings` | Changes one setting. The body is `{ "name": "<plugin>.<path>", "value": <any>, "scope"?: "<repo>", "confirmed"?: true }`; `name` and `value` are required, and `value` may be `null`. The answer is the changed setting, the same shape as one entry above. An unknown setting name is `404`; a value the schema refuses is `422` with the reason; a setting that is not editable, or asks to confirm without `confirmed`, is `409`. |
| `POST /v1/uploads?name=<file name>` | Uploads a file for an action's file argument. The body is the file itself, streamed; its `content-type` header is kept as the file's type. The answer is `201` and `{ "ref", "name", "type", "size" }`. A file larger than 20 MB gets `413` and a message naming the limit. The `ref` works once: the action that takes it moves the file into the target object's attachment directory under the operad home (`attachments/<type>/<id>/`), and a second use is refused with `400`. An upload no action took within an hour is removed. |
| `GET /v1/attachments/<type>/<id>/<ref>/<name>` | Serves a stored file of an action's file argument, with the type its upload gave. The transcript of a chat links its attachments here, and a reply's tool `output.url` points here. For a chat the route serves only a file one of the chat's facts names, a message attachment or a tool call's whole output; a file beside them that no fact names, a path that leaves the chat's directory, and another chat's file are `404`. |
| `POST /v1/answer` | Answers an open question of a pending item. The body is `{ "runId": "<item runId>", "waitId": "<item waitId>", "choice"?: "<one of the item's choices>", "answers"?: [{ "id", "choices"?: ["<label>"], "text"? , "skipped"?: true }], "note": "...", "confirmed": true }`; `runId`, `waitId` and a `choice` or `answers` are required, and `note` and `confirmed` are optional. `answers` fills in a form: one entry per question, with the labels picked, the person's own text, or `skipped`; a question left out counts as skipped, and a missing answer to a required question is not invented. A `choice` answers a question that offers choices; for a form of one question it is that question's answer too. `note` is the person's note for the whole question or form; a plan review's `Request changes` carries what to change in it. The server checks every answer against the form before it records anything. When every choice is also an action on the item's object (a `dev` wait), it runs that action, so the action's note and confirmation apply; a confirmed action needs `"confirmed": true` just as it does for `/v1/act`. An answer to a question that is already closed gets `409` and is not applied. |
| `GET /v1/events` | An SSE stream of changes. |

An action that targets no object is sent with no `id`. `dev:repo-add` is one: it registers a repository on the serve's machine, given the repository's `path` there, exactly as `operad dev repo add <path>` does; see [adding a repository from a client](dev.md#adding-a-repository-from-a-client).

```json
{ "action": "dev:repo-add", "args": { "path": "/srv/operad" }, "confirmed": true }
```

An action's `args` may carry JSON Schema conditionals that narrow a field by another: `allOf` holds `{ "if": { "properties": { "agent": { "const": "claude" } }, "required": ["agent"] }, "then": { "properties": { "model": { "enum": [...], "default": "..." }, "effort": { ... } } } }`, one per agent. The new-chat actions (`bot:chat`, `dev:chat`) use it: the top-level `model` and `effort` enums list every loaded agent's choices (a client that reads nothing else still works), and the `then` of the chosen agent holds the list and default that agent takes (the bot's configured model or effort when that agent lists it, else the agent's default). An agent that lists no model or effort has no `model` or `effort` in its `then`: nothing can be picked for it. A client shows the chosen agent's enum and default, and falls back to the top-level one until an agent is chosen. The server does not evaluate the conditionals when it checks a request; it refuses a model or effort the agent does not list by name.

A `model` argument also carries `info`, keyed by model id, beside its `enum`: the same `name`, `provider`, `window` and `capabilities` the plugin list gives, for the models of the agents whose list the argument offers. `chat:model` carries it for the chat's agent. A client that reads only the ids ignores it.

An action that changes an existing value carries `current` on the field: the value in effect now. `chat:model` gives the chat's model, else the model of its last reply, else the agent's configured model; `chat:effort` gives the effort the chat chose, else the agent's declared default now, else the one it started with. An effort equal to the one it started with is inherited, not a choice. `current` is not a default: a field that has no value now has no `current`.

`POST /v1/act` records the caller as `{ "via": "<client>", "id": "<token
label>" }`; `via` is `http` unless the client named itself, and the token label is
`operad app` unless the secret store names another. It records the action the
same way the command line does, and a running `operad serve` carries on the
steps a waiting run asks for. `POST /v1/answer` records its caller the same way
and answers with the same rules as the command line and a plugin action.

### Creating a plan and a task

A plan is created on a repository with `dev:plan`; it asks for confirmation.
A `flow` is one the repository lists in `dev.flowList`, and a missing `slug` is
taken from the title:

```http
POST /v1/act
{"action":"dev:plan","id":"repo:operad","confirmed":true,"args":{"title":"Tighten the checks","slug":"checks","request":"Make the checks finish sooner.","flow":"quick"}}
```

The answer carries `opens` as `plan:operad/P-0042-checks`. A task is created on
that plan with `dev:task`; `after` names any tasks of the plan it waits for:

```http
POST /v1/act
{"action":"dev:task","id":"plan:operad/P-0042-checks","args":{"title":"Cache the check","brief":"Cache the check result.","flow":"quick","after":["T-0041-warm-cache"]}}
```

The answer carries `opens` as `task:operad/T-0042-cache-the-check`. Both actions
run the same code as `operad dev plan add` and `operad dev task add`, so a
refusal is the command's line, word for word.

## Reading a section

`GET /v1/objects/<id>/sections/<section>` reads one section. `cursor` takes the
`next` of an earlier read; `full=true` (or `1`) skips the size cap. A section
that has `pages` also answers with the table of contents, so a client can jump:
the first page has no cursor, every other page carries its own.

A live section also carries `mark` and `tail`. `mark` is an opaque position of
the finished content; `tail` is the Markdown of the part still changing (a chat's
unfinished reply and thinking, a running tool call, or a model request the
agent is waiting to retry), the whole tail on each read. A live section may also
carry `retry`, a model request the agent waits to try again:
`{ "attempt": 2, "maxAttempts": 3, "until": 1767225604000, "reason": "the provider is overloaded" }`.
`until` is when the next attempt starts, in milliseconds since the epoch, so a
client counts down from it; `reason` is the provider's masked message. A client
that does not know `retry` ignores it. `serve` also pushes that `tail` on the
event stream as a `tail` event, so a client can render a running reply without
reading the section again (see [Events](#events)). To append instead of replacing, pass `after=<mark>` from the
last read:
the answer's `markdown` then holds only the finished content after that mark,
and `delta` is `true` when that is all it holds. A plugin that cannot answer
with a delta answers a whole page and `delta` is `false`; the client replaces
its content then. A mark from another section or object is a `400`.

The size cap covers `markdown`, `tail` and the plugin's `data` together, but
never cuts `tail`. A chat cuts the tool output text inside `data.replies` first,
keeping its line count and setting `truncated`; only then is `markdown`
shortened. When even the tail, data and the truncation note do not fit, the call
is a `400` naming `--full`. A read with `full=true` leaves the data whole.

### A chat's replies

A chat's `transcript` carries `data.replies` beside its Markdown. Its window is
the read's window: a page read carries the replies on that page; a read with
`after` carries the replies whose answer is after the mark and the one still
running; a pushed `tail` event carries the running reply. A client merges by
`runId`: a page read replaces the replies it draws with that page's, while an
`after` read or a `tail` event replaces the block of an existing `runId` and
adds a new one. A client that reads only Markdown keeps working. Each entry is
one reply: its input, its process and, when it has finished, its answer:

```json
{
  "runId": "run-1",
  "input": [{ "id": "m-1", "text": "hello", "at": 1700000000000 }],
  "process": [
    {
      "categories": ["read", "run"],
      "items": [
        { "kind": "thinking", "text": "look first", "at": 1700000000001 },
        { "kind": "text", "text": "I will look.", "at": 1700000000002 },
        {
          "kind": "tool",
          "callId": "t1",
          "name": "Bash",
          "input": "ls",
          "at": 1700000000003,
          "durationMs": 1500,
          "failed": false,
          "result": "done",
          "output": { "text": "a.txt\n", "lines": 1 }
        }
      ]
    }
  ],
  "answer": { "id": "m-2", "text": "final answer", "at": 1700000000004 },
  "durationMs": 1234
}
```

`input` and `answer` are message blocks `{ id, text, at }`. A reply still being
written has no `answer`; a finished reply has its `durationMs` when its agent
reported timings. `process` holds the thinking, intermediate text and tool calls
between the input and the answer, in time order. A message the reply took while
it was writing ends one process group and starts the next. Each group carries
`categories`, the ids `read`, `edit`, `run`, `search` and `other` for what its
tools did, in first-use order; the client words them.

A thinking or text item is `{ kind, text, at? }`. A tool item is
`{ kind: "tool", callId, name, input, at?, durationMs?, failed, result?, output }`.
`at` is when a tool call started. `durationMs` and `result` are absent while the
call is still running. `failed` is true only for the result `failed`; the other
results are `done`, `blocked` and `denied`. `output` is
`{ text, lines, url?, truncated? }`: `text` is the recorded output (the first
4 KB at most), `lines` counts its lines, `url` is the `/v1/attachments/...`
address that serves the whole output through this interface when it was longer
than 4 KB, and `truncated` says that file holds more than `text` does. The reply
never carries the file's local path on the serve machine. When the size cap cuts
the output, `text` is empty, `lines` keeps its count and `truncated` is `true`; a
full read leaves the text whole. A client shows the first lines, folds the rest
and fetches `url` for all of it; the changed-file card and diff are not part of
this shape.

## Settings

`GET /v1/settings?scope=<scope>` reads the settings the same way `operad
settings` does. Without `scope` it returns the global settings and every
repository scope; with it, one repository's settings. Each entry has `name`, `title`,
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
"stages"?, "steps"?, "refused"? }]`. A `dev.json` flow and the built-in
`default` carry their `stages`; the built-in default's stages carry the
repository's `worker`, `reviewer` and `gate` settings. A TypeScript flow carries
the `steps` (`id`, `kind`, `use`) `dev` reads when it loads the file, or
`refused` with `dev`'s reason when the file breaks a rule. A TypeScript flow is
still saved as a file. When `dev.json` cannot be read at all, the list keeps a
`dev.json` entry whose `refused` is the reason, beside the TypeScript flows and
the built-in one.

## Plugins

`GET /v1/plugins` lists the plugins the home's `config.json` names, as `operad plugin list` does; it reads the file at each call, so a change made by the command line or by hand shows at once.

A loaded harness plugin also answers `signedIn`, so the Agents page can show an installed agent that is not signed in without starting a session. `claude` reads `claude auth status` (kept for a short time), `pi` and `radian` read their own credentials file for a credential and never the secret, and `codex` reads `codex login status`. The answer is `true`, `false`, or absent when the harness cannot tell; a missing command, a file that cannot be read, or a plugin that is off gives absent. No endpoint shows a credential.

The same list carries each loaded harness's `models`, with a description of each model beside its id: `name`, `provider`, the context `window` when known and the `capabilities` it truly knows. A client groups the models by `provider`, searches them and draws badges for `vision`, `reasoning`, `tools` and `web`. The client may label the search `Search models` and the badges `Vision`, `Reasoning`, `Tools` and `Web`; the server sends the data, not that text.

`POST /v1/plugins` does what `operad plugin enable <name>` and `operad plugin disable <name>` do, on the same file: it sets `plugins.<name>.enabled` and keeps every other key. Enabling a shipped plugin the file does not list adds it, and enabling `claude` installs its package into the home first, as the command does. The refusals are the command line's, with its words:

| Status | When |
|---|---|
| `404` | `plugins.<name>: no such plugin`: the name is not in the file and is not a shipped optional plugin. |
| `409` | `cannot disable "<name>": run "<run>" (<step>) is active`: a run uses one of the plugin's steps, as exit `3` is on the command line. |
| `409` | A disable without `"confirmed": true`. The command line has no such step; here a tap on a phone could switch off a plugin's commands, actions and automatic work for every client, so the client says it meant it. Turning a plugin on never asks. The run check comes first, so a plugin that is in use gets the run reason, not the confirmation. |
| `400` | The body lacks a `name`, `enabled` is not true or false, or `confirmed` is not a boolean. |

`POST /v1/plugins` with `{ "install": "<package>[@version]", "confirmed": true }` does what `operad plugin add` does: it installs the package into the home's plugin directory with its install scripts off, runs the check, and adds it to `config.json` turned off. `<package>` is a valid npm name with an exact `@version`, or no version for the latest. The answer is `{ "plugin": { ... } }`, the new entry with `"enabled": false`. Installing needs `"confirmed": true`, because it changes what the home can load and installs code from outside it. The refusals are the command line's, with its words:

| Status | When |
|---|---|
| `409` | An install without `"confirmed": true`. |
| `400` | `install` is not a non-empty package name, or the package name or version is not valid npm syntax. |
| `422` | The package cannot be installed, its default export is not a plugin declaration, its declared name is already configured, or its entry needs an install script that was not run. |

A change takes effect at the next load, as on the command line: the next `operad` command, or the next `serve` load. The answer shows the new `enabled` at once, but the running `serve` still has the plugin as it loaded it. `serve` watches `config.json`, and after the file has been quiet for a moment it reloads by itself and says so on its own output (`reloading: ...`). There is no field or event that says a reload is due; a client sees the reload as its event stream ending and reconnecting, and then refetches its lists (see [Events](#events)).

Like `POST /v1/act`, a switch is recorded with the caller as `{ "via": "<client>", "id": "<token label>" }`: as an event in the run log, and as a line in `serve`'s log: `http: plugin "dev" disabled via tui as operad app`. A refusal is logged with its status. The bearer token is required, as on every endpoint.

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

## Row data

A row may also carry `data`, an object the plugin defines for its clients. The
kernel passes it through unchanged in list, get and pending rows. A client that
does not know a plugin's shape ignores it.

A bot row's `data.scheduled` is an array of its scheduled prompts, so an edit
form needs no parsing of the bot section's Markdown. Each entry is:

```json
{
  "name": "Morning",
  "schedule": "0 8 * * *",
  "prompt": "Collect the day's news.",
  "model": "claude-sonnet",
  "effort": "high",
  "paused": false,
  "nextRun": "2026-01-02T08:00:00.000Z",
  "lastResult": "Collected 12 items.",
  "lastChatId": "C-0042"
}
```

`model` and `effort` are `null` when the entry leaves them to the bot. `nextRun`
is an ISO time, or `null` when the entry is paused or has no next run within two
years. `lastResult` and `lastChatId` are `null` before the entry first fires.

A chat a scheduled prompt opened carries `data.scheduled`, which names its bot
and the entry that opened it, so a client reads that instead of guessing from
the title:

```json
{ "scheduled": { "bot": "default", "entry": "Morning" } }
```

Every other chat has no `data.scheduled`.

A chat with messages that no run has taken carries `data.queued`, in sending
order, and `data.queuedCount`; it has neither when nothing is queued. Each entry
is:

```json
{
  "id": "m-6c1f",
  "text": "and then run the tests",
  "at": 1763540000000,
  "attachments": []
}
```

The `transcript` section carries the same `data.queued` and `data.queuedCount`
on every read. A message is queued until a run starts with it or an agent takes
it mid-run; `chat:withdraw` and `chat:edit` change only a queued message, and
refuse one a run has taken.

## Links

An object link is `operad://objects/<id>`, where `<id>` is the object as `get`
takes it, `<type>:<id>`, URL-encoded: `item:a b/c` is
`operad://objects/item%3Aa%20b%2Fc`. `GET /v1/objects/<id>` and each pending
item carry it as `link`, and a notification command gets it as `OPERAD_LINK`.
Opening it in the app shows that object. Following the link's path
(`/v1/objects/<the part after objects/>`) finds the same object.

## Events

`GET /v1/events` streams server-sent events. Each change event is an object that
changed:

```text
id: 3f9c2a1b7d4e5f60-7
data: {"id":"T-0019-http-api"}

```

A live section whose plugin pushes its changing part also sends `tail` events on
the same stream, with the same `tail`, `status`, `retry` and `data` a section
read returns; a chat's event carries its running reply in `data.replies`:

```text
event: tail
data: {"id":"C-0042","type":"chat","section":"transcript","tail":"**Operad Bot:** I am writing","status":{"text":"Thinking","since":1767225600000},"data":{"replies":[{"runId":"run-1","input":[],"process":[]}]}}

```

A retry that the agent is waiting for is in the same events:

```text
event: tail
data: {"id":"C-0042","type":"chat","section":"transcript","tail":"Retrying the model request (2 of 3): the provider is overloaded","retry":{"attempt":2,"maxAttempts":3,"until":1767225604000,"reason":"the provider is overloaded"}}

```

A `tail` event has no `id:` and is not replayed on a reconnect: the client reads
the open live section again, including its current `tail`, `retry` and `data`. A
client that does not know `tail` ignores it and keeps reading the section after
each change event, as before. A client merges the running reply into its replies
by `runId`.

An `id:` is an opaque string. It changes on every change event and starts with a
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
| `422` | The action's plugin refused it, or a setting's value the schema refuses; `message` is the plugin's own reason or the schema's. |
| `504` | A section did not load in time. |
| `500` | Anything else; the body carries no stack trace. |
