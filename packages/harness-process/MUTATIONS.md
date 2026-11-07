# Mutation records — `harness-process`

Rows whose mutation broke code in `packages/harness-process/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0009-M9 | packages/harness-process/src/process.ts | the harness drain used `globalThis.setTimeout` instead of the injected clock | `the harness process > a child that leaves the group cannot hold the run open` (timed out) |
| TK0009-M10 | packages/harness-process/src/process.ts | a finished harness run took the grace stop instead of a direct SIGKILL | `the harness process > a child that leaves the group cannot hold the run open` (sleeps 1) |
Rows whose mutation broke code in `packages/harness-process/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0021-M9 | packages/harness-process/src/limit.ts | `modelLimit` keyed a model that is not in `concurrency` instead of leaving it unlimited | `harness-pi/agent step limit > a model not in the map, or no model, has no limit` (in `packages/harness-pi`) |
| T-0021-M12 | packages/harness-process/src/limit.ts | `flagValue` kept the first value of a repeated flag | `flagValue > takes the last occurrence of a repeated flag` |
| T-0021-M13 | packages/harness-process/src/limit.ts | `CONCURRENCY_SETTING` dropped `minimum: 1` from its counts | `the concurrency setting > zero, a string, a fraction or a non-object refuse the plugin at load, naming the field` |
