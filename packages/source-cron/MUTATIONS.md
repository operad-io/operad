# Mutation records — `source-cron`

Rows whose mutation broke code in `packages/source-cron/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M6 | packages/source-cron/src/index.ts | returned the minute after the last tick instead of the latest due minute | `the cron source > a three-hour gap emits only the latest tick` |
| T-0545-M1 | packages/source-cron/src/index.ts | a catch-up emitted every missed tick instead of only the latest | `missed runs > serve down over three planned times runs only the latest, once, and history names the skipped ones` |
| T-0545-M2 | packages/source-cron/src/index.ts | a catch-up looked back 730 days instead of 7 | `missed runs > a miss older than 7 days runs nothing` |
| T-0545-M3 | packages/source-cron/src/index.ts | treated a wake as an ordinary check, so its tick carried no planned time or lateness | `missed runs > a wake catches up the same way` |
| T-0545-M4 | packages/source-cron/src/index.ts | reused the old schedule's last time after the schedule changed | `missed runs > a changed schedule does not catch up` |
| T-0545-M5 | packages/source-cron/src/index.ts | put lateness on every tick, including an on-time one | `missed runs > a normal on-time tick carries no lateness` |
| T-0545-M6 | packages/source-cron/src/index.ts | emptied the catch-up's skipped list, so its summary named no skipped time | `missed runs > serve down over three planned times runs only the latest, once, and history names the skipped ones` |
