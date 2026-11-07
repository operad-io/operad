# Mutation records — `source-cron`

Rows whose mutation broke code in `packages/source-cron/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M6 | packages/source-cron/src/index.ts | returned the minute after the last tick instead of the latest due minute | `the cron source > a three-hour gap emits only the latest tick` |
