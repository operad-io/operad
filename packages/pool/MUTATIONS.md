# Mutation records — `pool`

Rows whose mutation broke code in `packages/pool/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0042-M1 | packages/pool/src/index.ts | picked the last worker with room instead of the first | `picking > takes the first worker in order that has room, and says which ran` |
| T-0042-M2 | packages/pool/src/index.ts | ignored the home harness cap | `the home cap > two workers of one harness share its cap, and the wait says the home is full` |
| T-0042-M3 | packages/pool/src/index.ts | gave the places back only when runStep returned, not in a `finally` | `picking > takes the first worker in order that has room, and says which ran` (the place stayed held) |
| T-0042-M4 | packages/pool/src/index.ts | fell back on any failed result, timeouts included | `fallback > a timeout never falls back` |
| T-0042-M5 | packages/pool/src/index.ts | dropped `fallbackFrom` from the result | `fallback > a unavailable model error runs the fallback worker and records it` |
| T-0042-M6 | packages/pool/src/workers.ts | allowed a fallback chain (skipped the target-has-a-fallback check) | `parseWorkers > refuses: fallback chain` |
| T-0042-M7 | packages/pool/src/places.ts | a place released between the check and the wait was lost (dropped the version check in `changed`) | `waiting > a place freed while the waiting event is being sent is not missed` |
| T-0042-M8 | packages/pool/src/places.ts | a waiting step did not wake on abort (no abort listener) | `waiting > an abort while waiting ends the step as interrupted and holds nothing` |
| T-0042-M9 | packages/pool/src/index.ts | dropped the prefix from the flow count key | `picking > counts are per key prefix: another repository has its own` |
| T-0042-M10 | packages/pool/src/index.ts | ignored the required `worker` | `picking > with worker set only that worker may run, even when another has room` |
| T-0042-M11 | packages/pool/src/workers.ts | accepted an unknown worker name in a pool | `parseWorkers > refuses: unknown worker in a pool` |
| T-0042-M12 | packages/pool/src/index.ts | an aborted wait threw instead of ending `interrupted` | `waiting > an abort while waiting ends the step as interrupted and holds nothing` |
| T-0042-M13 | packages/pool/src/shared.ts | did not drop the places of a process that is gone | `FilePlaces > a place held by a process that is gone is dropped` |
| T-0042-M14 | packages/pool/src/shared.ts | treated this process's own places as dead | `FilePlaces > two instances with separate memory share the home cap` |
| T-0042-M15 | packages/pool/src/index.ts | did not fall back when the harness reported `missing` or `spawn` | `fallback > a harness that could not start (missing) runs the fallback worker` |
| T-0042-M16 | packages/pool/src/shared.ts | ignored the lease, so a place of a killed step thread in a live process stayed held | `FilePlaces leases > a place whose holder stopped beating is dropped, and a live one is kept beating` |
| T-0042-M17 | packages/pool/src/shared.ts | pruned dead holders only in memory (did not write the book) | `FilePlaces leases > pruning a dead holder is written, so a waiter does not see a changed version at once` |
