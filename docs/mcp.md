# operad MCP server

`operad mcp` is a Model Context Protocol server on stdio. It gives a lead agent
typed access to the same objects, lists, sections, pending items, running items
and history that `operad` and the `/v1` interface read. It also runs plugin
verbs and the lead actions `config.json` allows, through the same paths as the
CLI. It never starts a step or takes an owner decision; only `operad serve` runs
steps, and the actions left out of `mcp.actions` stay in the command line or the
app.

The server implements the MCP JSON-RPC 2.0 transport, protocol version
`2025-06-18`. It has no runtime dependency except `@operad-io/engine`.

## Transport

Messages are one JSON-RPC object per line, incoming on stdin and outgoing on
stdout. A message must not contain an embedded newline. stdout carries only
JSON-RPC messages; plugin loading, view errors and other logs go to stderr.

The server accepts these methods:

| Method | What it does |
|---|---|
| `initialize` | Returns the protocol version, the `tools` capability, the server name and version, and the instructions. |
| `notifications/initialized` | Accepted; it has no response. |
| `ping` | Returns `{}`. |
| `tools/list` | Returns the tool table below. |
| `tools/call` | Runs one tool. |

The `initialize` result carries this fixed instruction:

```text
The operad MCP server reads objects, pending items and history, and writes the commands and lead actions it is allowed to. Owner decisions are not offered here.
```

`tools/call` takes `{ "name": "<tool>", "arguments": { ... } }`. The arguments
are checked against the tool's input schema before any view is read. A missing
required field, an unknown field, or a field of the wrong type is a malformed
request.

## Claude Code channel

`operad mcp --claude-channel` also pushes object changes to a client that
understands Claude Code's channel extension. Without the flag the server has
the same tools, capabilities and instructions as before, and sends no
notification.

With the flag the `initialize` result carries
`capabilities.experimental["claude/channel"] = {}`. It never declares
`claude/channel/permission`: the server relays no permission prompts. The
instructions gain a paragraph saying the channel is one-way and the read tools
give the details.

There are two sources. One is the store's object changes. The other is the
changes to flows, because an object's `waiting` and `running` flags come from
its flow: a wait that opens or a step that starts writes no object. Both use a
directory watch with a polling fallback, so a change another process makes is
seen too (the poll interval is the store's and the flow records' own, 500 ms by
default). Each change re-reads that object's row. At start the server reads the
current rows of every type that has views and sends nothing for them; if it
cannot read a type's rows, the first row it sees for each object of that type is
its baseline and also sends nothing. It remembers the last row it saw for each
object and sends one notification only when that row's `state`, `waiting` or
`running` changed. An object first seen after the starting read has the previous
state `new`. An object that can no longer be found is forgotten.

The server sends nothing until the client has sent `notifications/initialized`.
It keeps comparing rows meanwhile, then sends the changes it saw since the
start, in order.

Each notification is the server's `notifications/claude/channel` method with
these parameters:

```json
{
  "content": "T-0014-kernel running -> waiting: review passed",
  "meta": {
    "id": "T-0014-kernel",
    "type": "task",
    "state": "waiting",
    "previous": "running",
    "waiting": "true",
    "running": "false"
  }
}
```

`content` is one line, `<id> <old state> -> <new state>`, with `: <note>`
appended when the row has a note. Every `meta` value is a string. The channel is
one-way: there is no reply tool, and `show`, `section`, `pending`, `history` and
the other read tools give the details.

`--types <t,…>` limits the channel to the named object types, separated by
commas; the default is every type with views. A name that is not a type with
views is a usage error that names it. The flag does not change the read tools.

Claude Code enables the extension with its development-channel flag, naming the
server from `.mcp.json`:

```sh
claude --dangerously-load-development-channels server:operad
```

## Tools

The tool table is exported as `TOOLS` from `@operad-io/mcp`; the server serves
that same table. Every result is a normal MCP tool result with
`structuredContent` and one text block whose text is the same content as
Markdown. `next`, when present, is a cursor the caller passes back unchanged.

### `list`

Input:

```json
{
  "type": "object",
  "required": ["type"],
  "additionalProperties": false,
  "properties": {
    "type": { "type": "string", "minLength": 1, "description": "An object type, such as task." },
    "cursor": { "type": "string", "description": "The next cursor from an earlier list." }
  }
}
```

Result: `{ "rows": [ ... ], "next": "<cursor>" }`. `rows` are the rows of one
object type, with the plugin's `id`, `title`, `state` and optional `note` and
`scope`, plus the kernel's `waiting` and `running` flags. An error row also has
`error`. The Markdown is a table of id, state, title, note and flags. An
unknown type is a tool error with the view's message.

### `show`

Input:

```json
{
  "type": "object",
  "required": ["id"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1, "description": "A bare id or type:id." }
  }
}
```

Result: the object
`{ "id", "type", "link", "row", "sections", "actions", "ownerActions" }`.
`row` is the list row. `sections` is the section directory. `actions` are the
available actions the lead may run now, each with its `name`, `on`, `args` JSON
Schema, `note` field name, `noteRequired` and `confirm`. `ownerActions` holds
only the names of the available actions the lead may not run, including a
`confirm: true` action that `mcp.confirmActions` does not name. The Markdown
shows the row, the section directory, the allowed actions with their arguments,
and an Owner actions list. An unknown id is a tool error with the view's
message.

### `section`

Input:

```json
{
  "type": "object",
  "required": ["id", "section"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1, "description": "A bare id or type:id." },
    "section": { "type": "string", "minLength": 1, "description": "A section id from show." },
    "cursor": { "type": "string", "description": "The next cursor from an earlier read." },
    "full": { "type": "boolean", "description": "Return the whole section without the size cap." }
  }
}
```

Result: `{ "markdown": "...", "next": "<cursor>" }`. The text block is the
Markdown, with a final line naming `next` when the section is paged. An unknown
id or section is a tool error with the view's message.

### `pending`

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

Result: the same list as `operad pending` and `GET /v1/pending`, with only the
actions the lead may run now. An action outside `mcp.actions`, or a
`confirm: true` action that `mcp.confirmActions` does not name, is left out of
both the structured content and the Markdown. The Markdown lists each pending
item, its prompt, choices and actions. Call `show` on the item's object to see
the owner actions.

### `running`

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

Result: the same list as `operad running` and `GET /v1/running`. The Markdown
is a table of each active run, its flow, step and elapsed time.

### `history`

Input:

```json
{
  "type": "object",
  "required": ["id"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1, "description": "A bare id or type:id." }
  }
}
```

Result: `{ "id": "<the id as given>", "markdown": "...", "next": "<cursor>" }`.
The Markdown is the kernel's History section for the object. An unknown id is a
tool error with the view's message.


### `command`

Input:

```json
{
  "type": "object",
  "required": ["plugin", "verb"],
  "additionalProperties": false,
  "properties": {
    "plugin": { "type": "string", "minLength": 1, "description": "A loaded plugin name, such as dev." },
    "verb": { "type": "string", "minLength": 1, "description": "A verb the plugin declares, such as plan." },
    "args": { "type": "array", "items": { "type": "string" }, "description": "The command-line arguments after the verb." },
    "input": { "type": "string", "description": "The text the CLI reads from stdin, such as a brief." }
  }
}
```

Result: the plugin verb's output, the same value `operad <plugin> <verb>` prints.
The call builds the CLI's `[plugin, verb, ...args]`, with `input` standing in
for stdin, so `dev plan add` and `dev task add` take their brief from it. It
resolves the pair against the loaded plugins, so a plugin verb runs even when
its name matches a kernel command. A plugin whose name is itself a kernel verb
is refused, even when the pair resolves to one of its commands. A kernel verb
the named plugin does not declare (`serve`, `init`, `plugin ...`, `secret ...`,
`http ...`, and the other commands the CLI owns), and any other verb it does not
declare, is refused with a tool error.

### `act`

Input:

```json
{
  "type": "object",
  "required": ["action"],
  "additionalProperties": false,
  "properties": {
    "action": { "type": "string", "minLength": 1, "description": "A <plugin>:<action> name from show." },
    "id": { "type": "string", "description": "The object id when the action targets one." },
    "args": { "type": "object", "description": "The action's arguments, as its schema names them." },
    "note": { "type": "string", "description": "The note for an action whose schema declares one." }
  }
}
```

Result: the same action record `POST /v1/act` returns, with `plugin`, `action`,
`name` and `value`. It runs through `views.act`, records the actor
`{ "via": "mcp", "id": "lead" }`, and records a person's answer for a run that
waits. An action not named in `mcp.actions` is a tool error naming it and saying
the owner runs it. An action with `confirm: true` is refused the same way unless
`mcp.confirmActions` also names it.

## Errors

A JSON-RPC error is used for a malformed request, not for a view refusal:

| Code | When |
|---|---|
| `-32700` | The line is not JSON. |
| `-32600` | The message is not a JSON-RPC 2.0 request. |
| `-32601` | The method is not one of the methods above. |
| `-32602` | `tools/call` is malformed: an unknown tool, no `name`, non-object `arguments`, or arguments that do not match the tool's input schema. |
| `-32603` | An unexpected error happened while reading a view; the message is generic. |

A view refusal is a successful `tools/call` response whose result has
`"isError": true` and one text block with the view's own message. This covers
an unknown id, section or type. A tool error carries no `structuredContent`.
The server writes no stack trace and no internal name.

Example:

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"no object \"task:nope\""}],"isError":true}}
```
