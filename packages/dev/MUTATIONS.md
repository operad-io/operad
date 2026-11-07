# Mutation records — `dev`

Rows whose mutation broke code in `packages/dev/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

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
| TK0023-M11 | packages/dev/src/schedule.ts | removed the claim recovery, so a task left running with no run stayed stranded | `dev scheduling > a claim whose start never landed returns to ready and starts again` |
| TK0023-M12 | packages/dev/src/schedule.ts | let the manual-start pass reset both concurrency counters | `dev scheduling > start still respects the repository concurrency` |
| TK0023-M13 | packages/dev/src/schedule.ts | skipped the dependency check for a requested start | `dev scheduling > start still respects a dependency` |
| TK0023-M14 | packages/dev/src/gate.ts | set the early verify failure back to `running` instead of `review` | `dev/verify > a verify with no branch still records the review phase` |
| TK0023-M15 | packages/dev/src/steps.ts | ignored the flow's `blockedBy` parameter, so a cancelled dependency prepared a worktree instead of a person wait | `dev scheduling > a cancelled dependency leaves the dependent task as a person wait` |
| TK0023-M16 | packages/dev/src/schedule.ts | disabled the claim recovery, so the child-process crash test leaves the claimed task stranded | `dev scheduling > a claim whose start never landed returns to ready and starts again` |
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
| T-0046-M1 | packages/dev/src/service.ts | the upper bound of a plan's concurrency was 100 instead of 16 | `dev actions > addPlan takes a concurrency and refuses one out of range` |
| T-0046-M2 | packages/dev/src/service.ts | `setConcurrency` did not refuse a cancelled plan | `dev actions > concurrency is refused on a cancelled plan` |
| T-0046-M3 | packages/dev/src/service.ts | `addPlan` ignored the given concurrency | `operad with the dev plugin > plan add takes --concurrency and dev:concurrency takes --count` |
| T-0046-M4 | packages/dev/src/views.ts | the plan row left out the concurrency | `dev actions > concurrency sets the plan's count and the view shows it` |
| T-0046-M5 | packages/dev/src/service.ts | `setConcurrency` accepted a finished plan | `dev actions > concurrency is refused on a finished plan` |
| T-0046-M6 | packages/dev/src/actions.ts | `dev:concurrency` was available on a finished plan | `dev actions > concurrency is refused on a finished plan` |
