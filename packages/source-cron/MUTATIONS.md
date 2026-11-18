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
| T-0545-M7 | packages/source-cron/src/index.ts | a new rule ran its earlier planned time on the first poll instead of recording a baseline | `missed runs > a new rule whose planned time passed earlier today waits for its next one` |
| T-0545-M8 | packages/source-cron/src/index.ts | keyed each rule's remembered last time by its array index again | `missed runs > removing an earlier rule does not change what a later rule catches up` |

## T-0548 — scheduled flows from a client

| id | file | mutation | failing test |
|---|---|---|---|
| T-0548-M1 | packages/source-cron/src/index.ts | the source treated a paused rule as active and fired it | `scheduled flows > pause stops ticks and survives a reload, and resume starts them again` |
| T-0548-M2 | packages/source-cron/src/schedules.ts | the next run was the current minute instead of the next matching minute | `scheduled flows > adding one makes it appear in the list with its next run` |
| T-0548-M3 | packages/source-cron/src/schedules.ts | edit kept the old schedule and ignored the new one | `scheduled flows > edit changes the schedule and the next run` |
| T-0548-M4 | packages/source-cron/src/schedules.ts | remove wrote the rules back unchanged | `scheduled flows > remove deletes the rule` |
| T-0548-M5 | packages/source-cron/src/schedules.ts | add accepted a flow that is not loaded | `scheduled flows > an unknown flow is refused with the reason` |
| T-0548-M6 | packages/source-cron/src/schedules.ts | a bad cron expression was replaced by a valid one instead of refused | `scheduled flows > a bad cron expression is refused with the reason` |
| T-0548-M7 | packages/source-cron/src/schedules.ts | the list dropped the last run it found in the log | `scheduled flows > the list shows the last run's result and run id` |
| T-0548-M8 | packages/source-cron/src/schedules.ts | pause did not write `paused` into the rule | `scheduled flows > pause stops ticks and survives a reload, and resume starts them again` |
| T-0548-M9 | packages/source-cron/src/schedules.ts | resume left the rule paused | `scheduled flows > pause stops ticks and survives a reload, and resume starts them again` |
| T-0548-M10 | packages/source-cron/src/index.ts | a tick was keyed by the rule's position again instead of its stable identity | `the cron source > emits once per due minute` |

## T-0551 — scheduled tasks follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0551-M1 | packages/source-cron/src/schedules.ts | edit accepted a change that made the rule identical to another scheduled flow | `scheduled flows > edit that makes a rule identical to another is refused and changes nothing` |
