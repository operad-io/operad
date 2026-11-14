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
| D9 no fallback waits | `RunModelError` with no fallback: `retry` (the retry wait, `MaxWaits` times) for the same worker, or `person`; never another worker. In the code only an unavailable model or usage limit retries (`modelUnavailable`); a process that did not start (`missing`, `spawn`) goes to a person. The model does not tell the two causes apart, so either may happen |
| D11 reviewer not in a pool | the `review` phase holds nothing |
| a task that ends, fails, is cancelled or reworked while holding a place | `RunDone`, `RunFailed`, `RunModelError`, `CancelRunning`, `ReworkRunning` all release (`EndRun`) |

Invariants checked: `RepoLimit`, `HomeLimit` (neither layer's limit is
exceeded), `OneTaskPerSlot` (a worker holds at most `count` tasks; a task holds
at most one worker), `SlotsMatchHolders` (the book's counts equal what running
tasks hold: a place is released whenever its task stops holding it),
`RunsOnAsked` (a rework, a fallback or a retry runs only on the worker asked
for), `RunsInOwnRepo`, `ReviewerHoldsNothing` and
`NoHoldAndWait` (a waiting task holds nothing, so a waiting task only waits for running tasks, which wait for nobody: that is the argument that waits form no cycle; an earlier `NoWaitCycle` invariant was vacuous and was removed).

Properties checked, under weak fairness of `Start`, `Claim`, the end of a run
and the retry timer (cancel, rework, the reviewer and a person are not fair):
`WaitingGetsWorker` (a waiting task stops waiting) and `RunsEnd`. `WaitingGetsWorker` holds because tasks, attempts and waits are bounded and `Claim` is weakly fair; it says little about starvation in the code, where the wake-up of waiters is not a queue and a waiter may lose a capped harness again and again.

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
- The bound is not the code's. After a retry wait the work step's worktree visit
  is not a replay, so it counts a new attempt (`attemptFor`), and `prepare` sets
  `workWaits` to 0 (`steps.ts`): in the code each retry restarts the wait budget
  and nothing bounds the loop. `Retry` counts an attempt and resets `waits` while
  `attempts < MaxAttempts`; after that the count stays and the waits run out, so
  the model is finite.

Also modelled, found by trace validation (below): `Reverify`, a person's `reverify` of a task that waits after its work failed or ran out of time. The dev flow verifies and reviews what the work left, with no worker; the first model had no such step.

Run it: `bash scripts/tla.sh pool` (TLC 2.19, release v1.7.4) takes about 2 min on ten cores
(207,082 distinct states, 1,071,194 generated, depth 32, 52 s on ten cores, after `Retry` counts attempts and `RunModelError` may go to a person; 326,670 distinct and about 2 min before). A fourth task did not
finish in twenty minutes with the earlier model.

## `integrate`: the integration queue and the main clone

Code it stands for: `packages/dev/src/integration-queue.ts` (tickets, claims,
results, `turn`, `claim`, `fallBack`, `publish`, `finish`),
`packages/dev/src/integrate.ts` (`runIntegrate`, `landBatch`, the replay after a
crash, `recordMerged`), `packages/dev/src/mainclone.ts` (`updateMainClone`).
ADR 0034 had not merged; the model follows the code, including T-0432 (a withdrawal and a batch leader's last check and push share `land.lock`; the result goes pending, pushed, done) and T-0433 (the saved `prepareDue` marker makes a restart run prepare).

Run: `bash scripts/tla.sh integrate` (config `MC.cfg`). Other configurations go
after `-config`:

| Config | Tasks and constants | What it checks |
|---|---|---|
| `MC.cfg` | 3 tasks, `MaxVer`=0, `MaxHand`=1, `MaxLocal`=0, `MaxCrash`=0, `MaxRound`=2, `BatchMax`=2 | invariants and properties below, with `NoUnwantedMerge` and `PrepareRan` (not `OneMerge`: finding 4 violates it here) |
| `MCCrash.cfg` | 2 tasks, `MaxVer`=1, `MaxHand`=1, `MaxLocal`=0, `MaxCrash`=1 | the same, with one rework and one kill, with `PrepareRan` but not `NoUnwantedMerge` (finding 5 violates it here) |
| `MCLocal.cfg` | 2 tasks, `MaxVer`=0, `MaxHand`=1, `MaxLocal`=1, `MaxCrash`=0 | the same (with `OneMerge`, `NoUnwantedMerge`, `PrepareRan`), with a commit made by hand in the clone |
| `MCOneMerge.cfg` | 3 tasks, `MaxCrash`=1 | finding 1 (violates `OneMerge`; recorded, not fixed: the owner's decision recorded in `docs/backlog/operad-tla.md`; this configuration fails on purpose) |
| `MCOneMergeCancel.cfg` | 3 tasks, `MaxHand`=1, `MaxCrash`=0 | finding 4 (violates `OneMerge`, no crash needed) |
| `MCUnwanted.cfg` | 2 tasks, `MaxHand`=1 | finding 2, fixed by T-0432 (`NoUnwantedMerge` now holds) |
| `MCPrepare.cfg` | 2 tasks, `MaxCrash`=1 | a kill after the clone moves still runs prepare on restart, fixed by T-0433 (`PrepareRan` now holds) |
| `MCRejoin.cfg` | 2 tasks, `MaxVer`=1, `MaxCrash`=0 | finding 5 (violates `NoUnwantedMerge`; fails on purpose) |

Invariants: `OriginLinear` (origin/main only grows), `MergedWasChecked` (a push
happens only with the checks passed on the pushed candidate; a commit's parent is
part of its identity, so the checked commit is the merged one), `CloneNotAhead`
(the clone holds no commit origin lacks, except those made by hand there),
`LocalKept` (a hand-made commit is never dropped: only a fast-forward moves the
clone), `CloneEqualsOrigin` (at rest, a clone whose last follow succeeded and
that has no local commit equals origin/main), `OneMerge` (it holds in `MCLocal.cfg`, 2 tasks; with 3 tasks it fails, findings 1 and 4, so it is checked only in `MCOneMerge.cfg` and `MCOneMergeCancel.cfg`), `NoUnwantedMerge` (a task merged although it was cancelled or reworked; a member still wants the commit while its phase is active at the version the batch holds) and `PrepareRan` (at rest no task's marker says prepare is due).

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

How the model follows the two fixes:

- `land.lock` (T-0432): a batch leader's `Pending` (last check, result, push) is one hold of the lock, from `Pending` to `Push` (`LandHeld`: some batched leader has phase `pending`; a kill frees it). A ticket is removed only under that lock, so `Withdraw` and every other removal (`Build`'s and `Check`'s rework or failure, `Record`, `Batched1`) wait for it (`LeaveOK`), except the holder's own. A claimed follower or the leader whose batch result is `pushed` or `done` and lists it is not withdrawn: the cancel reports a merge (`PushedWith`). The result goes `pending` at `Pending`, `pushed` at `Push`, `done` at `Record`; a follower records the merge on `pushed` or `done`, or when a dead leader's pending head is on origin. A solo (not batched) push does not take the lock in the code, so it does not in the model. The model leaves out the cancel of a solo task after its push: `Withdraw` is enabled only before `pending`, while the code's `withdrawIntegration` removes the ticket of a solo task whose commit is already on main (no result file) and answers `withdrawn`.
- the prepare marker (T-0433): `due` is per task (it was one flag for the clone). The fast-forward saves `due` before moving the clone and `Prepare` clears it; a restart that finds the commit already in the clone runs prepare when its task's `due` is set. A follow that is skipped (off the branch, dirty, diverged) clears it, as the code does. The save and the fast-forward are one step; a kill between them leaves the clone unmoved, which the replay treats like a fresh follow.
- `Wanted` (the check behind `NoUnwantedMerge`) now counts a member in any active phase at the batch's version as wanting the commit; before, only `queued` or `crashed`, which called a follower that already held a turn of its own (finding 4) unwanted.

Findings (counterexamples against the intended model; 1, 4 and 5 are not fixed):

1. `OneMerge`: leader t2 publishes a batch result for follower t1 and dies; t3,
   queued behind the claimed t1, takes the turn; t1 sees that the dead leader's
   push never landed, voids the claim and takes the turn as well (trace:
   Join t2, Join t1, Join t3, Turn t2, Claim t2 {t1}, Build, Check, Pending,
   Crash t2, Turn t3, ClaimVoid t1, Turn t1). Code: the claim removal in
   `IntegrationQueue.turn()`. Pushes stay safe: a non-fast-forward push is refused.
2. `NoUnwantedMerge`: t2 claims t1 and reaches pending, t1 is cancelled, t2
   pushes a commit containing t1's change (Join t2, Join t1, Turn t2, Claim,
   Build, Check, Pending, Withdraw t1, Push). Code: the gap between `stillQueued`
   and `git push` in `landBatch`. **Fixed by T-0432** (`land.lock`); `MCUnwanted.cfg`
   and `NoUnwantedMerge` in `MC.cfg` hold.
3. `PrepareRan`: a kill after the clone moved (a push, a fast-forward, a kill, a
   restart that finds the commit in the clone) skipped prepare. **Fixed by T-0433**
   (the saved marker); `MCPrepare.cfg` and `PrepareRan` in `MC.cfg` and `MCCrash.cfg` hold.

Full runs on ten cores, no error, after T-0432 and T-0433 (T-0439; `MC.cfg` and
`MCCrash.cfg` ran together, so their times are longer than alone): `MC.cfg` 972,296
distinct states (3,743,697 generated), depth 40, 12 min 19 s; `MCCrash.cfg` 3,040,792
distinct (13,456,519 generated), depth 36, 22 min 13 s; `MCLocal.cfg` 31,816 distinct
(137,573 generated), depth 30, 13 s; `MCPrepare.cfg` 173,204 distinct (709,425
generated), depth 32, 7 s; `MCUnwanted.cfg` 15,908 distinct (60,833 generated), depth
29, 3 s. Before the fixes: `MC.cfg` 1,014,488 distinct, 8 min 28 s; `MCCrash.cfg`
3,317,520 distinct, 17 min 55 s; `MCLocal.cfg` 32,392 distinct; `MCPrepare.cfg`
178,052 distinct. Three tasks with a rework and a kill together did not finish in
twenty minutes, which is why the configurations are split.

4. `OneMerge` without a crash (found when `OneMerge` was added to `MC.cfg`): leader
   t2 claims t3 and reaches pending, a hand push moves origin/main so t2's push is
   refused, and t2 is cancelled (`Withdraw`) while its result file stays. t3's
   claim still holds (the leader left a result), so t1 takes the turn; then t3
   voids the claim, which the leader's gone without landing, and takes the turn
   too (trace: Join t1, Join t2, Join t3, Turn, Claim, Build, Check, Pending,
   HandPush, Push (refused), Withdraw t2, Turn, ClaimVoid, Turn; the task names
   are TLC's and differ in the run). Same shape as finding 1 with a cancel in
   place of a crash: the claim removal in `IntegrationQueue.turn()`. Pushes stay safe.

5. `NoUnwantedMerge` with a rework (found by T-0439 in `MCCrash.cfg`; same shape with
   no kill in `MCRejoin.cfg`): leader t1 claims t2; t2 is withdrawn for rework before
   the push (this takes `land.lock` and passes), which prunes the claim, and t2 joins
   the queue again with its new commit. t1's last check only asks whether a ticket
   named t2 exists (`stillQueued` compares names), finds the new one, and pushes the
   batch with t2's old commit (trace: Join t1, Join t2, Turn t1, Claim, Build,
   Withdraw t2 (rework), Join t2, Check, Pending, Push). Code: `stillQueued` and
   `landWhenStillQueued` in `integration-queue.ts` match tickets by task name, not by
   the verified commit a ticket carries and the claim recorded. The lock does not
   close it: the withdrawal and the rejoin both come before the lock is taken. Main
   gets the superseded commit; the reworked one merges after it. **Recorded here for
   the lead; not fixed.** `MCCrash.cfg` therefore checks `PrepareRan` but not
   `NoUnwantedMerge` (`MC.cfg`, `MCLocal.cfg` and `MCUnwanted.cfg` have no rework).

`MCOneMerge.cfg` and `MCOneMergeCancel.cfg` still fail on `OneMerge` (findings 1 and 4
are recorded, not fixed: the owner's decision recorded in `docs/backlog/operad-tla.md`). T-0432 and T-0433
did not change them (T-0439: `MCOneMerge` violated at depth 13, `MCOneMergeCancel` at
depth 15). Each finding configuration stops at its counterexample (the counts vary
between runs with the workers): about 54,000 to 63,000 distinct states and 5 to 8 s
(`MCOneMerge`, depth 13), 16,000 and 2 to 3 s (`MCUnwanted` before the fixes: 2,903 and
4 s, depth 13), 74,000 to 78,000 and 6 to 12 s (`MCOneMergeCancel`), 14,000 and 2 s
(`MCRejoin`, depth 13).

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
| T-0432: `Withdraw` takes no lock and does not see a pushed result (`~LandHeld /\ ~PushedWith(t)` removed) | `MCUnwanted.cfg` | `NoUnwantedMerge` violated (the old finding 2) | Join, Join, Turn, Claim, Build, Check, Pending, Withdraw, Push | 2,672, 12, 6 s |
| T-0432: `Withdraw` no longer waits for the push (`~LandHeld` removed) | `MCUnwanted.cfg` | `NoUnwantedMerge` violated (the old finding 2) | the same | 2,980, 12, 6 s |
| T-0432: other ticket removals do not wait for the lock (`LeaveOK` made true) | `MC.cfg` | `NoUnwantedMerge` violated: a claimed follower leaves by failing while the leader holds the lock, and the leader pushes it | 22 steps | depth 23, 8 min 26 s (seen while building the model, before `LeaveOK` was added) |
| T-0433: no prepare marker (the already-in-clone follow ignores `due`) | `MCPrepare.cfg` | `PrepareRan` violated (the old finding 3) | Join, Join, Withdraw, Turn, Claim, Build, Check, Pending, Push, Follow, Crash, Restart, Follow, Record | 34,413, 15, 9 s |

Each mutation was restored and the model rerun clean (the results above are from the restored model).

## Trace validation: do real runs fit the models

`scripts/tla-trace.ts` reads `operad history <id> --json` output (a file per
task, or one history on stdin) and writes `TraceData.tla`: the tasks, their
repositories and the events of the histories merged by time. It never opens the
store. `tla/pool/PoolTrace.tla` and `tla/integrate/IntegrateTrace.tla` check
that the events are a behaviour of `Pool` and of `Integrate`: an event the model
shows is one step of the model's `Next` on that task, after which the task's
observed phase is the one the event says; steps the history does not show are
free between two events, as long as they change no task's observed phase.

```
operad history operad/T-0417-adr-kernel --json > t0417.json     # one per task
bun scripts/tla-trace.ts --out /tmp/trace operad/T-0417-adr-kernel=t0417.json ...
TLA_MAIN=TraceMC TLA_LIB=/tmp/trace bash scripts/tla.sh pool -workers 1 -deadlock | tee /tmp/pool.out
bun scripts/tla-trace.ts verdict /tmp/pool.out
```

`<id>` is what `operad history` was given; the part before `/` is the repository.
`TLA_MAIN=TraceMC` runs `tla/<model>/TraceMC.tla` and `TraceMC.cfg` instead of
`MC`, `TLA_LIB` is where `TraceData.tla` is, and `-workers 1 -deadlock` is
needed (a dead end is a branch that took the wrong hidden step; only one worker
keeps TLC's progress register exact). TLC reports "Invariant NotAllMatched is
violated" when the model allows the whole history (the accept, with the
behaviour found); a run that ends with no error means the model stopped, and
`verdict` reads the `TRACE` lines TLC printed and says at which event
(`accepted: ...` exits 0, `rejected: ...` exits 3). The events the history
yields are `start:<step>`, `result:<step>:<result>` (the history's "work done" is
`result:work:done`), `choose:<action>` and `run:start`, `run:done`,
`run:cancelled`, `run:failed` (the run ended failed) and `run:crashed` (a step re-run after a crash). Neither of the last two is in a model, so a history holding one is rejected at it rather than accepted without it. If TLC stops for another reason (another invariant, a deadlock because `-deadlock` was left out, a parse error), `verdict` fails with that reason instead of reporting a rejection. Both specs also check the model's safety invariants on the
way. The trace check needs Java and is run by hand; the script and its test
(`scripts/test/tla-trace.test.ts`, with two real histories as fixtures) need
none.

### What the history shows and what is free

| Model | Shown (the observed phase) | Free |
|---|---|---|
| `pool` | per task: not started, the work step active (`waiting`, `running` or `retry` are one), review (anything after the work and before the merge), person (the work failed), merged, cancelled; the number of work starts (bounds `attempts`: `MaxAttempts` = the most starts of one task); the order of events across tasks | which worker, `holds`, `used`, `homeUsed`, `want`, `last`, `isFb`, `waits`, `phase` inside the work class: whether a task waited for a worker or ran, a fallback, a retry wait |
| `integrate` | per task: integrating (queued up to followed), merged, sent back (`idle`), failed (person), cancelled; the number of failures that sent a task back (`MaxVer`); the order across tasks | the queue, the turn, claims and batches, candidates, checks, rounds, the push and the clone, hand pushes (one allowed), crashes (none), local commits (none) |

The instance for a trace is the smallest that is not free: `pool` has one worker
with one place per repository and no home total; `integrate` has `BatchMax` 2,
`MaxRound` 2 and one hand push. The history does not tell which worker a task
used, so `pool` cannot check that two tasks never hold one worker, nor that a
task waited for the worker another task held: `operad history` does not show the
wait, which is written to the step's log and the task's row only (`steps.ts`,
`onPoolEvent`). A task that ends by `result:work:done` with the note "the branch
already has unchecked work" (no worker ran) is read as a normal run. In
`integrate` a withdrawal (`Withdraw`) is not a hidden step: a cancel has its own
event, and without this a failed integration could be explained away as a
withdrawal.

### Runs checked (the owner's home, 2026-11-13)

| Tasks | Model | Result |
|---|---|---|
| `operad-ios/T-0076-chat-bottom-followups` (reworked, work timed out, reverified) with `operad-ios/T-0077-state-colors-followups` | `pool` before `Reverify` | rejected: 7 of 9 events (145 distinct states, depth 19); the next is `result:reverify:ready` of T-0076 (model gap, fixed) |
| the same | `pool` | accepted; 114 distinct states, depth 13 |
| the same | `integrate` | accepted; 406 distinct states, depth 20 |
| `operad/T-0417-adr-kernel`, `T-0418-adr-dev-harness`, `T-0419-adr-chat-channels`, `T-0420-adr-framework-slimming` (P-0049's tasks; T-0418 and T-0420 were reworked, T-0420 failed an integration and went back) | `pool` | accepted; 6,931 distinct states, depth 47 |
| the same | `integrate` | accepted; 6,367 distinct states, depth 42 |
| the same, after T-0432 and T-0433 (T-0439; the trace spec also checks `NoUnwantedMerge` and `PrepareRan`) | `integrate` | accepted; 6,367 distinct states (18,277 generated), depth 42, 3 s |

Mutation check of the trace specs: in `Integrate.tla`, `ReworkOrFail` made to
always end in `failed` (no rework): the P-0049 trace is rejected, 7 of 10 events,
the next is `result:integrate:fail` of T-0420 (5,212 distinct states, 12 s).
In `Pool.tla`, `Reverify` taken out of `Next`: the T-0076 trace is rejected at
`result:reverify:ready`, as above.
