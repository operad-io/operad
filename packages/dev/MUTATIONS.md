# Mutation records — `dev`

Rows whose mutation broke code in `packages/dev/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

## TK0002 — reviewer fallback and retry

| id | file | mutation | failing test |
|---|---|---|---|
| TK0002-M1 | packages/dev/src/gate.ts | `failureOutcome` stopped treating a model error or HTTP 429 as unavailable | `dev/review fallback and retry > a 429 falls back once, and the round passes without a rework` |
| TK0002-M2 | packages/dev/src/gate.ts | a second timeout ended as `failed` instead of waiting for a person | `dev/review fallback and retry > a second timeout waits for a person with the note` |
| TK0002-M3 | packages/dev/src/gate.ts | an unavailable round counted itself as a finished review | `dev/review fallback and retry > no fallback and a 429 wait for retrySecs, then run the review only` |
| TK0002-M4 | packages/dev/src/gate.ts | a model run was not written to the task before the round continued | `dev/review crash recovery > a crash after the first run resumes the same round on the fallback` |
| TK0002-M5 | packages/dev/flows/dev.flow.ts | sent an unavailable review to the person wait instead of the retry wait | `the dev flow > loads with the gate and the rework edges` |
| TK0002-M6 | packages/dev/src/settings.ts | ignored `reviewer.retrySecs` and always used the 120-second default | `dev/review fallback and retry > a fallback that is also unavailable waits without a rework` |
| TK0002-M7 | packages/dev/src/gate.ts | let a retry after the wait choose the fallback again in the same round | `dev/review fallback and retry > a retry after the wait does not use the fallback a second time` |
| TK0002-M8 | packages/dev/src/gate.ts | removed the chunk bound from `runReviewDue`, so it asked for the whole remaining wait in one step | `dev/review fallback and retry > a retry longer than the step timeout waits in pieces and reruns only when due` |
| TK0002-M9 | packages/dev/src/gate.ts | stopped writing a reviewer's outcome beside the report, so a crash after the answer repeated the model run | `dev/review crash recovery > a crash after the first result reuses it instead of asking again` |
| TK0002-M10 | packages/dev/flows/dev.flow.ts | left `maxVisits` at the engine default, so a long review wait hit the visit limit | `the dev flow > a review wait longer than ten pieces keeps waiting` |
| TK0002-M11 | packages/dev/src/actions.ts | reverify kept the old round's `reviewRuns` and `reviewPending` | `dev/review hardening > reverify starts review round 1 again and asks the reviewer` |
| TK0002-M12 | packages/dev/src/gate.ts | treated any `429` in the stderr tail as unavailable | `dev/review hardening > a 429 only in a stderr line or a number is not unavailable` |
| TK0002-M13 | packages/dev/src/gate.ts | judged the harness outcome before reading the report, dropping a valid report from a failed exit | `dev/review hardening > a valid report from a reviewer that then failed (report-then-exit) is used and kept` |
| TK0002-M15 | packages/dev/src/gate.ts | removed the cap on unavailable waits (also T-0163-M1) | `dev/review hardening > an unavailable model waits at most MAX_REVIEW_WAITS times, across a restart` |
| TK0002-M16 | packages/dev/src/gate.ts | started a reviewer run that cannot end inside the step deadline | `dev/review hardening > runs that cannot fit in the step deadline are skipped and a person decides` |
| TK0002-M17 | packages/dev/src/actions.ts | offered merge, reject, rework and reverify during the review model wait | `dev:rework and dev:reverify > a review waiting for its model offers no merge, reject, rework or reverify` |
| TK0002-M18 | packages/dev/flows/dev.flow.ts | set the flow's visit bound to 10, below the review waits | `the dev flow > loads with the gate and the rework edges` |

## T-0019-http-api — rework 4: lead actions claim the version they were offered

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M15 | packages/dev/src/actions.ts | claimed at the version read inside the action instead of the version the action was offered on, so two lead actions both won | `dev:rework and dev:reverify > an action offered a stale object loses even while the task still waits` |

## T-0020 — pairing, links and the notification hook

| id | file | mutation | failing test |
|---|---|---|---|
| TK0008-M16 | `packages/dev/src/steps.ts` | a worker model error went to a person instead of waiting | `dev/work > unavailable: a model error waits for the model instead of a person` |
| TK0008-M17 | `packages/dev/src/steps.ts` | removed the bound on work waits (also T-0148-M9, T-0102-M5, T-0167-M1) | `dev/work > unavailable: after the allowed waits the failure goes to a person` |

## T-0109 — stale install check

| id | file | mutation | failing test |
|---|---|---|---|
| T-0109-M4 | packages/dev/bunfig.toml | emptied the package's test preload | `scripts/check-install.ts > bun test run from a package directory stops on the same line` |

| id | file | mutation | failing test |
|---|---|---|---|
| TK0019-M1 | packages/dev/src/model.ts | stopped skipping headings inside a fenced block | `dev model > a fenced Rework heading is text, not a section` |
| TK0019-M2 | packages/dev/src/service.ts | took no repository lock, so two adds read the same next number | `dev plans and tasks > two task adds at once get distinct ids and lose nothing` |
| TK0019-M3 | packages/dev/src/service.ts | allowed a plan with no tasks to be confirmed | `dev plans and tasks > confirming a plan readies its proposed tasks; an empty plan is refused` |
| TK0019-M5 | packages/dev/src/service.ts | stopped collecting a running task's run id when a plan was cancelled | `dev plans and tasks > cancelling a plan cancels a running task and asks the kernel to cancel its run` |
| TK0019-M7 | packages/dev/src/commands.ts | looked a task up by its bare id instead of the repository's store key in `task edit`/`task update` | `operad with the dev plugin > task edit and update resolve the repository like every other command` |
| TK0019-M8 | packages/dev/src/service.ts | dropped the cancelled-plan recheck inside `addTask`'s lock | `dev checks inside the lock > task add rechecks that its plan is not cancelled` |
| TK0019-M9 | packages/dev/src/service.ts | dropped the open-task recheck inside `removeRepository`'s lock | `dev checks inside the lock > repo remove rechecks that no task is open` |
| TK0019-M10 | packages/dev/src/service.ts | let `repositoryOf` return a repository marked removed | `dev checks inside the lock > a write refuses a repository that was removed` |
| TK0019-M11 | packages/dev/src/model.ts | made `storeKey` return the bare id, so two repositories shared one key | `dev per-repository ids > two repositories may both hold TK0001-work under different keys` |
| TK0019-M12 | packages/dev/src/service.ts | skipped the takeover of a lock whose pid is dead | `the lock file > a lock left by a dead pid is taken over` (timed out) |
| TK0019-M13 | packages/dev/src/service.ts | removed the source-checkout wording from `repo add`'s refusal | `repo add never writes into the operad checkout > the operad source checkout is refused` |
| TK0019-M21 | packages/dev/src/model.ts | parsed the namespaced store key instead of the bare id when choosing the next number | `dev per-repository ids > ids count up across different slugs in one repository` |
| TK0020-M1 | packages/dev/src/steps.ts | skipped merging the latest main into a reused worktree | `dev/worktree > reuses the worktree and merges the latest main into it` |
| TK0020-M2 | packages/dev/src/steps.ts | treated a plain directory at the worktree path as a worktree | `dev/worktree > a directory that is not a worktree is refused, not reused` |
| TK0020-M3 | packages/dev/src/steps.ts | ignored uncommitted changes after the harness | `dev/work > failed: uncommitted changes are named` |
| TK0020-M4 | packages/dev/src/steps.ts | skipped pushing the task branch | `dev/work > done: new commits and a clean tree are pushed` |
| TK0020-M5 | packages/dev/src/settings.ts | stopped rejecting a non-string `remote` | `dev/worktree > settings errors name the field` |
| TK0020-M6 | packages/dev/src/steps.ts | counted a replay of the same run as a new attempt | `dev/worktree > a replay of the same run reuses the attempt number` |
| TK0020-M7 | packages/dev/src/steps.ts | treated a worktree visit after `work` as a replay of the same run | `dev/work > a failed work and a new worktree visit in the same run count a new attempt` |
| TK0020-M8 | packages/dev/src/settings.ts | accepted a `worktreeRoot` that is absolute or outside the repository | `dev/worktree > a worktreeRoot outside the repository is refused` |
| TK0020-M9 | packages/dev/src/settings.ts | rejected the `worktrees` and `sandbox` fields of settings from an earlier version | `dev/worktree > settings written by an earlier version still load` |
| TK0020-M10 | packages/dev/src/steps.ts | compared HEAD with the base for equality instead of checking ancestry | `dev/work > nothing: a reset below the base is not new work` |
| TK0020-M11 | packages/dev/src/settings.ts | made `assertInsideRepository` return before resolving any real path | `dev/worktree > a worktreeRoot that is a symlink out of the repository is refused` |
| TK0020-M12 | packages/dev/src/steps.ts | returned `ready` after checking out a remote work branch without merging the fetched main | `dev/worktree > a remote work/<id> branch is reused after merging the latest main` |
| TK0020-M13 | packages/dev/src/steps.ts | omitted an empty `worker.args` from the harness params, so the flow's args were used | `dev/work > an empty worker.args is passed, not the flow's args` |
| TK0020-M14 | packages/dev/src/steps.ts | read the changed files only when the harness reported `done` | `dev/work > failed: a failed harness still names the files it left` |
| TK0021-M1 | packages/dev/src/gate.ts | recorded every verify as `pass` | `dev/verify > a failing command records the command and its log` |
| TK0021-M2 | packages/dev/src/gate.ts | made `atOrAbove` always true, so a minor finding failed a major gate | `dev/review > a minor finding under a major fix level passes` |
| TK0021-M3 | packages/dev/src/gate.ts | stopped marking a finding on an untouched file pre-existing | `dev/review > a finding on a file the change did not touch is pre-existing and does not count` |
| TK0021-M4 | packages/dev/src/gate.ts | skipped the whole-diff size check | `dev/review > 2 MB of real code fails before a reviewer starts and records the size` |
| TK0021-M5 | packages/dev/src/gate.ts | made every rework auto-rework, never asking a person | `dev/rework > two failures rework and the third waits for a person` |
| TK0021-M6 | packages/dev/src/gate.ts | dropped verify's replay reuse, so a moved branch was verified again | `dev/verify > a replay of the same run keeps the first verified commit` |
| TK0021-M7 | packages/dev/src/gate.ts | returned no attributes, so a vendored 3 MB script entered the diff | `dev/review > a vendored 3 MB script is listed once and the code is reviewed` |
| TK0021-M8 | packages/dev/src/gate.ts | removed the second reviewer attempt after invalid JSON | `dev/review > invalid JSON is retried once and the second report passes` |
| TK0021-M9 | packages/dev/src/gate.ts | accepted a FIFO as the review report instead of refusing it | `dev/review > a FIFO at the report path fails instead of blocking the gate` |
| TK0021-M10 | packages/dev/src/gate.ts | re-ran a rework instead of reusing the one the run recorded | `dev/rework > a replay of the same rework run appends and counts nothing` |
| TK0021-M11 | packages/dev/src/steps.ts | kept the rework mark when the worktree started a new attempt | `dev/rework > a new attempt in the same flow run appends the next rework` |
| TK0021-M12 | packages/dev/src/gate.ts | filled a missing finding line with 0 instead of refusing the report | `dev/review > a finding without a line is an invalid report and is retried` |
| TK0021-M13 | packages/dev/src/gate.ts | counted the retry as a new review, so the first review's retry got `args` instead of `firstArgs` | `dev/review > the retry after an invalid report keeps the round's arguments` |
| TK0022-M1 | packages/dev/src/integrate.ts | removed the replay check against the remote's main, so a recovery pushed the candidate again | `dev/integrate > a kill after the push recovers with no second push` |
| TK0022-M2 | packages/dev/src/integrate.ts | made `headMoved` always false, so a branch that moved past the verified sha was not recorded | `dev/integrate > the verified sha is merged even after the branch head moves` |
| TK0022-M3 | packages/dev/src/integrate.ts | treated a merge conflict as a plain failure instead of `conflict` | `dev/integrate > a conflict appends the conflict rework and leaves main alone` |
| TK0022-M4 | packages/dev/src/actions.ts | removed the waiting-phase check from `merge` and `reject` | `dev actions > merge and reject refuse a running task` |
| TK0022-M5 | packages/dev/src/integrate.ts | stopped recording a failing cleanup hook | `dev/cleanup > a failing hook is recorded and the task stays merged` |
| TK0022-M6 | packages/dev/src/integrate.ts | removed the check that the remote's main contains the candidate after a failed push, so a push that landed was rebuilt and pushed again | `dev/integrate > a push that lands and reports an error is not pushed again` |
| TK0023-M1 | packages/dev/src/schedule.ts | dropped the repository concurrency limit, leaving only the plan limit | `dev scheduling > concurrency 2 starts two tasks and the repository limit still wins` |
| TK0023-M2 | packages/dev/src/schedule.ts | made `dependencyState` always ready | `dev scheduling > a task starts only after every task it follows has merged` |
| TK0023-M3 | packages/dev/src/schedule.ts | removed the review-pass check before auto merge answered a wait | `dev scheduling > auto merge answers a passed review once and never answers other waits` |
| TK0023-M4 | packages/dev/src/schedule.ts | removed priority from the plan order | `dev scheduling > the highest priority plan starts first` |
| TK0023-M5 | packages/dev/src/schedule.ts | treated a cancelled dependency as merely unmerged, so the dependent task stayed ready | `dev scheduling > a cancelled dependency leaves the dependent task as a person wait` |
| TK0023-M6 | packages/dev/src/schedule.ts | stopped checking `finishedReported`, so every tick reported a finished plan | `dev scheduling > a finished plan is reported once` |
| TK0023-M7 | packages/dev/src/actions.ts | made `dev:auto` always set `off` instead of the requested level | `dev actions > auto and priority actions move the plan` |
| TK0023-M8 | packages/dev/src/schedule.ts | ignored `startRequested`, so a manual start never started | `dev scheduling > start starts one ready task while its plan is at auto off` |
| TK0023-M9 | packages/dev/src/gate.ts | set a failed verify back to `running` instead of `review` | `dev/verify > a failing command records the command and its log` |
| TK0023-M10 | packages/dev/src/schedule.ts | removed the per-attempt auto-merge marker, so a second tick answered again | `dev scheduling > auto merge answers a passed review once and never answers other waits` |
| TK0023-M11 | packages/dev/src/schedule.ts | removed the claim recovery, so a task left running with no run stayed stranded (also TK0023-M16) | `dev scheduling > a claim whose start never landed returns to ready and starts again` |
| TK0023-M12 | packages/dev/src/schedule.ts | let the manual-start pass reset both concurrency counters | `dev scheduling > start still respects the repository concurrency` |
| TK0023-M13 | packages/dev/src/schedule.ts | skipped the dependency check for a requested start | `dev scheduling > start still respects a dependency` |
| TK0023-M14 | packages/dev/src/gate.ts | set the early verify failure back to `running` instead of `review` | `dev/verify > a verify with no branch still records the review phase` |
| TK0023-M15 | packages/dev/src/steps.ts | ignored the flow's `blockedBy` parameter, so a cancelled dependency prepared a worktree instead of a person wait | `dev scheduling > a cancelled dependency leaves the dependent task as a person wait` |
| TK0023-M17 | packages/dev/src/service.ts | cleared `startRequested` when the claim was taken instead of when the run recorded itself | `dev scheduling > a manual start survives a crash before the run records itself` |
| TK0023-M18 | packages/dev/src/steps.ts | let a cancelled task through the claim check | `dev scheduling > a cancelled task never starts work` |
| TK0023-M19 | packages/dev/src/schedule.ts | printed `waiting -> merged` when answering the merge instead of waiting for the integrate result | `dev scheduling reports the integration transition > a refused push prints integrating -> waiting, never merged` |
| TK0023-M20 | packages/dev/src/steps.ts | skipped the claim-token comparison, so an older run could write a newer claim's task | `dev/worktree > a run whose token does not match the claim writes nothing` |
| TK0023-M21 | packages/dev/src/steps.ts | checked the caller's stale task data instead of re-reading the task under the repository lock, so a concurrent cancel was overwritten | `dev/worktree > a cancel that lands between the guard and the write is not overwritten` |
| TK0032-M1 | packages/dev/src/check.ts | ignored a failed `git ls-remote` and reported a missing branch instead of an unreachable remote | `dev init check > an unreachable remote is a failed check with git's message` |
| TK0032-M2 | packages/dev/src/check.ts | treated a reachable remote with any branch as having the main branch | `dev init check > a reachable remote without the main branch is a failed check that writes nothing` |
| TK0032-M3 | packages/dev/src/check.ts | passed the fetch URL to `git ls-remote` instead of the remote name | `dev init check > the check asks through the remote name, not its URL` |
| TK0032-M4 | packages/dev/src/views.ts | left the failed integration out of the task's note while it waits | `dev/integrate > a remote that refuses the push is failed with git's message` |
| TK0032-M5 | packages/dev/src/check.ts | reported only the first line of git's stderr for an unreachable remote | `dev init check > an unreachable remote keeps every line of git's stderr` |
| reviewer-stall-M1 | packages/dev/src/gate.ts | stopped passing `reviewer.stallSecs` to the review harness step | `dev/review > reviewer.stallSecs reaches the harness step, and is absent when unset` |
| TK0012-M2 | packages/dev/flows/dev.flow.ts | removed the `worktree` step's `interrupted` edge | `the dev flow > loads with the gate and the rework edges` |
| TK0012-M4 | packages/dev/src/schedule.ts | stopped reconciling a waiting task with the runs in the log, so an orphaned task was never repaired | `dev scheduling > serve repairs a task whose run ended without an edge, and reject runs again` |
| TK0011-M9 | packages/dev/src/model.ts | `parseId` rejected the old `PL`/`TK` form, so an old id in two repositories was ambiguous | `operad with the dev plugin > show and dev:confirm take an old id, and an id is matched exactly` |
| TK0011-M10 | packages/dev/src/model.ts | `numberById` skipped ids in the old form, so allocation started from 1 instead of the highest old number | `dev per-repository ids > new ids count past old ids in either form` |
| TK0011-M11 | packages/dev/src/model.ts | `formatId` emitted the old `PL`/`TK` form for new objects | `dev per-repository ids > ids count up across different slugs in one repository` |
| lead-actions-M1 | packages/dev/src/service.ts | the claim ignored the version it was given and checked only the phase | `dev:rework and dev:reverify > rework racing merge in two processes: exactly one wins` |
| lead-actions-M2 | packages/dev/src/actions.ts | `dev:rework` did not reset the count of automatic reworks | `dev:rework and dev:reverify > a lead rework resets the streak of automatic reworks, and numbers on` |
| lead-actions-M3 | packages/dev/src/actions.ts | `dev:reverify` kept the old verify result, so the verify step would replay it | `dev:rework and dev:reverify > reverify from a gate failure clears the gate results and answers reverify` |
| lead-actions-M4 | packages/dev/src/actions.ts | a failed answer left the claim (the lead section) on the task | `dev:rework and dev:reverify > an answer that fails gives the claim back` |
| lead-actions-M5 | packages/dev/src/actions.ts | `dev:reverify` accepted a task that never worked | `dev:rework and dev:reverify > reverify of a task that never worked refuses and leaves it alone` |
| lead-actions-M6 | packages/dev/flows/dev.flow.ts | the `reverify` choice had no edge to `verify` | `the dev flow > loads with the gate and the rework edges` |
| waiting-notices-M1 | packages/dev/src/announce.ts | the event key carried a random part, so a replayed step emitted a second event | `dev.waiting > work did nothing: one event, once, also when the step runs again` |
| waiting-notices-M2 | packages/dev/src/views.ts | a plan row left out its auto level and priority | `dev views > a plan row shows the derived state and merged/total` |
| waiting-notices-M4 | packages/dev/src/actions.ts | `dev:merge` accepted a task with no verified commit | `dev actions > merge refuses a task whose head was never verified, and says why` |
| waiting-notices-M8 | packages/dev/src/views.ts | lists never named the repository | `operad with the dev plugin > lists name the repository once more than one is registered` |
| waiting-notices-M9 | packages/dev/flows/dev.flow.ts | a worker that did nothing went to the wait without an announce step | `the dev flow > loads with the gate and the rework edges` |
| waiting-notices-M10 | packages/dev/src/announce.ts | a stopped run returned `done`, so the wait lost the step that stopped | `dev.waiting > a stopped worktree step names the step that stopped: one event, once, also when the step runs again` |
| waiting-notices-M11 | packages/dev/src/actions.ts | `dev:priority` on a plan with auto off printed nothing | `dev actions > priority on a plan whose auto level is off says the scheduler will not start it` |
| waiting-notices-M12 | packages/dev/src/views.ts | a long diff was not paged by file | `dev views > the diff section is the stat and the diff, and pages by file when long` |
| review-did-not-finish-M1 | packages/dev/src/announce.ts | named the reason `review failed` again | `dev.waiting > a review that did not finish: one event, once, also when the step runs again` |
| TK0005-M2 | packages/dev/src/lock.ts | did not map `LockTimeoutError` to the dev lock error | `the repository lock > a live holder past the deadline is a dev lock error naming its pid` |
| TK0006-M1 | packages/dev/src/service.ts | `claimTaskStart` skipped the area check under the lock | `two schedulers on one store never start two tasks of one area` |
| TK0006-M2 | packages/dev/src/service.ts | `areaHolder` ignored tasks in the review phase | `a claim is refused while a task of the area is running or reviewing` |
| TK0006-M3 | packages/dev/src/service.ts | `areaHolder` ignored the repository | `the same area in another repository does not block` (and the two-scheduler test) |
| T-0027-M5 | packages/dev/src/stdin.ts | a supplied `input` became an empty string instead of the command's stdin text | `command runs plugin verbs with input and refuses a kernel verb` |
| T-0022-M5 | packages/dev/src/steps.ts | `harnessReading` ignored the usage's cost | `dev/work > the standard usage gives the row's cost and the tokens` (and the old-fact test) |
| T-0022-M14 | packages/dev/src/views.ts | `costNote` left the cost quality out | `dev views > a task row reads the phase and the cost` |
| TK0009-M7 | packages/dev/src/service.ts | the generated dev.json left out `$schema` | `dev repositories > add writes settings and excludes, list reads it, remove refuses open tasks` |
| T-0034-M1 | `packages/dev/src/gate.ts` | numstat read without rename detection | `dev/review > renames and deletions > a rename with no edit is one line` |
| T-0034-M2 | `packages/dev/src/gate.ts` | a deleted file carried its removed lines | `dev/review > renames and deletions > a deleted file is one line with its length and how to read it` |
| T-0034-M3 | `packages/dev/src/gate.ts` | a rename with no edit carried a patch | `dev/review > renames and deletions > a rename with no edit is one line` |
| T-0034-M4 | `packages/dev/src/gate.ts` | a rename with edits was diffed by its new path only | `dev/review > renames and deletions > a rename with an edit carries only the edit` |

## dirty-names — the changed-file list keeps whole names

| id | file | mutation | failing test |
|---|---|---|---|
| dirty-names-M1 | packages/dev/src/steps.ts | `git()` trimmed the output even when `raw` was set | `changedFiles > a modified tracked file that comes first keeps its whole name` |
| dirty-names-M2 | packages/dev/src/steps.ts | `changedFiles` did not ask for raw output | `changedFiles > a modified tracked file that comes first keeps its whole name` |
| dirty-names-M3 | packages/dev/src/steps.ts | a rename's old path was listed as a file | `changedFiles > a rename reports the new path only, whole` |
| dirty-names-M4 | packages/dev/src/steps.ts | the name was cut at column 2 instead of 3 | `changedFiles > a modified tracked file that comes first keeps its whole name` |
| dirty-names-M5 | packages/dev/src/steps.ts | `-z` left out of the status call | `changedFiles > a modified tracked file that comes first keeps its whole name` |
| T-0048-M6 | packages/dev/src/model.ts | the task `done` filter also listed cancelled | `the task filters come from the phase list`, `docs/manual.md lists the dev filters with the states the code declares` |

## T-0047 — repository hints and qualified ids

| id | file | mutation | failing test |
|---|---|---|---|
| T-0047-M1 | packages/dev/src/service.ts | the error listed no registered repositories | `outside every repository: the error says where, ...` |
| T-0047-M2 | packages/dev/src/service.ts | a qualified id ignored its prefix and used the directory | `outside every repository: ...` (qualified start) |
| T-0047-M3 | packages/dev/src/service.ts | a `--repo` that differs from the qualified id was accepted | `a qualified id with an unknown repository, or a conflicting --repo, is refused` |
| T-0047-M4 | packages/dev/src/service.ts | a bare id outside a repository took the first repository that has it instead of refusing several | `outside every repository: ...` (ambiguous start) |
| T-0047-M5 | packages/dev/src/service.ts | a repository with no path on disk was not marked missing | `a qualified id with an unknown repository, or a conflicting --repo, is refused` |
| T-0047-M6 | packages/dev/src/service.ts | `resolveDevKey` swallowed the repository hint error | `outside every repository: ...` (show / dev action with an id nowhere) |
| T-0047-M7 | packages/dev/src/service.ts | a qualified id skipped the registered-repository check | `outside every repository: ...` (unknown repository in show / dev action) |
| T-0047-M8 | packages/engine/src/views/presentation.ts | a qualified id that matches a stored object skipped the registered-repository check | `a qualified id whose repository was removed is refused though its object is stored` |
| T-0046-M1 | packages/dev/src/service.ts | the upper bound of a plan's concurrency was 100 instead of 16 | `dev actions > addPlan takes a concurrency and refuses one out of range` |
| T-0046-M2 | packages/dev/src/service.ts | `setConcurrency` did not refuse a cancelled plan | `dev actions > concurrency is refused on a cancelled plan` |
| T-0046-M3 | packages/dev/src/service.ts | `addPlan` ignored the given concurrency | `operad with the dev plugin > plan add takes --concurrency and dev:concurrency takes --count` |
| T-0046-M4 | packages/dev/src/views.ts | the plan row left out the concurrency | `dev actions > concurrency sets the plan's count and the view shows it` |
| T-0046-M5 | packages/dev/src/service.ts | `setConcurrency` accepted a finished plan | `dev actions > concurrency is refused on a finished plan` |
| T-0046-M6 | packages/dev/src/actions.ts | `dev:concurrency` was available on a finished plan | `dev actions > concurrency is refused on a finished plan` |
| T-0045-M5 | packages/dev/test/gate.test.ts | the FIFO the fake reviewer made was not removed after the test | `dev/review > the FIFO the previous test made is gone, and it was made outside the repository` |
| T-0057-M1 | packages/dev/src/actions.ts | `dev:rework` answered the wait with the choice `reject` again | `dev actions > rework answers the wait with the choice rework and the note` |
| T-0054-M1 | packages/dev/src/rerun.ts | a timeout was rerun like any other failure | `dev/verify > a timeout is not rerun` |
| T-0054-M2 | packages/dev/src/rerun.ts | the rerun loop ran one time too many | `dev/verify > a check that fails twice is a fail` |
| T-0054-M3 | packages/dev/src/rerun.ts | a pass on the rerun carried no note | `dev/verify > a check that fails once and then passes is a pass with a note` |
| T-0054-M4 | packages/dev/src/rerun.ts | the separator was not drawn between the two runs in the log | `dev/verify > a check that fails once and then passes is a pass with a note` |
| T-0054-M5 | packages/dev/src/integrate.ts | the merged task left out the rerun note | `dev/integrate > a key command that fails once and then passes lands with a note` |
| T-0058-M1 | packages/dev/src/mainclone.ts | the clean-tree check was skipped | `dev/integrate main clone > a dirty clone is left alone with the note` |
| T-0058-M2 | packages/dev/src/mainclone.ts | the branch check was skipped | `dev/integrate main clone > a clone on another branch is left alone` |
| T-0058-M3 | packages/dev/src/mainclone.ts | the install ran when bun.lock did not change and not when it did | `dev/integrate main clone > a lockfile change runs the install in the clone, once, after the fast-forward` |
| T-0055-M1 | packages/dev/src/steps.ts | the base stayed the head before the merge of main, so the merge counted as the worker's work | `dev/work after main moved > a clean merge and no change by the worker is nothing` |
| T-0055-M2 | packages/dev/src/steps.ts | the Changes section did not say what was merged | `dev/work after main moved > a rework gets main's commit, and the attempt and Changes say so` |
| T-0055-M3 | packages/dev/src/steps.ts | the conflict prompt did not say resolving the merge is part of the attempt | `dev/work after main moved > a conflicting main is left for the worker and the prompt names the files` |
| T-0043-M1 | packages/dev/src/steps.ts | the work never asked for the previous attempt's worker | `dev/work with workers > a rework goes back to the worker that ran the attempt before` |
| T-0043-M2 | packages/dev/src/steps.ts | the work result did not say the earlier worker is no longer in the pool | `dev/work with workers > a worker removed from dev.json is replaced and the change is recorded` |
| T-0043-M3 | packages/dev/src/settings.ts | `concurrency` did not cap the sum of the default pool's counts | `the running-task cap > concurrency, when set, caps it further and never raises it` |
| T-0043-M4 | packages/dev/src/steps.ts | the settings were read from the task's worktree instead of the main clone | `dev/work with workers > the work reads the main clone's dev.json, not the worktree's older copy` |
| T-0043-M5 | packages/dev/src/settings.ts | `worker` together with `workers` was accepted | `dev.json workers and pools > worker and workers together refuse the file` |
| T-0043-M6 | packages/dev/src/steps.ts | the attempt did not record `fallbackFrom` | `dev/work with workers > a fallback attempt records the worker that ran, and the rework goes to it` |
| T-0043-M7 | packages/dev/src/steps.ts | an attempt that never reached a worker dropped the earlier worker | `dev/work with workers > an attempt that never reached a worker passes the earlier worker on` |
| T-0043-M8 | packages/dev/src/steps.ts | poolParams sent no `resumeSession` on a rework | `dev/work with workers > a rework resumes the session of the worker it goes back to` |
| T-0043-M9 | packages/dev/src/steps.ts | a fallback worker outside the default pool counted as removed | `dev/work with workers > a fallback outside the default pool is still the worker a rework goes back to` |
| T-0056-M1 | packages/dev/src/places.ts | allowed one more place than `checks` | `check places > three checks with a limit of 2: two run, the third waits until one ends` |
| T-0056-M2 | packages/dev/src/places.ts | a waiting check wrote nothing to the step log | `check places > three checks with a limit of 2: two run, the third waits until one ends` |
| T-0056-M3 | packages/dev/src/places.ts | a cancelled step kept waiting for a place | `check places > a cancelled step stops waiting for a place` |
| T-0056-M4 | packages/dev/src/rerun.ts | the check ran without taking a place | `check places > a check waits for a place before its command starts` |
| T-0056-M5 | packages/dev/src/places.ts | a taken place made the taker wait for its holder instead of trying the next place | `check places > a killed check releases its place` |
| T-0058-M4 | packages/dev/src/mainclone.ts | the clean-tree check ignored untracked files | `dev/integrate main clone > an untracked file makes the clone dirty and it is left alone` |
| T-0063-M1 | packages/dev/src/views.ts | a call without an end line was not marked running | `dev views > a call without an end line is marked running, with its start time` |
| T-0063-M2 | packages/dev/src/views.ts | a log of two agents showed the first one only, unlabelled | `dev views > the log section says which agent each block is from when it mixes them` |
| T-0069-M1 | packages/dev/src/marks.ts | a ready task behind a prior task was `todo`, not `blocked` | `task marks > ready behind a prior task`, `dev scheduling > a task behind a prior task is blocked until that task merges; the plan counts its active tasks` |
| T-0069-M2 | packages/dev/src/marks.ts | a task given up after the auto rework limit was `rework_pending` | `task marks > waiting, given up after the auto rework limit` |
| T-0069-M3 | packages/dev/src/marks.ts | the badge read the task's attempt count only | `task badge > follows the attempt` |
| T-0069-M4 | packages/dev/src/marks.ts | a task whose work is done drew `running`, not `checking` | `task marks > running, work done, verify next` |
| T-0069-M5 | packages/dev/src/marks.ts | read the integrating mark from the integration record, not from the step's own marker | `task marks > waiting while integrate builds the candidate` |
| T-0069-M6 | packages/dev/src/integrate.ts | kept the integrating marker after a conflict or a refused push | `dev/integrate > a conflict appends the conflict rework and leaves main alone` |
| T-0069-M7 | packages/dev/src/marks.ts | had no paused plan mapping | `plan marks > each plan state maps` |
| T-0069-M8 | packages/dev/src/marks.ts | classified a given-up rework by a hard-coded streak instead of the limit in force | `task marks > waiting, given up with a limit of 0` |
| T-0059-M5 | packages/dev/src/gate.ts | the Grading section's text was altered instead of given verbatim | `dev/review > review.json > the prompt carries the flow's grading verbatim` |
| T-0059-M6 | packages/dev/src/gate.ts | review.json's fixLevel was ignored | `dev/review > review.json > fixLevel in review.json decides whether a minor finding fails` |
| T-0059-M7 | packages/dev/src/gate.ts | an invalid review.json was swallowed instead of failing the step | `dev/review > review.json > an invalid file fails the review step naming the file` |
| T-0063-M3 | packages/dev/src/views.ts | a radian `Result` line lost its stop reason, tokens and cost | `a radian Result line shows its stop reason, tokens and cost` |

## T-0086 — rerun only the failed tests

| id | file | mutation | failing test |
|---|---|---|---|
| T-0086-M1 | packages/dev/src/rerun.ts | the limit on failed names was ignored | `dev/verify reruns only the failed tests > more names than max fails without a rerun` |
| T-0086-M2 | packages/dev/src/rerun.ts | any failure, a timeout too, was searched for names | `dev/verify reruns only the failed tests > a timeout is not rerun` |
| T-0086-M3 | packages/dev/src/rerun.ts | the pattern kept " > " instead of a space | `dev/verify reruns only the failed tests > the pattern is anchored and joins describe names with a space, as bun test -t does` |
| T-0086-M4 | packages/dev/src/rerun.ts | the shell quoting of a name was dropped | `dev/verify reruns only the failed tests > names with quotes and regex characters reach the rerun intact` |
| T-0086-M5 | packages/dev/src/rerun.ts | a failed rerun counted as a pass | `dev/verify reruns only the failed tests > a rerun that fails fails the check` |
| T-0086-M6 | packages/dev/src/reruns.ts | the count was set to 1 instead of added to | `dev/verify reruns only the failed tests > the count accumulates across tasks` |
| T-0063-M4 | packages/dev/src/views.ts | a radian `Result` with a stop reason dropped its assistant text | `a radian Result line with text keeps the assistant text and the metadata` |

## T-0064 — final states

| id | file | mutation | failing test |
|---|---|---|---|
| T-0064-M7 | packages/dev/src/model.ts | a finished plan was not a final state | `dev views > a plan row shows the derived state and merged/total` |

## T-0066 — reverify merges main first

| id | file | mutation | failing test |
|---|---|---|---|
| T-0066-M1 | packages/dev/src/steps.ts | the clean-merge history line lost "main" and "checking again" | `dev/reverify > a branch behind a non-conflicting main merges it and goes to verify, no work` |
| T-0066-M2 | packages/dev/src/steps.ts | the reverify step opened a new attempt number | `dev/reverify > a branch behind a non-conflicting main merges it and goes to verify, no work` |
| T-0066-M3 | packages/dev/flows/dev.flow.ts | the wait's reverify edge went straight to verify again | `the dev flow > loads with the gate and the rework edges` |
| T-0094-M1 | packages/dev/src/settings.ts | an invalid file threw again instead of returning the last valid settings | `a repository whose dev.json becomes invalid > a step in its own process finishes with the old settings, the log says it once, and pending clears when fixed` |
| T-0094-M2 | packages/dev/src/schedule.ts | the settings problem was logged on every tick, not once per change | `a repository whose dev.json becomes invalid > a step in its own process finishes with the old settings, the log says it once, and pending clears when fixed` |
| T-0094-M3 | packages/dev/src/schedule.ts | a ready task started although a plugin dev needs is not loaded | `a plugin dev needs that the home does not load > a pending item names the plugin and the command, and ready tasks stay ready` |
| T-0094-M4 | packages/dev/src/standing.ts | the restart item counted merges older than the running serve | `a followed merge and the code serve has loaded > a merge that touches packages/dev/src raises the item once; docs alone do not` |
| T-0094-M5 | packages/dev/src/standing.ts | a changed `*.schema.json` of a loaded package was not serve code | `a followed merge and the code serve has loaded > a merge that changes a schema serve validates with raises the item` |
| T-0094-M6 | packages/dev/src/standing.ts | every file of a loaded package counted as serve code (tests, MUTATIONS.md) | `a followed merge and the code serve has loaded > a package serve does not load, tests and a merge in another repository raise nothing` |
| T-0094-M7 | packages/dev/src/settings.ts | the home kept no copy of the last valid settings | `a repository whose dev.json becomes invalid > a process that starts while the file is invalid reads the copy the home kept` |
| T-0063-M12 | `packages/dev/src/views.ts` | a radian Result text was not cut at 300 characters | `a radian Result text is cut at 300 characters` |
| T-0063-M13 | `packages/dev/src/views.ts` | a message_end text was not cut at 300 characters | `a message_end text longer than 300 characters is cut at 300` |
| T-0044-M1 | packages/dev/src/views.ts | a long worker name was not cut in the row | `dev views > a task row shows the last attempt's worker, short, and nothing before pools` |
| T-0044-M2 | packages/dev/src/views.ts | an attempt with no worker got a row named "undefined" | `dev views > the metrics section splits cost, time and first pass by worker` |
| T-0044-M3 | packages/dev/src/views.ts | a pass in a later review round counted as first pass | `dev views > the metrics section splits cost, time and first pass by worker` |
| T-0094-M10 | packages/dev/src/schedule.ts | the once-per-change key was the message alone, not the file text | `a repository whose dev.json becomes invalid > a step in its own process finishes with the old settings, the log says it once, and pending clears when fixed` |
| T-0094-M11 | packages/dev/src/standing.ts | a plugin configured by a path to a package was not counted as loaded | `a followed merge and the code serve has loaded > a plugin loaded by a path to a package of the clone counts as loaded` |
| T-0094-M12 | packages/dev/src/standing.ts | a plugin entry given as a module string was not counted as loaded | `a followed merge and the code serve has loaded > string and array plugin entries count as loaded too` |
| T-0094-M13 | packages/dev/src/schedule.ts | the repair of a stopped task started the flow although a needed plugin is missing | `a stopped task when a plugin dev needs is missing > is not started again by the repair, and is while the plugin is loaded` |

## T-0067 — review report in the workspace, no deletion

| id | file | mutation | failing test |
|---|---|---|---|
| T-0067-M1 | packages/dev/src/gate.ts | a link in place of `.operad` or `.operad/review` was accepted as a plain directory | `dev/review report in the workspace > a symlinked operad is not followed and the review fails with the reason`, `... a symlinked review ...` |
| T-0067-M2 | packages/dev/src/gate.ts | every call got try number 0, so a retry reused the first path | `dev/review report in the workspace > a retry after an invalid report uses a new path and never reads the old file` |
| T-0067-M3 | packages/dev/src/gate.ts | a finished call with no file was labelled an invalid report | `dev/review report in the workspace > a missing report and an invalid report have different labels` |
| T-0067-M4 | packages/dev/src/gate.ts | the report was not copied from the old worktree before it was replaced | `dev/review crash before the store copy > a crash after the report was written and before its copy resumes by copying it` |
| T-0067-M5 | packages/dev/src/gate.ts | a failed store write was swallowed and the report counted | `dev/review report in the workspace > a failed store write fails the step and leaves the workspace report` |
| T-0067-M6 | packages/dev/src/gate.ts | the store path was not read when the workspace had no file | `dev/review report in the workspace > a report at the store path from an older prompt is read when the workspace has none` |
| T-0067-M7 | packages/dev/src/gate.ts | the folders were not looked at again after the call | `dev/review report in the workspace > a review folder swapped for a link during the call is not read through` |
| T-0067-M8 | packages/dev/src/gate.ts | a non-done call with no file kept its plain failure message | `dev/review report in the workspace > a reviewer that exits without a report is labelled as unable to write it` |
| T-0067-M9 | packages/dev/src/gate.ts | a failed run with no report file stayed outcome `failed` | `dev/review report in the workspace > a reviewer that exits without a report is labelled as unable to write it` |
| T-0067-M10 | packages/dev/src/gate.ts | the crash salvage and the resumed read skipped the folder check | `dev/review report in the workspace > a report found through a link swapped in after a crash is not read` |
| T-0067-M11 | packages/dev/src/gate.ts | the report read did not check the folders again, or the file identity, after opening it | `dev/review report in the workspace > a folder swapped for a link while the report is read is not accepted` |

## T-0073 — Changes tells the story

| id | file | mutation | failing test |
|---|---|---|---|
| T-0073-M1 | packages/dev/src/model.ts | no date line began a new day | `the Changes story > an entry shows its local time, and a date line starts each day` |
| T-0073-M2 | packages/dev/src/model.ts | a conflict rework was named by its section source, not "conflict" | `dev/integrate > a conflict appends the conflict rework and leaves main alone` |
| T-0073-M3 | packages/dev/src/announce.ts | the stopped-step lookup ignored the entry's time prefix | `dev scheduling > serve repairs a task whose run ended without an edge, and reject runs again` |
| T-0073-M4 | packages/dev/src/model.ts | a reason was not cut to one short line | `the Changes story > a rework names who asked and the first finding, cut to one line` |
| T-0073-M5 | packages/dev/src/gate.ts | the review and verify rework lost their reason | `dev/rework > a review failure appends the findings at or above the fix level` |
| T-0094-M14 | packages/dev/src/standing.ts | the kernel packages' dependencies (cli lists the tui) were counted as loaded code | `a followed merge and the code serve has loaded > a package serve does not load, tests and a merge in another repository raise nothing` |

## T-0076 — repository check places

| id | file | mutation | failing test |
|---|---|---|---|
| T-0076-M1 | packages/dev/src/places.ts | the repository place was never taken | `repository check places > two checks of a repository with places 1 take turns while another repository runs beside them` |
| T-0076-M2 | packages/dev/src/places.ts | the home place was never taken | `repository check places > the home limit holds with repository limits that would allow more` |
| T-0076-M3 | packages/dev/src/places.ts | every repository shared one set of place files | `repository check places > a check waiting for its repository does not hold a home place` |
| T-0094-M15 | packages/dev/src/standing.ts | a file under a `schemas/` subdirectory of a loaded package was not serve code | `a followed merge and the code serve has loaded > a nested schema or a manifest of a loaded package raises the item` |
| T-0063-M14 | `packages/dev/src/views.ts` | MessageAppended and ModelUsageRecorded journal lines were left to the fallback | `radian journal lines show the agent's text and each turn's usage; empty tool-call messages show nothing` |
| T-0092-M1 | packages/dev/src/flaky.ts | a test crossed the threshold one pass early | `a flaky test proposes a task > the threshold proposes exactly one task with the expected brief` |
| T-0092-M2 | packages/dev/src/flaky.ts | the count did not restart after the task ended | `a flaky test proposes a task > after a merge the count restarts at 0` |
| T-0092-M3 | packages/dev/src/flaky.ts | a proposal ignored an open task that names the test | `a flaky test proposes a task > an open task that already names the test stops a proposal` |
| T-0092-M4 | packages/dev/src/flaky.ts | a finished plan could receive the task | `a flaky test proposes a task > a finished plan is passed over for an older unfinished one` |
| T-0092-M5 | packages/dev/src/flaky.ts | flakyTask 0 did not turn the proposal off | `a flaky test proposes a task > flakyTask 0 proposes nothing` |
| T-0092-M6 | packages/dev/src/flaky.ts | the no-plan notice was recorded on every call | `a flaky test proposes a task > a repository without a confirmed plan records a notice and proposes nothing` |
| T-0092-M7 | packages/dev/src/flaky.ts | the failure excerpt held 31 lines before the (fail) line | `a flaky test proposes a task > the failure excerpt holds the (fail) line and up to 30 lines before it` |
| T-0092-M8 | packages/dev/src/flaky.ts | `operad reruns` showed the task of an ended fix | `a flaky test proposes a task > operad reruns shows the task beside its test while it is open` |
| T-0067-M12 | packages/dev/src/gate.ts | a file that fails validation was named no_report instead of invalid | `dev/review report in the workspace > harness failed with invalid file is invalid` |

## T-0075 — narrow metrics

| id | file | mutation | failing test |
|---|---|---|---|
| T-0075-M1 | packages/dev/src/views.ts | tokens switched to k from 1k, not 10k | `dev views > per-attempt lines leave out steps that did not run, and tokens show in k from 10k` |
| T-0075-M2 | packages/dev/src/views.ts | the total row left out the attempts' time | `dev views > the metrics summary has at most four columns, a row per attempt and a total` |
| T-0075-M3 | packages/dev/src/views.ts | a step that did not run was listed as `<1s` | `dev views > per-attempt lines leave out steps that did not run, and tokens show in k from 10k` |
| T-0075-M4 | packages/dev/src/views.ts | a conflict attempt showed no result | `dev views > how an attempt ended: merged, verify failed, conflict, cancelled` |
| T-0075-M5 | packages/dev/src/views.ts | the total row's cost kept only the last attempt's cost | `dev views > the total row sums the cost of every attempt` |
| T-0075-M15 | packages/dev/src/views.ts | the running step was taken only while the task's phase said running or review | `metrics follow the run's own step > an integrate in flight while the task waits` |
| T-0075-M16 | packages/dev/src/views.ts | the running step's time dropped what its earlier records already hold (a retried review lost its first visit) | `metrics follow the run's own step > a retried review: the retry wait runs, then the review with its pending run` |
| T-0075-M17 | packages/dev/src/views.ts | a worktree, reverify or work step that failed showed no result | `metrics follow the run's own step > a failed worktree ends the run: nothing runs and no later step is shown` |
| T-0075-M18 | packages/dev/src/views.ts | a current step that is not a recorded one (rework, a retry wait) was not shown | `metrics follow the run's own step > a failed gate: the rework step runs, then the person wait shows the failure` |
| T-0075-M19 | packages/dev/src/views.ts | a cancelled task did not show cancelled | `dev views > how an attempt ended: merged, verify failed, conflict, cancelled` |

## T-0087 — rework-round review

| id | file | mutation | failing test |
|---|---|---|---|
| T-0087-M1 | packages/dev/src/rework.ts | a review of the same commit as the previous one was a rework round | `dev/review rework rounds > a review of the same commit as the previous review gets the first prompt` |
| T-0087-M2 | packages/dev/src/rework.ts | the change window was 4 lines, not 3 | `pre-existing rules > (a) 4 lines away is moved` |
| T-0087-M3 | packages/dev/src/rework.ts | a critical finding far from the change was moved | `pre-existing rules > (c) critical far away stays` |
| T-0087-M5 | packages/dev/src/gate.ts | a resumed call built its prompt again instead of reading the recorded one | `dev/review rework rounds > a rework round resumed after a crash asks with the prompt it recorded` |
| T-0087-M7 | packages/dev/src/rework.ts | a pure deletion marked no line, so its hunk left the increment | `dev/review rework rounds > a rework that only deletes a line keeps its hunk in the increment` |
| T-0087-M8 | packages/dev/src/gate.ts | the rework-round line was not added to the task's Changes | `dev/review rework rounds > the first review gets the whole diff; a rework round gets the previous findings and the increment` |
| T-0092-M9 | packages/dev/src/flaky.ts | the failure excerpt kept secret values | `a flaky test proposes a task > secrets in a failure excerpt are masked in the record and the brief` |
| T-0092-M10 | packages/dev/src/flaky.ts | the log was cut at the first rerun heading before the failure was searched | `a flaky test proposes a task > a failure after an earlier command's rerun keeps its excerpt and file` |
| T-0092-M11 | packages/dev/src/flaky.ts | an existing open task that names the test was not linked to the record | `a flaky test proposes a task > an open task that already names the test stops a proposal` |
| T-0092-M12 | packages/dev/src/flaky.ts | a task's Changes section counted as naming the test | `a flaky test proposes a task > a task whose Changes only say the test passed on rerun does not stop the proposal` |
| T-0092-M13 | packages/dev/src/flaky.ts | the no-plan notice was not returned to the check step | `a flaky test proposes a task > a repository without a confirmed plan records a notice and proposes nothing` |
| T-0092-M14 | packages/dev/src/flaky.ts | an open task naming the test was linked only once the threshold was reached | `a flaky test proposes a task > an open task naming the test is linked on the first pass, so its end restarts the count` |
| T-0092-M15 | packages/dev/src/flaky.ts | any open task containing the test name as a substring counted as naming it | `a flaky test proposes a task > an unrelated open task that only contains a short test name is not its task` |
| T-0092-M16 | packages/dev/src/flaky.ts | a brief line equal to the name inside a fenced block counted as naming the test | `a flaky test proposes a task > which open task names a test` |
| T-0092-M18 | packages/dev/src/flaky.ts | a brief line that merely contains the name counted as naming the test | `a flaky test proposes a task > which open task names a test` |
| T-0092-M17 | packages/dev/src/integrate.ts | a failing integration check left out the no-plan notice | `dev/integrate > a failing integration check still says why no flaky task was proposed` |
| T-0092-M19 | packages/dev/src/flaky.ts | the task title cut the test name at 120 characters | `a flaky test proposes a task > two long names that share their first 120 characters each get their own task with the full name` |
| T-0087-M4 | packages/dev/src/rework.ts | a hunk in the previous diff never matched, so every hunk was new | `increment > no change since the previous review` |
| T-0087-M6 | packages/dev/src/rework.ts | the previous review was any report, not one for another commit | `dev/review rework rounds > reverify of the same commit: the first prompt, and a far finding is moved` |
| T-0087-M9 | packages/dev/src/rework.ts | context lines counted as changed lines when matching hunks | `dev/review rework rounds > a main change near the task's change is not in the increment` |
| T-0087-M10 | packages/dev/src/rework.ts | a hunk gone since the previous review was not listed as removed | `increment > a reverted hunk is listed as removed` |
| T-0087-M11 | packages/dev/src/rework.ts | a hunk was matched on its first changed line only, so a subset of a previous hunk was unchanged | `increment > a hunk that is a subset of a previous hunk is new` |
| T-0087-M12 | packages/dev/src/rework.ts | a pure deletion marked no line as changed | `lines the task's change touched > a pure deletion marks the lines either side of the cut` |
| T-0053-M1 | packages/dev/src/views.ts | a plan row left out its `parent` | `dev views > a plan row shows the derived state and merged/total` |
| T-0053-M2 | packages/dev/src/views.ts | a task row's `parent` named the bare plan id, which two repositories share | `the repo type > parent=<plan> lists its tasks, and another repository's plan with the same id does not leak` |
| T-0053-M3 | packages/dev/src/views.ts | a repo row showed 0 open tasks whatever the stored count | `the repo type > the row counts open plans and open tasks as they change` |
| T-0053-M4 | packages/dev/src/service.ts | a plan write no longer refreshed its repository's open counts | `the repo type > the row counts open plans and open tasks as they change` |
| T-0053-M5 | packages/dev/src/views.ts | a removed repository's row said `active`, so the default filter kept it | `the repo type > a repository added or removed after start fires an event and appears or disappears` |
| T-0053-M6 | packages/dev/src/service.ts | repositories stored under the old `repository` type were not carried over to `repo` | `the repo type > a repository stored before dev declared repo shows up as a repo object` |
| T-0053-M7 | packages/dev/src/views.ts | the Overview named `main` instead of the repository's configured default branch | `the repo type > the Overview names the path, the default branch, dev.json, worker and reviewer` |
| T-0095-M1 | packages/dev/src/gate.ts | verify did not run the prepare commands in the gate checkout | `prepare > runs once per checkout, before verify and before review, and the review prompt says so` |
| T-0095-M2 | packages/dev/src/gate.ts | review did not run the prepare commands in the recreated gate checkout | `prepare > a failing prepare fails review before a reviewer starts` |
| T-0095-M3 | packages/dev/src/gate.ts | the review prompt did not say the checkout is prepared | `prepare > runs once per checkout, before verify and before review, and the review prompt says so` |
| T-0095-M4 | packages/dev/src/gate.ts | the gate checkout did not link its own workspace packages when no prepare is set | `prepare > a change spanning two packages > with no prepare command the checkout still links its own packages` |
| T-0095-M5 | packages/dev/src/steps.ts | the worker's worktree was not prepared | `dev/worktree > prepare runs in the new worktree before the visit reports ready` |
| T-0095-M6 | packages/dev/src/integrate.ts | the integration checkout was not prepared | `dev/integrate > prepare runs in the integration checkout before the key commands` |
| T-0095-M7 | packages/dev/src/prepare.ts | a failing prepare command counted as a pass | `prepare > a failing prepare fails verify with its reason and log, and no gate command runs` |
| T-0095-M8 | packages/dev/src/gate.ts | review did not prepare its recreated checkout, so the test a reviewer runs there could not resolve the branch's package | `prepare > a change spanning two packages > with a prepare command that installs, the test passes in the review checkout` |
| T-0053-M9 | packages/dev/src/index.ts | the repo type declared no `prepare`, so a list in a fresh process hid repositories stored under the old type | `the repo type > a repository stored before dev declared repo shows up as a repo object` |
| T-0075-M21 | packages/dev/src/views.ts | a cancelled task's attempt ended at its last step record, not at the cancel | `metrics follow the run's own step > a task cancelled while its worker runs keeps the time up to the cancel, step included` |
| T-0075-M22 | packages/dev/src/views.ts | the step in flight at a cancel added nothing to its line | `metrics follow the run's own step > a task cancelled while its worker runs keeps the time up to the cancel, step included` |
| T-0075-M23 | packages/dev/src/views.ts | a task's time ignored the run's own end (the line and the row disagreed after a cancel) | `metrics follow the run's own step > a task cancelled while its review is in flight counts the review up to the cancel` |
| T-0075-M26 | packages/dev/src/views.ts | a cancelled task's run was read from `task.run` only, which the real cancel clears | `metrics follow the run's own step > a task cancelled while its worker runs keeps the time up to the cancel, step included` |
| T-0097-M1 | packages/dev/src/retry.ts | the retry was never spent: a second stop in the same attempt retried again | `an environment failure of the work step > a second stop in the same attempt waits for a person and says why` |
| T-0097-M2 | packages/dev/src/stops.ts | a recovered run (the interrupted edge) was classed as the task's | `classifyStop > a recovered run is environment` |
| T-0097-M3 | packages/dev/src/retry.ts | the wait ignored its bound and never expired | `an environment failure of the work step > the wait runs out: the task waits for a person, and the line names what is not loaded` |
| T-0097-M4 | packages/dev/src/steps.ts | a harness killed by a signal was recorded as the harness's own failure | `a real process killed by a signal > the work retries once by itself` |
| T-0097-M5 | packages/dev/src/retry.ts | the wait treated every step as loaded | `the night of 2026-11-08 at 08:01 > nine tasks start while pool is disabled; when it is enabled every task continues by itself` |
| T-0097-M6 | packages/dev/src/steps.ts | the host's not-loaded error kind was not read, so the failure looked like the task's | `an environment failure of the work step > a step that is not loaded: the retry waits until it is, then the work runs` |
| T-0097-M7 | packages/dev/src/steps.ts | a repair run that only asks a person was not marked, so the retry step ran the stopped step again | `dev scheduling > serve repairs a task whose run ended without an edge, and reject runs again` |
| T-0097-M8 | packages/dev/src/retry.ts | a stopped run was retried at once although the settings still could not be read | `settings that cannot be read > a stopped run whose settings still cannot be read waits for them instead of spending its retry` |
| T-0097-M9 | packages/dev/flows/dev.flow.ts | the worktree retry held onto itself instead of a wait for the settings | `settings that cannot be read, in the worktree step > a recovered worktree step waits for the settings, then runs again` |
| T-0096-M7 | packages/dev/src/index.ts | `work` did not declare `pool/agent` in `calls` | `dev/work > done: new commits and a clean tree are pushed (cost from the old fields of an old fact)` (the undeclared call fails in tests) |
| T-0088-M1 | packages/dev/src/followups.ts | a finding seen in an earlier round was listed again | `review follow-ups > collects the findings of every round and task, deduplicated, grouped by task, duplicates kept once within a task` |
| T-0088-M2 | packages/dev/src/followups.ts | a crash between the proposal and the marks left the tasks collectable again | `review follow-ups > a crash between the proposal and the marks proposes exactly one` |
| T-0088-M3 | packages/dev/src/followups.ts | a follow-up task's own findings were marked for collection | `review follow-ups > a follow-up is not collected` |
| T-0088-M4 | packages/dev/src/followups.ts | a follow-up was proposed while a task of the plan was open | `review follow-ups > nothing is proposed while a task is open` |
| T-0088-M5 | packages/dev/src/followups.ts | `reviewer.followups: false` did not stop the collection | `review follow-ups > followups false turns the mark and the collection off` |
| T-0088-M6 | packages/dev/src/followups.ts | the follow-up's `after` followed id order, not merge order | `review follow-ups > the merge order, not the id order, orders after` |
| T-0088-M7 | packages/dev/src/gate.ts | a review round recorded no notes for findings that did not fail it | `dev/review > a finding that did not fail the round is kept as a note of the round` |
| T-0088-M8 | packages/dev/src/integrate.ts | a merge did not mark the task for collection | `dev/integrate > a merge marks a task that has notes, unless followups is false` |

## T-0099 — a work step that runs out of time leaves something behind

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M1 | packages/dev/src/steps.ts | the wrap-up message was never sent at its share of the limit | `a work step that runs out of time > the wrap-up message arrives at the share of the limit, not before` |
| T-0099-M2 | packages/dev/src/steps.ts | a timed-out step's work-in-progress commit was never made | `a work step that runs out of time > a step that ignores the message and times out gets a work-in-progress commit and its note kept` |
| T-0099-M3 | packages/dev/src/steps.ts | the work-in-progress commit took the progress note with it | `a work step that runs out of time > a step that ignores the message and times out gets a work-in-progress commit and its note kept` |
| T-0099-M4 | packages/dev/src/steps.ts | a new attempt did not carry the attempt before's progress | `a work step that runs out of time > the next attempt's prompt starts with the note and the commits, and the worktree keeps them` |
| T-0099-M5 | packages/dev/src/steps.ts | the progress note counted as an uncommitted change | `a work step that runs out of time > a step that commits and writes its note before the limit keeps the note in the history` |
| T-0099-M6 | packages/dev/src/steps.ts | a run the harness's own wall time ended was not treated as a timeout | `a work step that runs out of time > a run the harness's own wall time ended is a timeout too: committed, and the next attempt continues` |
| T-0099-M7 | packages/dev/src/announce.ts | a timed-out task waited with the reason `work failed` | `the reason a timed-out task waits > work timed out, with the step's message as the detail` |
| T-0099-M8 | packages/dev/src/steps.ts | the previous attempt's note and commits were left out of the prompt | `a work step that runs out of time > the next attempt's prompt starts with the note and the commits, and the worktree keeps them` |
| T-0099-M9 | packages/dev/src/steps.ts | an old note was not removed before a new attempt's work | `a work step that runs out of time > the next attempt's prompt starts with the note and the commits, and the worktree keeps them` |
| T-0099-M10 | packages/dev/src/steps.ts | a note the worker committed anyway stayed in the branch | `a work step that runs out of time > a note the worker committed anyway is taken out of the branch and still read` |
| T-0099-M11 | packages/dev/src/steps.ts | the wrap-up share ignored `work.wrapUpAt` | `work.wrapUpAt > the share moves the wrap-up message` |
| T-0099-M12 | packages/dev/src/steps.ts | the harness got the kernel's signal, not the step's own, so the step could not stop it at its limit | `a work step that runs out of time > a step that ignores the message and times out gets a work-in-progress commit and its note kept` |
| T-0099-M13 | packages/dev/src/settings.ts | `work.wrapUpAt` accepted 0 and 1 | `work.wrapUpAt > defaults to 0.85, takes a share between 0 and 1, and refuses anything else` |

## T-0099 — rework 1: the limit is the run's own

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M14 | packages/dev/src/steps.ts | the wrap-up and stop ignored the wall time the harness reported and used the step's limit | `the limit a harness reports > a harness that reports a shorter wall time is wrapped up and stopped by that wall, not the step's limit` |
| T-0099-M15 | packages/dev/src/steps.ts | no timer was kept from the step's start as a backstop | `the limit a harness reports > a harness that never reports a run leaves only the backstop` |

## T-0144 — one integration of a repository at a time, and batching

| id | file | mutation | failing test |
|---|---|---|---|
| T-0144-M1 | packages/dev/src/integrate.ts | the step took the turn without waiting in the queue | `integration queue > two tasks of one repository integrate one after the other, the second on the first's main, with no restart` |
| T-0144-M2 | packages/dev/src/integration-queue.ts | a ticket of a dead process was never dropped | `integration queue > a turn is given back when its process dies` |
| T-0144-M3 | packages/dev/src/integration-queue.ts | a turn claimed no queued task for a batch | `integration queue > with integration.batch 3 and three queued tasks, the key commands run once and three merge commits land in order` |
| T-0144-M4 | packages/dev/src/integrate.ts | the batch's merges were built in reverse queue order | `integration queue > with integration.batch 3 and three queued tasks, the key commands run once and three merge commits land in order` |
| T-0144-M5 | packages/dev/src/integrate.ts | a failing key command in a batch did not fall back | `integration queue > a failing key command in a batch falls back, and only that task goes back to its worker` |
| T-0144-M6 | packages/dev/src/settings.ts | `integration.batch` accepted anything | `integration.batch setting > is an integer of 1 or more, and 1 when unset` |
| T-0090-M2 | packages/dev/src/views.ts | a file's page entry pointed at the previous file's cursor | `dev views > the diff section is the stat and the diff, and pages by file when long` |
| T-0145-M1 | packages/dev/src/gate.ts | left the gate commands out of the review prompt's checks section | `prepare > the review prompt names the gate commands and says not to run them again` |
| T-0124-M1 | packages/dev/src/views.ts | `costNote` swapped the `~` and `≥` symbols | `dev views > a task row reads the phase and the cost` |
| T-0124-M2 | packages/dev/src/model.ts | a task's cost change added its full new amount to the plan total instead of the difference | `dev views > a plan note shows the cost of its tasks at the weakest quality` |
| T-0124-M3 | packages/dev/src/model.ts | the plan cost took the strongest quality of its tasks, not the weakest | `dev views > a plan note shows the cost of its tasks at the weakest quality` |
| T-0124-M4 | packages/dev/src/model.ts | the plan note's total counted cancelled tasks | `dev views > the plan note by auto level, and the total leaves cancelled tasks out` |
| T-0124-M5 | packages/dev/src/views.ts | a task with no cost had no `$0.00` first part | `dev views > a task note is cost, worker, area, then a refused push` |
| T-0124-M6 | packages/dev/src/views.ts | a refused push's message came before the area instead of last | `dev views > a task note is cost, worker, area, then a refused push` |
| T-0124-M7 | packages/dev/src/service.ts | a plan stored without a cost total was never given one on refresh | `dev views > a plan stored without a total gets one when its tasks are refreshed` |

## T-0144 — rework 1: a claimed task that leaves

| id | file | mutation | failing test |
|---|---|---|---|
| T-0144-M7 | packages/dev/src/integrate.ts | a batch did not check that its claimed tasks were still queued before it pushed | `a task that leaves a batch > a claimed task that is cancelled is not merged, and the others land one by one` |
| T-0144-M8 | packages/dev/src/integration-queue.ts | a fallback wrote the claimed task's ticket back with the leader's pid | `a claimed task that leaves the queue > a batch that falls back does not write its ticket back` |

## T-0118 — pre-existing by kind of review

| id | file | mutation | failing test |
|---|---|---|---|
| T-0118-M1 | packages/dev/src/rework.ts | a same-commit reverify applied the line rules (the kind check for `reverify` removed) | `pre-existing by kind of review > reverify: far, in a touched file` and `dev/review rework rounds > what moves as pre-existing, by kind of review > same-commit reverify` |

## T-0119 — review settings by round

| id | file | mutation | failing test |
|---|---|---|---|
| T-0119-M1 | packages/dev/src/rework.ts | a rework round or reverify also read the `first` block (the `kind === "first"` guard removed) | `review settings by round > only a first review reads the first block, value by value` and `dev/review rework rounds > settings by round > the first review reads the first block; a rework round and a same-commit reverify read the default block` |
| T-0119-M2 | packages/dev/src/gate.ts | the harness call kept the reviewer's `timeoutSecs` instead of the round's | `dev/review rework rounds > settings by round > the first review reads the first block; a rework round and a same-commit reverify read the default block` |
| T-0119-M3 | packages/dev/src/rework.ts | `firstArgs` applied only to a round of kind first, so the first review of a later attempt got `args` | `review settings by round > firstArgs still belongs to the first review of every attempt, rework round included` |
| T-0120-M1 | packages/dev/src/followups.ts | a finding was dropped when another task had listed it | `review follow-ups > collects the findings of every round and task, deduplicated, grouped by task, duplicates kept once within a task` |
| T-0120-M2 | packages/dev/src/followups.ts | two findings that differ only in whitespace were both kept | `review follow-ups > collects the findings of every round and task, deduplicated, grouped by task, duplicates kept once within a task` |
| T-0124-M8 | packages/dev/src/views.ts | the metrics total row dropped the quality symbol of the summed attempts | `dev views > the total row marks its weakest quality with a symbol, never a word` |
| T-0120-M3 | packages/dev/src/followups.ts | a leading tag that repeats the level was kept, so the finding was listed twice | `review follow-ups > a leading tag that repeats the level does not make a finding different, and prints once` |
| T-0081-M1 | packages/dev/src/places.ts | verify ignored the home's `checks` setting and used the default | `dev/verify > a checks setting changed with operad settings set is used by the next verify` |
| T-0081-M2 | packages/dev/src/project-settings.ts | review.json's `fixLevel` lost its list of levels, so any text was accepted | `dev settings through operad settings > an invalid review.json level is refused and nothing is written; a valid one needs --yes` |
| T-0123-M1 | packages/dev/src/views.ts | a task row dropped its `after` | `dev views > a task row carries the tasks it waits for, and none when it waits for none` |
| T-0081-M3 | packages/dev/src/project-settings.ts | `gate.commands` lost its items schema, so a list dev would refuse was written | `dev settings through operad settings > a command list dev would refuse is refused and nothing is written` |
| T-0081-M4 | packages/dev/src/commands.ts | `plan add` ignored `autoDefault` and started every plan at off | `dev settings through operad settings > a new plan starts at the auto level the repository sets` |
| T-0114-M1 | packages/dev/src/views.ts | an attempt's time kept the time it waited for a person (`to - from - waited` became `to - from`) | `metrics times come from the run's own facts > cancelled while the task waits for a person: the wait is its own line, up to the cancel` |
| T-0114-M2 | packages/dev/src/views.ts | an attempt's end ignored its run's end fact and ran to now | `metrics times come from the run's own facts > cancelled while a step is in flight: the attempt and the step end at the run's end` |
| T-0112-M1 | packages/dev/src/actions.ts | dev:confirm on a task ignored its plan and was offered while the plan is a draft | `the table agrees with what each action does > a task action is offered, settled or refused exactly as its line says` |
| T-0112-M2 | packages/dev/src/refusals.ts | merge on a merged task became a refusal instead of "already merged; nothing to do" | `the table agrees with what each action does > the results that are already true, each in its own words` |
| T-0112-M3 | packages/dev/src/actions.ts | dev:concurrency set to the value already set was not recognised | `the table agrees with what each action does > a value a plan already has is settled, and another value is not` |
| T-0112-M4 | packages/dev/src/model.ts | a refusal put its field name in front of the line again | `dev actions > the same action name runs on its own object type` |
| T-0112-M5 | packages/dev/src/refusals.ts | a line said "phase", an internal word | `the table of refusal lines > every line is one plain sentence with no internal word and no trailing ';'` |
| T-0112-M6 | packages/dev/src/service.ts | confirming a task skipped the plan check, so a draft plan's task was confirmed | `dev actions > the same action name runs on its own object type` |
| T-0112-M14 | packages/dev/src/actions.ts | dev:confirm was offered on a draft plan with no tasks | `the table agrees with what each action does > a draft plan with no task is not offered confirm, and says when it works` |
| T-0112-M15 | packages/dev/src/service.ts | a claim that lost a race to a cancel or merge gave no line for where the task is | `dev:rework and dev:reverify > a claim on a task that left the wait says where it is, in the table's words` |
| T-0112-M16 | packages/dev/src/service.ts | a merge that lost the race to another merge failed instead of succeeding with "already merged; nothing to do" | `dev:rework and dev:reverify > a merge that loses the race to another merge succeeds with the already-merged line` |
| T-0142-M1 | packages/dev/src/flaky.ts | the file came from the last `(fail)` line and the summary was not skipped, so bun's repeat after a third file's header named that file | `a flaky test proposes a task > two files' failures repeated in bun's summary after a third file's header each get their own file, area and command` |
| T-0142-M2 | packages/dev/src/flaky.ts | a finished `check.flakyPlan` was still used instead of the flaky-tests plan | `a flaky test proposes a task > a finished or cancelled flakyPlan, or one that does not exist, falls back to flaky-tests, made once` |
| T-0142-M3 | packages/dev/src/flaky.ts | the search of the test files by name was dropped, so a file the log did not give stayed unknown | `a flaky test proposes a task > a test whose file the log does not give is found by name in the test files, else the file is unknown` |

## T-0151 — review-after-arc follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0151-M1 | packages/dev/src/followups.ts | a repeated finding kept its oldest copy instead of the newest | `review follow-ups > collects the findings of every round and task, deduplicated, grouped by task, duplicates kept once within a task` |
| T-0151-M2 | packages/dev/src/rework.ts | an argument list from `firstArgs` was recorded as coming from `first` | `review settings by round > firstArgs still belongs to the first review of every attempt, rework round included` |
| T-0114-M4 | packages/dev/src/views.ts | a group of the run with no recorded attempt was dropped (the pending attempt was never made) | `metrics times come from the run's own facts > a rework whose worktree is still being prepared: the next attempt is already running it` |
| T-0150-M1 | packages/dev/src/integration-queue.ts | `turn()` checked the abort signal before it read a leader's result | `a claimed task aborted after the leader's push > reports the merge that is on main, not a cancel` |

## T-0151 — rework 1

| id | file | mutation | failing test |
|---|---|---|---|
| T-0151-M3 | packages/dev/src/gate.ts | a review whose followed commit is missing was given the settings of a first review (the `rework` mapping removed) | `dev/review rework rounds > settings by round > a review whose followed commit is missing from the checkout is a later review for its settings` |
| T-0151-M4 | packages/dev/src/gate.ts | a report from the fallback was recorded with the primary's harness and arguments (the fallback block switched off) | `dev/review fallback and retry > a 429 falls back once, and the round passes without a rework` |

## T-0159 — scheduling by turns

| id | file | mutation | failing test |
|---|---|---|---|
| T-0159-M1 | packages/dev/src/schedule.ts | the last free slot followed priority like the others (the oldest-plan order switched off) | `dev scheduling > the last free slot goes to the plan that waited longest, whatever its priority` |
| T-0159-M2 | packages/dev/src/schedule.ts | plans of one priority ignored who started last (the turn tie-break removed) | `dev scheduling > plans of one priority take turns` |
| T-0159-M3 | packages/dev/src/schedule.ts | the area queue counted no task ahead (`aheadOf` returned 0) | `dev scheduling > a waiting task counts the tasks ahead of it in its area` |

## T-0158 — a merge wait at auto merge is marked as answered automatically

| id | file | mutation | failing test |
|---|---|---|---|
| T-0158-M4 | packages/dev/src/schedule.ts | the mark did not require the plan to be at auto merge | `dev scheduling > a merge wait is marked as answered automatically only at auto merge` |
| T-0158-M5 | packages/dev/src/schedule.ts | a refused integrate still counted as a wait the scheduler answers | `dev scheduling > auto merge answers a passed review once and never answers other waits`, `dev scheduling > a merge wait is marked as answered automatically only at auto merge` |

## T-0163 — flaky review hardening tests

| id | file | mutation | failing test |
|---|---|---|---|
| T-0156-M1 | packages/dev/src/steps.ts | a paused task still let the step that was running write the task (the claim check ignored `paused`) | `dev:pause and dev:resume > pause stops the running step, keeps the branch and commits, and frees the slot` |
| T-0156-M2 | packages/dev/src/schedule.ts | a paused dependency was treated as cancelled, so its dependent went into a person wait | `dev:pause and dev:resume > a paused ready task is not started, and its dependent stays queued` |
| T-0156-M3 | packages/dev/src/service.ts | resume left the task paused instead of making it ready | `dev:pause and dev:resume > resume makes the task ready and the next run continues on its branch` |
| T-0156-M4 | packages/dev/src/service.ts | task update never released a task waiting on a cancelled dependency | `dev:pause and dev:resume > task update --after releases a task waiting on a cancelled dependency` |
| T-0156-M5 | packages/dev/src/service.ts | pause did not ask the kernel to cancel the task's run | `dev:pause and dev:resume > pause stops the running step, keeps the branch and commits, and frees the slot` |
| T-0156-M6 | packages/dev/src/service.ts | pause dropped the task's attempt record | `dev:pause and dev:resume > pause stops the running step, keeps the branch and commits, and frees the slot` |

## T-0162 — repository row mark

| id | file | mutation | failing test |
|---|---|---|---|
| T-0162-M1 | packages/dev/src/service.ts | the repository refresh ignored a change in the running-task count (the `activeTasks` comparison replaced by `true`) | `the repo type > the row mark follows the repository's work > a task starting and ending its run changes the mark` |

## T-0157 — review failed twice in a row

| id | file | mutation | failing test |
|---|---|---|---|
| T-0157-M1 | packages/dev/src/gate.ts | a verify failure kept the previous review failure (`reviewFailed` set for every source) | `dev/rework after two review failures in a row > review fail, verify fail, review fail reworks again` |

## T-0164 — integrate and cleanup run again after a kill

| id | file | mutation | failing test |
|---|---|---|---|
| T-0164-M1 | packages/dev/src/integrate.ts | the rerun after the merge was recorded added its "merged as" lines again (the `previous.result === "merged"` check replaced by `false`) | `dev/integrate rerun after a kill > merge: a kill at merged-saved, then a rerun, merges once` |
| T-0164-M2 | packages/dev/src/settings.ts | the default hook that removes the gate worktree ran without checking the worktree exists | `dev/cleanup rerun after a kill > a kill after hook 2, then a rerun, leaves nothing behind` |

## T-0163 — rework 1

| id | file | mutation | failing test |
|---|---|---|---|
| T-0163-M2 | packages/dev/test/gate.test.ts | the hook remover deleted a hook it had not installed (identity check replaced by `true`) | `review test hooks > a test that ends late removes only the hooks it installed` |
| T-0163-M3 | packages/dev/test/gate.test.ts | the out-of-time test's clock moved on a call its own reviewer did not make (own-call check removed) | `dev/review hardening > runs that cannot fit in the step deadline are skipped and a person decides` |

## T-0159 — rework 1

| id | file | mutation | failing test |
|---|---|---|---|
| T-0159-M4 | packages/dev/src/schedule.ts | every refill of the last free slot went by turn (the check for a running oldest-plan-slot task removed) | `dev scheduling > once the repository is full, a freed slot goes by priority; only the reserved slot goes by turn` |
| T-0170-M1 | packages/dev/src/actions.ts | the old action name `hold` was still declared next to `pause` | `dev:pause and dev:resume > dev:hold and dev:release are no longer actions` |

## T-0164 rework 1 — a batch leader killed after the push

| id | file | mutation | failing test |
|---|---|---|---|
| T-0164-M3 | packages/dev/src/integrate.ts | a task whose merge a dead leader already landed was not looked up on main (`alreadyOnMain` result ignored), so it merged its commit again and reported someone else's sha | `a batch leader killed after the push > the leader and the tasks queued behind it each end merged once, on a fast-forwarded main clone` |
| T-0164-M4 | packages/dev/src/integrate.ts | the leader's replay dropped the "integrated in a batch with" line (`previousBatch.length === 0` replaced by `true`) | `a batch leader killed after the push > the leader and the tasks queued behind it each end merged once, on a fast-forwarded main clone` |

## T-0173 — TUI follow-ups 2

| id | file | mutation | failing test |
|---|---|---|---|
| T-0173-M1 | packages/dev/src/service.ts | the one-time pass left a repository without `activeTasks` uncounted (the `undefined` check replaced by `false`) | `the repo type > a repository stored without a running-task count shows running for a task already running` |

## T-0181 — MUTATIONS.md merges as a union

| id | file | mutation | failing test |
|---|---|---|---|
| T-0181-M1 | .gitattributes | the `merge=union` lines emptied out | `dev/integrate > two branches that each append a row to a MUTATIONS.md table merge, keeping both rows` |
## T-0164 rework 3 — the batch result is left before the push

| id | file | mutation | failing test |
|---|---|---|---|
| T-0164-M5 | packages/dev/src/integrate.ts | the candidate-with-main's-tree guard never fired (condition replaced by `false`) | `a candidate with nothing left to merge > merge: a change already on main under another message is already on main, not merged again` (and the squash one) |
| T-0164-M6 | packages/dev/src/integrate.ts, packages/dev/src/integration-queue.ts | a dead leader's pending result was never taken as landed and the subject lookup was off (`landed` returns `false`, `alreadyOnMain` ignored) | `a batch leader killed after the push > merge: the leader and the tasks queued behind it each end merged once, on a fast-forwarded main clone` (and the squash one) |
| T-0175-M2 | packages/dev/src/commands.ts | a task edit with an empty command input opened the editor instead of refusing | `operad mcp > task edit takes the new brief as command input and refuses an empty one` (packages/mcp/test/server.test.ts; the run hangs on the editor and times out) |

## T-0116 — main action order

| id | file | mutation | failing test |
|---|---|---|---|
| T-0116-M1 | packages/dev/src/actions.ts | `merge` ranked first in every waiting state (the ready-to-merge check removed) | `the order of the actions > a waiting for a rework answer task offers dev:rework first` |
| T-0116-M2 | packages/engine/src/views/presentation.ts | the views listed actions in plugin order (the sort by rank removed) | `the order of the actions > the views list a confirmed plan's actions in the same order, auto first` (packages/dev/test/action-order.test.ts) |
## T-0176 — repository throughput

| id | file | mutation | failing test |
|---|---|---|---|
| T-0176-M1 | packages/dev/src/throughput.ts | the percentile took the floor of the rank instead of the ceiling | `repository metrics > percentiles use the nearest rank` |
| T-0176-M2 | packages/dev/src/throughput.ts | the time waiting for a turn was not taken out of the integrate time | `repository metrics > counts per hour and per day, cost per merge, and step times` |
| T-0176-M3 | packages/dev/src/throughput.ts | a task merged before the window but written again inside it was counted | `repository metrics > counts per hour and per day, cost per merge, and step times` |
| T-0176-M4 | packages/dev/src/throughput.ts | every write of a waiting task counted as a new stop (the check for an already waiting task removed) | `repository metrics > counts per hour and per day, cost per merge, and step times` |
| T-0176-M5 | packages/dev/src/throughput.ts | the last-24-hours count began 23 hours back instead of 24 | `repository metrics > counts per hour and per day, cost per merge, and step times` |
| T-0176-M6 | packages/dev/src/throughput.ts | the cost per merge used the task's last cost and not the sum of its attempts | `repository metrics > a reworked task costs every attempt, and a stop keeps the reason dev recorded` |
| T-0176-M7 | packages/dev/src/throughput.ts | a spent retry was reported as `retry` instead of its recorded cause | `repository metrics > a reworked task costs every attempt, and a stop keeps the reason dev recorded` |
| T-0176-M8 | packages/dev/src/throughput.ts | the hourly buckets went back to including their start and not their end, so a merge at `now` was in the summary and in no row | `repository metrics > the last-24-hours count is the sum of the hourly rows at both ends of the window` |
## T-0194 — `--after` across plans and repositories

| id | file | mutation | failing test |
|---|---|---|---|
| T-0194-M1 | packages/dev/src/schedule.ts | the dependency lookup was limited to the repository's own tasks | `--after across plans and repositories > a task of another repository blocks until it merges and the note names the repository` |
| T-0194-M2 | packages/dev/src/service.ts | the cycle walk ignored the tasks of other repositories | `--after across plans and repositories > a task cannot follow itself or close a cycle; an unknown task is refused` |

## T-0060 — the dev flow compiler

| id | file | mutation | failing test |
|---|---|---|---|
| T-0060-M1 | packages/dev/src/flow-compiler.ts | a failed stage returned to the first work entry instead of the nearest work stage before it | `a failed review returns to the nearest work stage before it` |
| T-0060-M2 | packages/dev/src/settings.ts | removed the rule that a flow's last stage is human | `both hard rules refuse the flow by name` |

## T-0201 — rerun reads only this command's log

| id | file | mutation | failing test |
|---|---|---|---|
| T-0201-M1 | packages/dev/src/rerun.ts | read the failed names from byte 0 instead of the command's `logStart` (also T-0206-M3) | `dev/verify reruns only the failed tests > an earlier attempt's names in the run log do not stop this attempt's rerun` |

## T-0177

| id | file | mutation | failing test |
|---|---|---|---|
| T-0177-M1 | packages/dev/src/standing.ts | only a proposed task with an `openedBy` was a pending item | `a proposed task is pending > a task added by \`task add\` is pending with confirm and cancel, drawn waiting, and leaves on confirm` |
| T-0177-M2 | packages/dev/src/marks.ts | a confirmed plan never read `waitingCount` (threshold raised to 99) | `a proposed task is pending > a task waiting at a stop also turns the plan row waiting` |
| T-0177-M3 | packages/dev/src/service.ts | `confirmTask` did not refresh the plan's counts | `a proposed task is pending > a task added by \`task add\` is pending with confirm and cancel, drawn waiting, and leaves on confirm` |

## T-0177 — rework 2

| id | file | mutation | failing test |
|---|---|---|---|
| T-0177-M5 | packages/dev/src/standing.ts | a draft plan's proposed tasks were listed as task items again (draft grouping skipped) | `a proposed task is pending > a draft plan keeps its own mark and note` |

## T-0206 — the check log and the worker log read only their tails

| id | file | mutation | failing test |
|---|---|---|---|
| T-0206-M4 | packages/dev/src/views.ts | started the worker-log tail at the end of the file, so the log section was empty | `dev views > the log section is the tail of the current attempt's worker log` |

## T-0110 — a git query that exits 0 with no output is asked again

| id | file | mutation | failing test |
|---|---|---|---|
| T-0110-M1 | packages/dev/src/service.ts | `gitPrinting` stopped rerunning a git query that exited 0 with no output | `git that succeeds without printing > repo add runs a query again when git exits 0 and prints nothing` |
| T-0110-M2 | packages/dev/src/service.ts | `addRepository` dropped git's stderr from the "not a git work tree" refusal | `repo add reports git's stderr > a failing rev-parse puts its stderr in the refusal` |

## T-0147 — git that exits 0 and prints nothing is run again

| id | file | mutation | failing test |
|---|---|---|---|
| T-0147-M1 | packages/dev/src/git.ts | the empty-output rerun loop never ran (`attempt < 1`) | `git that exits 0 and prints nothing > headOf returns the commit after empty answers` (also the `dev/work` no-worktree test and the two `repo add` tests) |
| T-0147-M2 | packages/dev/src/git.ts | every command was treated as one that must print (`printsOnSuccess` returned true) | `git that exits 0 and prints nothing > a query allowed to print nothing is run once` |
| T-0147-M3 | packages/dev/src/git.ts | the rerun bound was one too many (`attempt <= GIT_EMPTY_ATTEMPTS`) | `git that exits 0 and prints nothing > a query that never prints fails with git's words and says it was empty` |

## T-0210 — follow-ups from the flow-stops reviews

| id | file | mutation | failing test |
|---|---|---|---|
| T-0210-M1 | packages/dev/src/steps.ts | a step of a paused and resumed run could still write the ready task (the no-claim check allowed it) | `dev:pause and dev:resume > a step of the paused run cannot write the task after it was resumed` |
| T-0210-M2 | packages/dev/src/followups.ts | `paused` was not an open phase, so follow-ups were proposed while a task was paused | `review follow-ups > nothing is proposed while a task is open` |
| T-0210-M3 | packages/dev/src/steps.ts | a merge conflict met by the worktree step kept the review-failed count | `dev/worktree > a conflict with main resets the review-failed count; a clean merge keeps it` |
| T-0210-M4 | packages/dev/src/schedule.ts | a merge wait stayed marked as answered automatically when the repository's settings are invalid | `dev scheduling > a merge wait is marked as answered automatically only at auto merge` |
| T-0210-M5 | packages/dev/src/schedule.ts | a task that left running kept the mark of the reserved slot | `dev scheduling > a task that waits gives up the reserved slot, so a resumed task does not hold it twice` |
| T-0210-M6 | packages/dev/src/model.ts | a task stored with the old phase `held` was not read as paused | `dev:pause and dev:resume > a task stored with the old phase held reads as paused and can be resumed` |
| T-0210-M10 | packages/dev/src/service.ts | the release in task update did not refresh the plan's cached counts | `dev:pause and dev:resume > task update --after releases a task waiting on a cancelled dependency` |
| T-0210-M12 | packages/dev/src/service.ts | the plan start was written from the plan read before the repository lock, losing a change made while it waited | `dev scheduling > recording a plan start keeps a plan change made while it waits for the lock` |
| T-0210-M13 | packages/dev/src/schedule.ts | the area queue always followed the turn order, ignoring the kept slot's order | `dev scheduling > the tasks ahead follow the order of the kept slot when it is the next start` |
| T-0194-M3 | packages/dev/src/service.ts | a cross-repository `--after` change took only its own repository's lock | `--after validation under races and removed repositories > two cross-repository updates at once cannot close a cycle` (a race; it failed in 3 of 3 runs) |
| T-0194-M4 | packages/dev/src/service.ts | a dependency's repository was no longer required to be registered | `--after validation under races and removed repositories > a task of a removed repository cannot be named` |
| T-0188-M9 | packages/dev/src/chat.ts | the worktree step moved the chat's directory again when it already had a worktree (both already-moved checks removed) | `dev/chat_worktree > opens work/chat-<id>, moves the working directory there once, and it is writable there` |
| T-0188-M10 | packages/dev/src/chat.ts | dev:chat made the chat writable in the main clone | `dev:chat > creates a chat under the repository, in the main clone, read-only` |

## T-0060 — rework 3: named flows, beforeAttempt, the human rule

| id | file | mutation | failing test |
|---|---|---|---|
| T-0060-M4 | packages/dev/src/schedule.ts | every task started the repository's `default` flow, ignoring its plan's `flow` | `a plan's flow selects a named repository flow` |
| T-0060-M5 | packages/dev/src/steps.ts | `beforeAttempt: "merge-main"` did nothing before the worker ran | `dev/work > beforeAttempt merge-main merges the latest main; none leaves it alone` |
| T-0060-M6 | packages/dev/src/settings.ts | required a flow's last user stage to be human again | `a flow with no human stage is valid and ends at integrate` |

## T-0060 — rework 6: a non-final human stage is valid

| id | file | mutation | failing test |
|---|---|---|---|
| T-0060-M7 | packages/dev/src/settings.ts | restored the removed rule that a flow's last user stage must be human, so a non-final human stage was refused | `[human, check] loads and compiles human -> check -> integrate` |
| T-0131-M1 | packages/dev/src/gate.ts | used the flat `retrySecs` for every wait instead of `reviewWaitMs` | `dev/review hardening > each further wait of an unavailable model doubles` |
| T-0131-M2 | packages/dev/src/timeouts.ts | removed the 30-minute cap in `reviewWaitMs` | `review waits > double from retrySecs and stop at the cap` |
| T-0131-M3 | packages/dev/src/timeouts.ts | set `MAX_REVIEW_WAITS` back to 36 | `review waits > the give-up point is about the time it was (about 90 minutes at the default)` |

## T-0228 — a resumed branch with unchecked work goes on to verify

| id | file | mutation | failing test |
|---|---|---|---|
| T-0228-M1 | packages/dev/src/steps.ts | work that added no commit always ended `nothing`, even on a branch with unchecked commits | `work that ends with no new commit > a branch with unchecked work goes on to verify, and says why` |
## T-0227 — a cancelled task ends its run

| id | file | mutation | failing test |
|---|---|---|---|
| T-0227-M1 | packages/dev/src/schedule.ts | the tick did not end a run still active on a cancelled task | `a run still active on a cancelled task is ended by the tick` |
| T-0227-M3 | packages/dev/src/service.ts | cancel did not pass the task's stored flow graph to the run control | `cancelling a task through MCP ends a run of the flow the task stored` |
## T-0061 — choosing a flow

| id | file | mutation | failing test |
|---|---|---|---|
| T-0061-M1 | packages/dev/src/service.ts | `task update --flow` was allowed after the task's first attempt | `a flow changes only before the first attempt` |
| T-0061-M2 | packages/dev/src/schedule.ts | every task started the repository's `default` flow, ignoring its own and its plan's `--flow` | `a task takes its own flow, then its plan's, then default` |
| T-0061-M3 | packages/dev/src/schedule.ts | a ready task with an undefined flow was given no reason on its row and its plan's row | `an undefined flow does not start, and the rows say why` |
| T-0061-M4 | packages/dev/src/schedule.ts | rows named the flow even when the repository defines only the default one | `rows and the brief name the flow only when the repository defines more than one` |
| T-0061-M5 | packages/dev/src/schedule.ts | the flow label was not kept for a cancelled task, so its row and Brief named no flow | `a task cancelled before any tick still names its flow` |

## T-0062 — stage settings and TS flows

| id | file | mutation | failing test |
|---|---|---|---|
| T-0062-M1 | packages/dev/src/gate.ts | a review stage's `later` args were never used | `dev/review > stage parameters > a review stage's later args are used from the second round, and only then` |
| T-0062-M2 | packages/dev/src/gate.ts | a check stage's `rerun` was ignored and `check.rerun` always used | `dev/review > stage parameters > a check stage's rerun overrides check.rerun and falls back without it` |
| T-0062-M3 | packages/dev/src/steps.ts | a work stage's `brief` was not appended to the worker's prompt | `dev/work > a work stage's brief ends the prompt; a stage without one adds nothing` |
| T-0062-M4 | packages/dev/src/gate.ts | a review stage's `grading` was ignored and the flow's own entry always read | `dev/review > stage parameters > a review stage's grading names the review.json entry; without it the flow's own is read` |
| T-0062-M5 | packages/dev/src/project-flows.ts | a name defined in dev.json and as a TS file was accepted | `a name defined in dev.json and as a TS file is refused, and plan add says so` |
| T-0062-M6 | packages/dev/src/project-flows.ts | a step other than integrate could lead to the end of a TS flow | `a TS flow that leads to the end from another step than integrate is refused` |
| T-0062-M7 | packages/dev/src/schedule.ts | the scheduler did not declare the repository's TS flows | `a ready task of a plan that names a TS flow starts it` |
| T-0062-M8 | packages/dev/src/commands.ts | `--flow default` returned before the refusal of a clashing TS default flow was read | `--flow default is refused when a TS default flow clashes with dev.json` |
| T-0062-M9 | packages/dev/src/project-flows.ts | a TS flow's review step got no grading of the flow's name | `a TS flow's review step reads the grading of the flow's name unless it names one` |
## T-0224 — a result that is not the code goes to the machine's load, not to the worker

| id | file | mutation | failing test |
|---|---|---|---|
| T-0224-M1 | packages/dev/src/notcode.ts | a result counted as a test timeout when only one failed test (not every one) reached the timeout | `classifyCheck > one failed test that was quick: the code` |
| T-0224-M2 | packages/dev/src/gate.ts | verify never told the flaky-test count that the machine was busy, so passes under load counted toward a task | `a test that passes on rerun under load is recorded and proposes no task` |
| T-0224-M3 | packages/dev/src/steps.ts | a work step that ended on a dropped model connection was recorded as an ordinary harness failure | `a dropped model connection is retried once by dev/retry, not sent to a person` |
| T-0224-M4 | packages/dev/src/integrate.ts | an integration check that was not the code twice was sent back to work as a rework | `an integration check killed by a signal twice waits for a person, not for the worker` |
| T-0224-M5 | packages/dev/src/notcode.ts | let the wait for a quiet machine end while the load was still high | `runCheckSteadily > a second timeout goes to a person, after the load stayed high past an hour` |
| T-0224-M6 | packages/dev/src/integrate.ts | a batch check that was not the code twice fell back to the one-by-one path instead of waiting for a person | `dev/integrate > a batch check that is not the code twice waits for a person and does not fall back` |
| T-0188-M18 | packages/dev/src/chat.ts | `dev:chat` accepted a harness that is not loaded | `dev:chat > the harness must be loaded: one that is not is refused and the loaded ones are named` |
| T-0188-M19 | packages/dev/src/chat.ts | the chat profile did not deny the `operad` command | `dev:chat > the profile keeps the agent out of the operad command` |
| T-0188-M28 | packages/dev/src/chat.ts | `dev:chat` no longer refused harness-radian by name | `dev:chat > harness-radian is refused with the reason, whether given or the only one loaded` |
| T-0152-M1 | packages/dev/src/service.ts | `recordMergeReported` stopped checking the mark under the lock, so every caller claimed it | `a scheduler line prints once > the merge mark goes to one claimant, as when another process races a pass` |
| T-0152-M2 | packages/dev/src/service.ts | `recordPlanFinishedReported` stopped checking the mark under the lock | `a scheduler line prints once > the finished mark goes to one claimant` |
| T-0152-M3 | packages/dev/src/schedule.ts | `runScheduler` ran every asked pass at once instead of one after another | `a scheduler line prints once > a pass asked for while one runs runs once after it, never beside it` |

## T-0216 — a rework's wait for its worker is shown

| id | file | mutation | failing test |
|---|---|---|---|
| T-0216-M2 | packages/dev/src/marks.ts | a task waiting for its worker kept the `running` mark | `dev/work with workers > a rework whose worker is busy shows the wait and the holding task until it is released` |
| T-0250-M2 | packages/dev/src/service.ts | `refreshPlanCounts` rethrew SQLITE_BUSY after the task was already written | `a task that was written is not reported as failed when the plan counts hit a busy store` |
| T-0250-M5 | packages/dev/src/service.ts | `writePlan` rethrew SQLITE_BUSY from the repository-count refresh after the plan was written | `a plan that was confirmed is not reported as failed when the repository counts hit a busy store` |

## T-0260 — a verify and a review run on the worker's last commit

| id | file | mutation | failing test |
|---|---|---|---|
| T-0260-M1 | packages/dev/src/steps.ts | the work step kept the earlier verify result when the worker had committed past the verified commit | `work that ends with no new commit > a commit the worker makes last is verified, not answered by the verify of the commit before it` |
## T-0240 — the Log section is readable

| id | file | mutation | failing test |
|---|---|---|---|
| T-0240-M1 | packages/dev/src/views.ts | a leading `cd <worktree>` was kept in a shown command | `dev views > a leading cd into the task's worktree is dropped, and its paths are relative; other cd targets stay` |
| T-0240-M2 | packages/dev/src/views.ts | the worktree path inside a command stayed absolute | `dev views > a leading cd into the task's worktree is dropped, and its paths are relative; other cd targets stay` |
| T-0240-M3 | packages/dev/src/views.ts | a multi-line command lost its `(+N lines)` count | `dev views > a multi-line command shows its first line and the count of lines left; a long one-liner is cut` |
| T-0240-M4 | packages/dev/src/views.ts | a long one-line command was not cut at 160 characters | `dev views > a multi-line command shows its first line and the count of lines left; a long one-liner is cut` |
| T-0240-M5 | packages/dev/src/views.ts | the command was not set in inline code | `dev views > a tool call is one line with what ran and how long it took` |
| T-0240-M6 | packages/dev/src/views.ts | a turn end without agent text was shown | `dev views > a run of tool turns shows no turn end; a turn end after the agent's text and the result stay` |

## T-0240 — rework: multi-line log commands and code spans

| id | file | mutation | failing test |
|---|---|---|---|
| T-0240-M13 | packages/dev/src/views.ts | blank lines of a command were not counted in the lines left | `dev views > a multi-line command shows its first line and the count of lines left; a long one-liner is cut` |
## T-0246 — a cancelled task's run ends when the settings cannot be read

| id | file | mutation | failing test |
|---|---|---|---|
| T-0246-M1 | packages/dev/src/schedule.ts | the sweep of cancelled tasks' runs ran after the settings were read, so unreadable settings skipped it | `a run on a cancelled task is ended even when the repository's settings cannot be read` |
| T-0122-M2 | packages/dev/src/views.ts | a plan listed a Tasks section again | `dev views > a plan loads its request and has no tasks section` |
| T-0260-M2 | packages/dev/src/gate.ts | review accepted a report whose sha was not the checked commit | `dev/review > a report whose sha is not the checked commit is refused` |

## T-0240 — rework 10: turn ends and blank command lines

| id | file | mutation | failing test |
|---|---|---|---|
| T-0240-M14 | packages/dev/src/views.ts | a turn end with stop reason `tool_use` was shown when the agent had text | `dev views > the agent's text, a tool error's first line and a turn's end are shown; tool output is not` |
| T-0240-M15 | packages/dev/src/views.ts | leading and trailing blank lines of a command were trimmed away before the count | `dev views > a multi-line command shows its first line and the count of lines left; a long one-liner is cut` |
| T-0240-M17 | packages/dev/src/views.ts | the cd prefix pattern matched across line breaks (`\s*`), eating a blank line after it | `dev views > a multi-line command shows its first line and the count of lines left; a long one-liner is cut` |
| T-0239-M3 | packages/dev/src/marks.ts | a task whose step waits for a check place kept the `checking` mark | `dev views > a task whose check waits for a place says so, with how many are ahead, until it takes the place` |
| T-0239-M4 | packages/dev/src/places.ts | a check that took its place did not end its report to the kernel before the command started | `check places > a waiting check tells the kernel and the task its place group until it takes the place` |
| T-0239-M8 | packages/dev/src/place-wait.ts | counting the waiters and saving the wait record was not one locked turn, so two checks reaching a held place together both showed 0 ahead | `dev views > a task whose check waits for a place says so, with how many are ahead, until it takes the place` |
| T-0260-M3 | packages/dev/src/gate.ts | review accepted a report that named no commit | `dev/review > a report that names no commit is refused` |

## T-0174 — a failed test seen under load opens no flaky task

| id | file | mutation | failing test |
|---|---|---|---|
| T-0174-M1 | packages/dev/src/flaky.ts | `busyLoad` ignored the start reading and looked only at the end | `a flaky test proposes a task > a failure seen above the load limit opens no task and says it was skipped` |
| T-0174-M2 | packages/dev/src/flaky.ts | the default limit was the core count instead of twice it | `a flaky test proposes a task > a failure below the load limit opens the flaky task as before` |
| T-0174-M3 | packages/dev/src/settings.ts | `check.flakyLoadLimit` was accepted but not read from the settings | `a flaky test proposes a task > check.flakyLoadLimit is read and validated` |
| T-0174-M4 | packages/dev/src/notcode.ts | the end reading was the start reading, so a check that ended quiet looked busy | `runCheckSteadily records the load > the start and the end of the command, each as it was read` |
| T-0174-M5 | packages/dev/src/flaky.ts | the skipped failure was left out of the check's own log | `dev/verify tells a result that is not the code from one that is > a test that passes on rerun under load is recorded and proposes no task` |
## T-0116 — rework 2

| id | file | mutation | failing test |
|---|---|---|---|
| T-0116-M3 | packages/tui/src/actions.ts | the main action was the first action again (the skip of ending actions removed) | `the main key skips an action that ends the object, and says none is available when only it is left` (packages/tui/test/actions.test.ts) |

## T-0288 — a stopped run's task waits

| id | file | mutation | failing test |
|---|---|---|---|
| T-0288-M1 | packages/dev/src/announce.ts | the announce step no longer marked a running or review task waiting | `dev.waiting > a task still in review says it waits once its wait is announced` (packages/dev/test/waiting.test.ts) |
| T-0288-M2 | packages/dev/src/retry.ts | a recovered run that gave up kept the phase it had | `a spent retry hands the task to a person > a recovered run that gives up says waiting, not the phase it had` (packages/dev/test/retry.test.ts) |
| T-0288-M3 | packages/dev/src/schedule.ts | a review task whose run waited for a person was left in review | `a task in review follows its run > a run waiting for a person makes it waiting` (packages/dev/test/schedule.test.ts) |
| T-0288-M4 | packages/dev/src/service.ts | reopening a task refused a review task whose run ended | `a task in review follows its run > a run that ended is repaired like a running task's` (packages/dev/test/schedule.test.ts) |
| T-0288-M5 | packages/dev/src/service.ts | releasing a claim refused a review task with no run | `a task in review follows its run > with no run at all it goes back to ready` (packages/dev/test/schedule.test.ts) |
## T-0292 — check-load follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0292-M1 | packages/dev/src/mainclone.ts | a rerun that finds the sha already in HEAD never compared the lock marker, so it skipped the missed install (the marker check replaced by `false`) | `a kill between the fast-forward and the install is repaired by the rerun` (packages/dev/test/mainclone.test.ts) |

## T-0130 — the actions a waiting task offers

| id | file | mutation | failing test |
|---|---|---|---|
| T-0130-M1 | packages/dev/src/actions.ts | `dev:reverify` was offered on every waiting task instead of only on a wait that takes it | `the actions a waiting task offers > the default flow: a task offers exactly the actions its wait takes` |
| T-0130-M2 | packages/dev/src/flow-compiler.ts | `wait_review_unavailable` took `reverify` in its choices but had no edge for it | `reverify from wait_review_unavailable > runs the reverify step, then verify, then review` |
| T-0130-M3 | packages/dev/src/refusals.ts | an action the current wait did not take got no line, so the action ran and answered the wait | `an action the current wait does not take > is refused in the task's words, naming what it can do, with no run id` |
| T-0130-M4 | packages/dev/src/waits.ts | the wait a task records was ignored, so an ordinary wait after a timed-out review was named by the older review record | `an action the current wait does not take > a generic wait after a stopped timed-out review takes reverify too` |
## T-0294 — the flaky-task gate test reads an injected quiet load

| id | file | mutation | failing test |
|---|---|---|---|
| T-0294-M1 | packages/dev/test/gate.test.ts | the injected load was a busy one (18 on 10 cores) again, so the rerun passes never counted | `dev/verify reruns only the failed tests > a test that reaches check.flakyTask is proposed in the flaky-tests plan, with no notice` (packages/dev/test/gate.test.ts) |
| T-0174-M6 | packages/dev/src/flaky.ts | the proposal loop ignored which tests this check saw under load, so an older idle count could still open a task | `a flaky test proposes a task > a failure seen under load opens no task from an earlier idle count` |

## T-0295-check-places-fifo — checks take places in the order they began to wait

| id | file | mutation | failing test |
|---|---|---|---|
| T-0295-M1 | packages/dev/src/places.ts | a check took a free place even when an earlier check still waited | `check places are served in the order checks began to wait > a, b, c take places in the order they began to wait, even when c looks first` |
| T-0295-M2 | packages/dev/src/place-order.ts | an entry whose process is dead still counted as waiting | `check places are served in the order checks began to wait > a waiter whose process is dead is skipped and its entry removed` |
| T-0295-M3 | packages/dev/src/places.ts | a cancelled check kept its entry until it looked again | `check places are served in the order checks began to wait > a cancelled waiter leaves the order at once` |
| T-0295-M4 | packages/dev/src/places.ts | the ahead count passed to the task's row was always 0 | `check places are served in the order checks began to wait > a, b, c take places in the order they began to wait, even when c looks first` |
| T-0295-M5 | packages/dev/src/places.ts | the repository's pool ignored the order | `check places are served in the order checks began to wait > the repository's own pool follows the order too` |
| T-0295-M6 | packages/dev/src/places.ts | a waiting check reported itself to the kernel without the number of checks ahead of it in the disk order | `check places are served in the order checks began to wait > a waiting check tells the kernel how many are ahead of it in the order` |
## T-0290 — verify checks the branch's current head

| id | file | mutation | failing test |
|---|---|---|---|
| T-0290-M1 | packages/dev/src/gate.ts | the replay of a same-run result no longer compared the recorded commit with the branch head (`attempt.verified === sha` replaced by `true`) | `dev/verify > a commit that lands after a pass in the same run is checked, not replayed (T-0290)` (packages/dev/test/gate.test.ts) |

## T-0297 — follow-ups from the flaky-test work

| id | file | mutation | failing test |
|---|---|---|---|
| T-0297-M1 | packages/dev/src/git.ts | `emptyIsSuccess` no longer accepted an empty `ls-remote` as a real answer | `dev init check > a reachable remote without the main branch is a failed check that writes nothing` |
| T-0297-M2 | packages/dev/src/git.ts | `ls-remote` was no longer treated as a query whose output is expected | `dev init check > an empty answer from the remote query is asked again` |
| T-0297-M3 | packages/dev/src/git.ts | `remote` with no arguments was again treated as a query whose output is expected | `git that exits 0 and prints nothing > a repository with no remote is not asked five times` |
| T-0297-M4 | packages/dev/src/flaky.ts | `noticed` was written but no longer checked before returning a proposal notice | `a flaky test proposes a task > a proposal that keeps failing returns its notice only once for the same count` |
| T-0297-M5 | packages/dev/src/flaky.ts | a missing `check.flakyPlan` fell back to the flaky-tests plan with no notice | `a flaky test proposes a task > check.flakyPlan that names no plan says so and still proposes in flaky-tests` |
| T-0297-M6 | packages/dev/src/flaky.ts | the test-file search descended into `node_modules` again | `a flaky test proposes a task > a test whose file the log does not give is found by name in the test files, else the file is unknown` |
| T-0297-M7 | packages/dev/src/check.ts | the init check used a git runner of its own that did not ask again after an empty success | `dev init check > an empty answer from the remote query is asked again` |
| T-0291-M1 | packages/dev/src/schedule.ts | auto merge answered a human-stage wait whose check had failed | `dev scheduling > auto merge answers the wait of a configured human stage in a flow without review` |
| T-0291-M2 | packages/dev/src/schedule.ts | auto merge answered a wait after a later review had failed, taking it for the human stage | `dev scheduling > auto merge answers a human stage that a later review follows, until that review has run` |

## T-0278 — the repository chat's harness is a choice

| id | file | mutation | failing test |
|---|---|---|---|
| T-0278-M1 | packages/dev/src/chat.ts | the harness argument dropped its `enum`, so a free-text name reached the run's refusal instead of the schema | `dev:chat > a harness outside the choice is refused by the schema before the run` |
| T-0298-M1 | packages/dev/src/service.ts | cancelTask threw on a result that was already true instead of succeeding | `dev plans and tasks > a task added to a confirmed plan waits for its own confirm` |
| T-0298-M2 | packages/dev/src/views.ts | an older run's unrecorded group became a phantom attempt numbered past the later ones | `dev views > a group nobody recorded in an older run is not numbered past a later attempt` |
| T-0298-M3 | packages/dev/src/views.ts | the total row showed `0s` when no attempt's run could be read | `dev views > the total row shows a dash when no attempt's run can be read` |
| T-0298-M4 | packages/dev/src/refusals.ts | confirming a finished plan was refused instead of already true | `a finished plan > is a confirmed plan: confirming it again is already true, not a refusal` |
