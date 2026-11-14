# TLA+ models

Models of the design, checked with TLC. They are run by hand and are part of no
check (`scripts/verify.sh`, `scripts/check-changed.sh` and the gate commands
do not call them). TLC is not a dependency of any package.

## Running a model

```
bash scripts/tla.sh <model> [TLC arguments...]
```

`<model>` is a directory of `tla/` holding `MC.tla` (constants and the model's
small instance) and `MC.cfg` (invariants and properties). Extra arguments go to
TLC, for example `-deadlock`, `-workers 4` or `-simulate`. The script fetches a
pinned `tla2tools.jar` into `${XDG_CACHE_HOME:-~/.cache}/operad/tla`, checks its
sha256 against the value in the script and refuses to run on a mismatch. It
needs Java 11 or later. TLC's state files go to a scratch directory that the
script removes.

## `pool`: how dev hands tasks to workers

Code it stands for: `packages/pool/src/index.ts` (`acquire`, `attempt`, the
fallback), `packages/pool/src/places.ts` (`claim`), `packages/dev/src/steps.ts`
(`poolParams`, the work step's rework, retry wait and `finish`). Decisions of
ADR 0021 it stands for:

| ADR 0021 | In the model |
|---|---|
| D2 home total per harness | `Cap` on the listed harnesses (`Capped`); the others have no total; `homeUsed` |
| D3 repository share | `WCount` per worker; `used`; one default pool per repository |
| D4 both layers have room | `Room(w)`: `OwnRoom(w) /\ HomeRoom(w)`, taken in one atomic `Claim` |
| D5 whoever is free takes the work | `Claim`: the first free worker in the pool's order (`WRank`); none free means the task stays `waiting` |
| D7 rework goes to the worker that ran last | `Rework`, `ReworkRunning`: `want` is the worker the latest attempt recorded; the task waits for that one only |
| D8 fallback | `RunModelError`: the first worker's places are released, then the fallback worker is claimed; a timeout (`RunFailed`) does not trigger it; the chain is one step (checked in `ASSUME`) |
| D9 no fallback waits | `RunModelError` with no fallback: `retry` (the retry wait, `MaxWaits` times) for the same worker, then `person`; never another worker |
| D11 reviewer not in a pool | the `review` phase holds nothing |
| a task that ends, fails, is cancelled or reworked while holding a place | `RunDone`, `RunFailed`, `RunModelError`, `CancelRunning`, `ReworkRunning` all release (`EndRun`) |

Invariants checked: `RepoLimit`, `HomeLimit` (neither layer's limit is
exceeded), `OneTaskPerSlot` (a worker holds at most `count` tasks; a task holds
at most one worker), `SlotsMatchHolders` (the book's counts equal what running
tasks hold: a place is released whenever its task stops holding it),
`RunsOnAsked` (a rework, a fallback or a retry runs only on the worker asked
for), `RunsInOwnRepo`, `ReviewerHoldsNothing`, `NoHoldAndWait` and
`NoWaitCycle` (a waiting task holds nothing, so the waits of rework-to-last-worker
and of no-fallback-waits form no cycle).

Properties checked, under weak fairness of `Start`, `Claim`, the end of a run
and the retry timer (cancel, rework, the reviewer and a person are not fair):
`WaitingGetsWorker` (a waiting task stops waiting) and `RunsEnd`.

Instance (`MC.tla`): harnesses claude, pi, codex; claude and pi capped at 1 at
home; repositories r1 and r2; workers `r1claude` (falls back to `r1pi`),
`r1pi`, `r2claude`, `r2pi` (share 2, above the home total), `r2codex` (no
fallback); three tasks (two in r1, one in r2); `MaxAttempts = 2`,
`MaxWaits = 1`.

Left out: the repository's `concurrency` and a pool's `concurrency` (D4; they
count active tasks in the scheduler, `schedule.ts`, not places); several pools
and a worker shared by two pools; a rework naming a worker no longer in
`workers` (D7); the lease and heartbeat of `FilePlaces` and a crashed process;
per-model `concurrency` of a harness plugin (D11); the integration queue and
the main clone (a later model); the task's other phases, plans and areas.
Attempts and retry waits are bounded so the state space is finite. The choice
of worker among several free ones follows the listed order; the real wake-up
order of waiters is not a queue, which the model does not constrain.

Differences from ADR 0021 (the model follows the code):

- The fallback triggers when the harness step throws, not only on `unavailable`,
  `usage_limit` or a start failure (`first.kind === "threw"` in `pool/agent`).
  The model treats a throw like a model error.
- D9 "waits as `retry_wait` does": the work step retries after `retrySecs`, at
  most `MAX_WORK_WAITS` times, then waits for a person. Modelled as `retry`.

Run it: `bash scripts/tla.sh pool` (TLC 2.19, release v1.7.4) takes about three minutes on ten cores
(326,670 distinct states, 1,578,576 generated, depth 32). A fourth task did not
finish in twenty minutes.
