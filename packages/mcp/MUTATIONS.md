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
| T-0027-M1 | packages/mcp/src/policy.ts | `actionMayRun` returned true for every action, ignoring `mcp.actions` | `splits show actions into the lead's and the owner's` |
| T-0027-M2 | packages/mcp/src/policy.ts | `actionMayRun` ignored `mcp.confirmActions`, so a confirm action ran once listed | `splits show actions into the lead's and the owner's` |
| T-0027-M3 | packages/mcp/src/policy.ts | `splitActions` kept every available action and named no owner action | `splits show actions into the lead's and the owner's` |
| T-0027-M4 | packages/mcp/src/tools.ts | `command` replaced its `input` with an empty string instead of passing it to the verb | `command runs plugin verbs with input and refuses a kernel verb` |
| T-0027-M7 | packages/mcp/src/tools.ts | `act` recorded the actor as cli/lead instead of mcp/lead | `act runs a lead rework with the mcp lead actor and refuses merge by default` |
| T-0027-M8 | packages/mcp/src/tools.ts | `command` still refused a verb whose name is a kernel verb after the named plugin declared it | `command runs a plugin verb whose name is also a kernel verb` |
| T-0027-M9 | packages/mcp/src/policy.ts | `splitPendingActions` kept every pending action and filtered none | `pending lists only the actions the lead may run` |
| T-0027-M10 | packages/mcp/src/tools.ts | `command` checked only the verb for a kernel name and let a plugin namespace that is a kernel verb run | `command refuses a plugin whose name is also a kernel verb` |
