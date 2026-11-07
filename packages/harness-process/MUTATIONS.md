# Mutation records — `harness-process`

Rows whose mutation broke code in `packages/harness-process/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0009-M9 | packages/harness-process/src/process.ts | the harness drain used `globalThis.setTimeout` instead of the injected clock | `the harness process > a child that leaves the group cannot hold the run open` (timed out) |
| TK0009-M10 | packages/harness-process/src/process.ts | a finished harness run took the grace stop instead of a direct SIGKILL | `the harness process > a child that leaves the group cannot hold the run open` (sleeps 1) |
