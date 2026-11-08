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
| T-0044-M1 | packages/dev/src/views.ts | a long worker name was not cut in the row | `dev views > a task row shows the last attempt's worker, short, and nothing before pools` |
| T-0044-M2 | packages/dev/src/views.ts | an attempt with no worker got a row named "undefined" | `dev views > the metrics section splits cost, time and first pass by worker` |
| T-0044-M3 | packages/dev/src/views.ts | a pass in a later review round counted as first pass | `dev views > the metrics section splits cost, time and first pass by worker` |
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
