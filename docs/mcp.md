# operad MCP server

`operad mcp` is a read-only Model Context Protocol server on stdio. It gives a
lead agent typed access to the same objects, lists, sections, pending items,
running items and history that `operad` and the `/v1` interface read. It never
starts a step or runs an action; only `operad serve` runs steps, and owner
decisions stay in the command line or the app.

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
| `tools/call` | Runs one read tool. |

The `initialize` result carries this fixed instruction:

```text
The operad MCP server exposes read-only views of objects, pending items and history. Owner decisions are not offered here.
```

`tools/call` takes `{ "name": "<tool>", "arguments": { ... } }`. The arguments
are checked against the tool's input schema before any view is read. A missing
required field, an unknown field, or a field of the wrong type is a malformed
request.

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

Result: the object `{ "id", "type", "link", "row", "sections", "actions" }`.
`row` is the list row. `sections` is the section directory. `actions` are the
actions available now, each with its `name`, `on`, `args` JSON Schema, `note`
field name, `noteRequired` and `confirm`. The Markdown shows the row, the
section directory and the actions with their arguments. An unknown id is a
tool error with the view's message.

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

Result: the same list as `operad pending` and `GET /v1/pending`, including the
actions each item offers. The Markdown lists each pending item, its prompt,
choices and actions.

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
