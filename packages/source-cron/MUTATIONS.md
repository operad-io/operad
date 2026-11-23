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
| T-0551-M2 | packages/source-cron/src/schedules.ts | the next run could be a minute at or before now, because the day scan no longer skipped earlier times | `scheduled flows > the next run is never the current minute or earlier` |
| T-0551-M3 | packages/source-cron/src/index.ts | a paused rule's recorded minute no longer followed the clock | `scheduled flows > a paused rule's recorded minute follows the clock, so reopening it does not catch up the pause` |
| T-0551-M4 | packages/source-cron/src/schedules.ts | pause and resume wrote no baseline for the rule | `scheduled flows > resuming records a baseline, so a source started later does not catch up the pause` |
| T-0551-M5 | packages/source-cron/src/schedules.ts | the list ignored `--json` and always gave text | `scheduled flows > adding one makes it appear in the list with its next run` |

## T-0553 — scheduled gaps from the desktop and iOS reviews

| id | file | mutation | failing test |
|---|---|---|---|
| T-0553-M1 | packages/source-cron/src/schedules.ts | an empty `--params` was parsed as JSON instead of adding none or clearing the flow's parameters | `scheduled flows > an empty --params adds none and clears the ones an edit finds` |

## T-0618 — a cron poll scans only when it can find something

| id | file | mutation | failing test |
|---|---|---|---|
| T-0618-M1 | packages/source-cron/src/index.ts | a poll no longer skipped a minute it had already handled, so every check scanned again | `scan cost > a poll inside an already handled minute does no scan` (a scan count of 2 instead of 1) |
| T-0618-M2 | packages/source-cron/src/index.ts | `dueMinute` used the two-year default again instead of stopping at the recorded last time | `scan cost > the backward scan stops at the recorded last time` (the lookback was undefined instead of one minute) |
| T-0618-M3 | packages/source-cron/src/index.ts | a catch-up scanned the whole seven-day window instead of stopping at the recorded last time | `scan cost > a missed minute is still caught up after a gap, scanning back only to the last time` (a lookback of 7 days instead of three hours) |
| T-0618-M4 | packages/source-cron/src/index.ts | a paused rule scanned seven days instead of stopping at its recorded last time | `scan cost > a paused rule scans no further back than its recorded last time` (7 days instead of five minutes) |
| T-0618-M5 | packages/source-cron/src/index.ts | a catch-up with nothing planned after the last time reset the recorded time to the poll's minute | `missed runs > a miss older than 7 days runs nothing` (the recorded last time moved from 2025-01-01 to the poll's minute) |

## T-0644 — a failed emit waits for its retry

| id | file | mutation | failing test |
|---|---|---|---|
| T-0644-M1 | packages/source-cron/src/index.ts | a poll recorded its minute before the emit, so a failed emit was skipped for the rest of that minute | `the cron source > an emit that fails is tried again within the same minute` |
| T-0644-M2 | packages/source-cron/src/index.ts | a catch-up with nothing planned kept the old recorded time instead of resetting it to the poll's minute | `missed runs > a miss older than 7 days runs nothing` |
| T-0782-M1 | packages/source-cron/src/index.ts | the plugin declared only `routines`, so the old name `scheduled` was unknown | `operad routines > the old name scheduled is the same command` |
| T-0782-M2 | packages/source-cron/src/schedules.ts | an empty list printed `no scheduled flows` instead of `no routines` | `operad routines > the old name scheduled is the same command` |
| T-0782-M3 | packages/source-cron/src/schedules.ts | the command's default name stayed `scheduled`, so `operad routines` was unknown | `operad routines > adds a flow, lists it, and refuses an unknown flow` |
