# Mutation records — `harness-process`

Rows whose mutation broke code in `packages/harness-process/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0021-M9 | packages/harness-process/src/limit.ts | `modelLimit` keyed a model that is not in `concurrency` instead of leaving it unlimited | `harness-pi/agent step limit > a model not in the map, or no model, has no limit` (in `packages/harness-pi`) |
