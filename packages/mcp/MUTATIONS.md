# Mutation records — `mcp`

Rows whose mutation broke code in `packages/mcp/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0026-M22 | packages/mcp/src/server.ts | `tools/list` served the table without its last tool | `initializes, lists the table and reads every tool on fixture objects` |
| T-0026-M23 | packages/mcp/src/server.ts | a view refusal dropped `isError: true` | `initializes, lists the table and reads every tool on fixture objects` |
| T-0026-M24 | packages/mcp/src/arguments.ts | skipped the required-field check before reading a view | `initializes, lists the table and reads every tool on fixture objects` |
| T-0026-M25 | packages/mcp/src/server.ts | sent the server's log lines to stdout instead of stderr | `writes only JSON-RPC to stdout when a view logs a failure` |
| T-0026-M26 | packages/mcp/src/format.ts | made the section text block differ from its Markdown | `initializes, lists the table and reads every tool on fixture objects` |
