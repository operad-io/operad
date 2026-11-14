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
| D8 fallback | `RunModelError`: the first worker's places are released, then the fallback worker is claimed; a timeout or a thrown step (`RunFailed`) does not trigger it; the chain is one step (checked in `ASSUME`) |
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

- D9 "waits as `retry_wait` does": the work step retries after `retrySecs`, at
  most `MAX_WORK_WAITS` times, then waits for a person. Modelled as `retry`.

Run it: `bash scripts/tla.sh pool` (TLC 2.19, release v1.7.4) takes about 2 min 20 s on ten cores
(326,670 distinct states, 1,578,576 generated, depth 32). A fourth task did not
finish in twenty minutes.

## `integrate`: the integration queue and the main clone

Code it stands for: `packages/dev/src/integration-queue.ts` (tickets, claims,
results, `turn`, `claim`, `fallBack`, `publish`, `finish`),
`packages/dev/src/integrate.ts` (`runIntegrate`, `landBatch`, the replay after a
crash, `recordMerged`), `packages/dev/src/mainclone.ts` (`updateMainClone`).
ADR 0034 had not merged; the model follows the code.

Run: `bash scripts/tla.sh integrate` (config `MC.cfg`). Other configurations go
after `-config`:

| Config | Tasks and constants | What it checks |
|---|---|---|
| `MC.cfg` | 3 tasks, `MaxVer`=0, `MaxHand`=1, `MaxLocal`=0, `MaxCrash`=0, `MaxRound`=2, `BatchMax`=2 | invariants and properties below |
| `MCCrash.cfg` | 2 tasks, `MaxVer`=1, `MaxHand`=1, `MaxLocal`=0, `MaxCrash`=1 | the same, with one rework and one kill |
| `MCLocal.cfg` | 2 tasks, `MaxVer`=0, `MaxHand`=1, `MaxLocal`=1, `MaxCrash`=0 | the same, with a commit made by hand in the clone |
| `MCOneMerge.cfg` | 3 tasks, `MaxCrash`=1 | finding 1 (violates `OneMerge`) |
| `MCUnwanted.cfg` | 2 tasks, `MaxHand`=1 | finding 2 (violates `NoUnwantedMerge`) |
| `MCPrepare.cfg` | 2 tasks, `MaxCrash`=1 | a kill after the clone moves still runs prepare on restart |

Invariants: `OriginLinear` (origin/main only grows), `MergedWasChecked` (a push
happens only with the checks passed on the pushed candidate; a commit's parent is
part of its identity, so the checked commit is the merged one), `CloneNotAhead`
(the clone holds no commit origin lacks, except those made by hand there),
`LocalKept` (a hand-made commit is never dropped: only a fast-forward moves the
clone), `CloneEqualsOrigin` (at rest, a clone whose last follow succeeded and
that has no local commit equals origin/main), `OneMerge`, `NoUnwantedMerge`,
`PrepareRan` (the first two are the findings).

Properties, under weak fairness of what the code does by itself (the world, that
is hand pushes, cancel, rework, kills and the clone's owner, is not fair):
`PushedGetsMerged`, `QueuedResolves` (a task in the queue is merged, reported
failed or cancelled, or sent back for rework) and `CloneFollowsMerge` (after a
merge the clone holds the merged commit, unless the follow was skipped; an
action clause checks that a skip happens only when the clone was off the branch,
dirty or diverged, because each branch of `Follow` is enabled only under its own
condition from `updateMainClone`, so a clean clone on the branch must
fast-forward). A hand push after the last merge is not followed by the clone: the code
only follows merges it made, so "the clone ends equal to origin/main" holds only
when no hand push came after the last merge and the follow was not skipped.

Left out: the lost-acknowledgement push (the code looks whether the candidate
reached origin; the model's push is atomic), the "already on main" path where the
candidate's tree equals main's, a failing prepare (the model only has prepare
run or not run), the check places, and ADR 0034.

Findings (counterexamples against the intended model; not fixed here):

1. `OneMerge`: leader t2 publishes a batch result for follower t1 and dies; t3,
   queued behind the claimed t1, takes the turn; t1 sees that the dead leader's
   push never landed, voids the claim and takes the turn as well (trace:
   Join t2, Join t1, Join t3, Turn t2, Claim t2 {t1}, Build, Check, Pending,
   Crash t2, Turn t3, ClaimVoid t1, Turn t1). Code: the claim removal in
   `IntegrationQueue.turn()`. Pushes stay safe: a non-fast-forward push is refused.
2. `NoUnwantedMerge`: t2 claims t1 and reaches pending, t1 is cancelled, t2
   pushes a commit containing t1's change (Join t2, Join t1, Turn t2, Claim,
   Build, Check, Pending, Withdraw t1, Push). Code: the gap between `stillQueued`
   and `git push` in `landBatch`.

Full runs on ten cores, no error: `MC.cfg` 1,014,488 distinct states (3,895,029
generated), depth 40, 8 min 28 s; `MCCrash.cfg` 3,317,520 distinct (14,519,959
generated), depth 36, 17 min 55 s; `MCLocal.cfg` 32,392 distinct (139,685
generated), depth 30, 16 s; `MCPrepare.cfg` 178,052 distinct (725,105 generated),
depth 32, 29 s. Three tasks with a rework and a kill together did not finish in
twenty minutes, which is why the configurations are split.

Each finding configuration stops at its counterexample: 65,641 distinct states and 6 s
(`MCOneMerge`, depth 13) and 2,903 and 4 s (`MCUnwanted`, depth 13).

Mutation checks: one guard removed in `Integrate.tla`, TLC run, guard restored.

| Guard removed | Config | TLC result | Trace | States, depth, time |
|---|---|---|---|---|
| the checks (`Pending` accepts `built`, `Push` no longer needs `chk`) | `MC.cfg` | `MergedWasChecked` violated | Join, Turn, Claim, Build, Pending, Push | 792, 7, 9 s |
| the push only lands on the candidate's parent (`Tip(origin) = c.parent` made true) | `MC.cfg` | `OriginLinear` violated | Join, Turn, Claim, Build, Check, HandPush, Pending, Push | 2,246, 9, 10 s |
| the turn goes to the first unclaimed ticket (`TurnHolder = t` dropped) | `MC.cfg` with `OneMerge` | `OneMerge` violated | Join t1, Join t2, Turn t1, Turn t2 | 207, 5, 3 s |
| fast-forward only (`IsPrefix(clone, ts)` made true) | `MCLocal.cfg` | `LocalKept` violated | Join, Turn, Claim, Build, Check, CloneCommit, Pending, Push, Follow | 2,880, 11, 7 s |
| the follow is always skipped (the off-branch/dirty branch of `Follow` enabled by `TRUE`) | 2 tasks, `CloneFollowsMerge` | action part of `CloneFollowsMerge` violated | Join, Turn, Claim, Build, Check, Pending, Push, Follow | 573, 10, 4 s |
| the clone moves (`clone' = ts` replaced by `clone' = clone`) | 2 tasks, only `CloneFollowsMerge` | temporal property violated | Join, Turn, Join, Claim, Withdraw, Turn, Claim, Build, Check, Pending, Push, Follow, Prepare, Record | 3,132, 24, 6 s (the unmutated model passes: 3,132 states) |
| the clone follows before the push (`Pending` appends the candidate to the clone) | 2 tasks, `CloneNotAhead` | `CloneNotAhead` violated | Join, Turn, Claim, Build, Check, Pending | 1,187, 8, 4 s |
