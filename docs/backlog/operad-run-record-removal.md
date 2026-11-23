# Removing the record of a routine run

- Status: open, needs the owner's decision
- ADRs touched: 0030 (D10, routine runs are `R-` records), 0002 (kernel boundary)
- Source: T-0781

## The gap

A routine keeps its runs in its history for 30 days (`withRun` in
`packages/bot/src/schedule.ts` drops an older run from the list). The run's
`R-` chat object is never removed: the storage interface (`ObjectStore`:
`put`, `get`, `list`, `append`) and the SQLite store have no removal, so the
hidden record stays in the store after it leaves the history.

## Options

1. Kernel feature (recommended): add `remove(type, id)` to `ObjectStore` and the
   SQLite store (the fact history may stay), then have the bot call it for each
   run `withRun` drops. This is a kernel addition and needs approval.
2. Kernel-free, smallest: when a run leaves the history, `put` its record again
   with only the fields needed to keep the id from being reused (`parent`,
   `cwd`, `title`, `run`) and the rest dropped. It bounds the size of the
   object, but the object and its facts remain.

## Done when

A run older than 30 days has no object in the store, and a test shows it.
