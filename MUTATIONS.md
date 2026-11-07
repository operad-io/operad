# Mutation records

A mutation check breaks the new code once by hand, runs the tests, names the
test that fails, and restores the code. Record each check in the `MUTATIONS.md`
of the package whose code the mutation broke, using this row format:

```
| id | file | mutation | failing test |
|---|---|---|---|
| TK0001-M1 | packages/<name>/src/... | what was broken | `the test that failed` |
```

A row's id is the arc task id followed by `-M` and a number starting at 1 for
each task: `TK0001-M1`.

## Package records

## TK0028 — contract: objects, facts, action args and actor

| id | file | mutation | failing test |
|---|---|---|---|
| TK0028-M1 | packages/engine/src/plugin/paging.ts | made `matchesWhere` accept every object | `object list > filters on an indexed field (jsonl)` |
| TK0028-M2 | packages/engine/src/plugin/file-store.ts | stopped comparing a list cursor`s object type | `object list > refuses a cursor from another object type (jsonl)` |
| TK0028-M3 | packages/engine/src/plugin/action-schema.ts | skipped the enum check in `validateActionArgs` | `operad presentation commands > an enum argument is listed in help and validated` |
| TK0028-M4 | packages/engine/src/kernel/decide.ts | wrote `actor: null` into `person_answered` | `decide: person_answer > records who answered in person_answered` |
| TK0028-M5 | packages/engine/src/plugin/file-store.ts | made `subscribeFacts` ignore its cursor | `object facts > a subscription after a cursor gets only later facts (jsonl)` |
| TK0028-M6 | packages/engine/src/plugin/registry.ts | left the actor out of the action`s fact | `plugin registry > records who asked in the action's fact` |

## TK0028 — rework 2: store lifecycle, cross-connection facts and schema flags

| id | file | mutation | failing test |
|---|---|---|---|
| TK0028-M7 | packages/engine/src/plugin/file-store.ts | made a fact unsubscribe remove only the listener, never stopping the shared watcher | `store lifecycle and concurrency > stops the watcher when the last fact subscription ends` |
| TK0028-M8 | packages/engine/src/plugin/sqlite-store.ts | treated a declared empty index as an undeclared type | `store lifecycle and concurrency > refuses any filter when the type declares an empty index (sqlite)` |
| TK0028-M9 | packages/engine/src/runner/step-worker.ts | opened a JSONL store in the worker instead of the configured backend | `runner > a worker step writes to the configured sqlite store` |
| TK0028-M10 | packages/engine/src/plugin/file-store.ts | removed the append lock and took the next sequence from the stale entry count | `store lifecycle and concurrency > two jsonl writers assign unique, contiguous sequences` |
| TK0028-M11 | packages/engine/src/plugin/sqlite-store.ts | stopped polling for facts another connection committed | `store lifecycle and concurrency > a sqlite subscription sees a fact another connection appended` |
| TK0028-M12 | packages/cli/src/main.ts | restored the id-shaped-value heuristic in the action flag parser | `operad presentation commands > schema flags accept values that look like ids or negative numbers` |
| TK0028-M13 | packages/engine/src/plugin/action-schema.ts | accepted a `role: "note"` property without type `"string"` | `plugin registry validation > rejects a note property that is not a string` |
| TK0028-M14 | packages/engine/src/plugin/registry.ts | left the actor out of the action context | `plugin registry > an action receives the person's actor` |

## TK0029 — contract: plugin declaration, settings, secrets, access and enablement

| id | file | mutation | failing test |
|---|---|---|---|
| TK0029-M1 | packages/engine/src/plugin/settings.ts | stopped filling declared defaults into an absent settings field | `plugin settings > fills declared defaults and gives the step a read-only section` |
| TK0029-M2 | packages/engine/src/plugin/settings.ts | made `deepFreeze` return the value without freezing it | `plugin settings > fills declared defaults and gives the step a read-only section` |
| TK0029-M3 | packages/engine/src/plugin/secrets.ts | wrote the secret file with mode 0644 instead of 0600 | `plugin secrets > set/get round-trips and writes 0600 in a 0700 directory` |
| TK0029-M4 | packages/engine/src/plugin/registry.ts | skipped every `requires` check | `plugin requires > refuses a plugin whose required plugin is missing` |
| TK0029-M5 | packages/engine/src/plugin/registry.ts | accepted every access profile field instead of refusing an unenforced one | `run access profile > refuses a field no step of the flow enforces, naming the field and step` |
| TK0029-M6 | packages/engine/src/plugin/load.ts | loaded a plugin even when its config entry said `enabled: false` | `plugin enable and disable > a disabled plugin is not loaded and its objects return after enable` |
| TK0029-M7 | packages/engine/src/kernel/decide.ts | dropped the access profile from the `run_started` fact | `run access profile > accepts a field one step of the flow enforces and gives it to every step` |

## TK0029 — rework 2: review fixes

| id | file | mutation | failing test |
|---|---|---|---|
| TK0029-M8 | packages/cli/src/main.ts | imported a disabled plugin while listing plugins | `operad command > plugin list does not import a disabled plugin` |
| TK0029-M9 | packages/engine/src/log/sqlite.ts | left a schema_version 1 store refused instead of adding `runs.access` | `opens a schema_version 1 store and adds the access column` |
| TK0029-M10 | packages/engine/src/log/jsonl.ts | left a schema_version 1 store refused instead of upgrading the marker | `opens a schema_version 1 store and upgrades the marker` |
| TK0029-M11 | packages/engine/src/config/config.ts | turned a null settings section into `{}` | `plugin settings > a null settings section refuses the plugin instead of becoming an empty object` |
| TK0029-M12 | packages/engine/src/plugin/registry.ts | accepted a null access profile as absent | `run access profile > refuses a null profile, which is not an access object` |
| TK0029-M13 | packages/engine/test/fixtures/plugins/secret-notes.ts | wrote the secret value into the step's fact | `plugin secrets > a run that uses a secret leaves it out of facts, history, environment and log files` |

## TK0019 — rework 7: per-repository numbering and an order-independent leak guard

| id | file | mutation | failing test |
|---|---|---|---|
| TK0019-M21 | packages/dev/src/model.ts | parsed the namespaced store key instead of the bare id when choosing the next number | `dev per-repository ids > ids count up across different slugs in one repository` |

## TK0026 — rework 18: the step plugin and a unique global fact

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M19 | packages/engine/src/trigger/kernel.ts | derived the emitting plugin from the event type instead of the caller | `the kernel start entry > emitStep checks the type against the caller's plugin, not the type` |
| TK0026-M20 | packages/engine/src/log/jsonl.ts | skipped the unique-key lookup, so a duplicate observe appended a second fact | `event receipt recovery > two processes delivering the same observe event write one fact (jsonl)` |
| TK0026-M21 | packages/engine/src/log/sqlite.ts | skipped the unique-key lookup, so a duplicate observe hit the unique index | `event receipt recovery > two processes delivering the same observe event write one fact (sqlite)` |

## TK0027 — plugin default rules and the event note in a prompt

| id | file | mutation | failing test |
|---|---|---|---|
| TK0027-M1 | packages/engine/src/trigger/rules.ts | stopped removing plugin rules whose source and type a user rule names | `trigger rules > a user rule replaces every plugin rule with the same source and type` |
| TK0027-M2 | packages/engine/src/trigger/rules.ts | kept a later plugin's rule for a pair an earlier plugin already owns | `trigger rules > a later plugin's rule for the same pair is skipped and both are named` |
| TK0027-M3 | packages/engine/src/plugin/registry.ts | skipped validating the rules a plugin ships | `trigger rules > an invalid plugin rule is refused at load with the plugin name and index` |
| TK0027-M4 | packages/engine/src/plugin/registry.ts | stopped checking that a plugin rule's flow is loaded | `trigger rules > a plugin rule whose flow does not exist is refused at load` |
| TK0027-M5 | packages/harness-radian/src/index.ts | dropped the event note from a triggered prompt | `harness-radian:prompt > a trigger with summary and data appends one note that names both files` |
| TK0027-M6 | packages/cli/src/main.ts | printed `user` as the origin of every rule in the listing | `operad trigger rules > lists each rule with where it came from` |

## TK0027 — rework 2: a plugin rule's params are checked as JSON

| id | file | mutation | failing test |
|---|---|---|---|
| TK0027-M7 | packages/engine/src/trigger/rules.ts | cast a rule's `start.params` without the log's JSON-value check | `trigger rules > a plugin rule whose params are not JSON is refused at load with the plugin name and index` |
| TK0027-M8 | packages/engine/src/trigger/rules.ts | joined source and type with a NUL instead of a JSON pair | `trigger rules > distinct source and type pairs are not confused when they contain a NUL` |

## TK0027 — rework 3: a plugin rule params is read once and checked when present

| id | file | mutation | failing test |
|---|---|---|---|
| TK0027-M9 | packages/engine/src/trigger/rules.ts | treated an explicitly undefined `start.params` as if the key were absent | `trigger rules > a plugin rule with an explicitly undefined params is refused at load` |
| TK0027-M10 | packages/engine/src/trigger/rules.ts | checked `start.params` through a second property read instead of the captured value | `trigger rules > a plugin rule's params are read once and the checked value is the one kept` |

## TK0027 — rework 4: a plugin rule's params are kept as a JSON snapshot

| id | file | mutation | failing test |
|---|---|---|---|
| TK0027-M11 | packages/engine/src/trigger/rules.ts | checked the params but returned the original, accessor-bearing object | `trigger rules > a nested getter's params are frozen into a plain JSON snapshot at load` |

## TK0029 — rework 5: an unreadable config file is an error

| id | file | mutation | failing test |
|---|---|---|---|
| TK0029-M14 | packages/engine/src/plugin/load.ts | treated every access error as a missing config file, not just `ENOENT` | `loadPluginRegistry > reports an unreadable config file instead of loading nothing` |

## TK0020 — the dev worktree and work steps

| id | file | mutation | failing test |
|---|---|---|---|
| TK0020-M1 | packages/dev/src/steps.ts | skipped merging the latest main into a reused worktree | `dev/worktree > reuses the worktree and merges the latest main into it` |
| TK0020-M2 | packages/dev/src/steps.ts | treated a plain directory at the worktree path as a worktree | `dev/worktree > a directory that is not a worktree is refused, not reused` |
| TK0020-M3 | packages/dev/src/steps.ts | ignored uncommitted changes after the harness | `dev/work > failed: uncommitted changes are named` |
| TK0020-M4 | packages/dev/src/steps.ts | skipped pushing the task branch | `dev/work > done: new commits and a clean tree are pushed` |
| TK0020-M5 | packages/dev/src/settings.ts | stopped rejecting a non-string `remote` | `dev/worktree > settings errors name the field` |
| TK0020-M6 | packages/dev/src/steps.ts | counted a replay of the same run as a new attempt | `dev/worktree > a replay of the same run reuses the attempt number` |

## TK0020 — rework 2: retries, relative roots, legacy settings, ancestry

| id | file | mutation | failing test |
|---|---|---|---|
| TK0020-M7 | packages/dev/src/steps.ts | treated a worktree visit after `work` as a replay of the same run | `dev/work > a failed work and a new worktree visit in the same run count a new attempt` |
| TK0020-M8 | packages/dev/src/settings.ts | accepted a `worktreeRoot` that is absolute or outside the repository | `dev/worktree > a worktreeRoot outside the repository is refused` |
| TK0020-M9 | packages/dev/src/settings.ts | rejected the `worktrees` and `sandbox` fields of settings from an earlier version | `dev/worktree > settings written by an earlier version still load` |
| TK0020-M10 | packages/dev/src/steps.ts | compared HEAD with the base for equality instead of checking ancestry | `dev/work > nothing: a reset below the base is not new work` |

## TK0020 — rework 3: symlink containment, remote reuse, empty args, failed-tree files

| id | file | mutation | failing test |
|---|---|---|---|
| TK0020-M11 | packages/dev/src/settings.ts | made `assertInsideRepository` return before resolving any real path | `dev/worktree > a worktreeRoot that is a symlink out of the repository is refused` |
| TK0020-M12 | packages/dev/src/steps.ts | returned `ready` after checking out a remote work branch without merging the fetched main | `dev/worktree > a remote work/<id> branch is reused after merging the latest main` |
| TK0020-M13 | packages/dev/src/steps.ts | omitted an empty `worker.args` from the harness params, so the flow's args were used | `dev/work > an empty worker.args is passed, not the flow's args` |
| TK0020-M14 | packages/dev/src/steps.ts | read the changed files only when the harness reported `done` | `dev/work > failed: a failed harness still names the files it left` |

## TK0021 — the gate: verify, review, rework

| id | file | mutation | failing test |
|---|---|---|---|
| TK0021-M1 | packages/dev/src/gate.ts | recorded every verify as `pass` | `dev/verify > a failing command records the command and its log` |
| TK0021-M2 | packages/dev/src/gate.ts | made `atOrAbove` always true, so a minor finding failed a major gate | `dev/review > a minor finding under a major fix level passes` |
| TK0021-M3 | packages/dev/src/gate.ts | stopped marking a finding on an untouched file pre-existing | `dev/review > a finding on a file the change did not touch is pre-existing and does not count` |
| TK0021-M4 | packages/dev/src/gate.ts | skipped the whole-diff size check | `dev/review > 2 MB of real code fails before a reviewer starts and records the size` |
| TK0021-M5 | packages/dev/src/gate.ts | made every rework auto-rework, never asking a person | `dev/rework > two failures rework and the third waits for a person` |
| TK0021-M6 | packages/dev/src/gate.ts | dropped verify's replay reuse, so a moved branch was verified again | `dev/verify > a replay of the same run keeps the first verified commit` |
| TK0021-M7 | packages/dev/src/gate.ts | returned no attributes, so a vendored 3 MB script entered the diff | `dev/review > a vendored 3 MB script is listed once and the code is reviewed` |
| TK0021-M8 | packages/dev/src/gate.ts | removed the second reviewer attempt after invalid JSON | `dev/review > invalid JSON is retried once and the second report passes` |

## TK0021 — rework 2: a bounded report read and a replay-safe rework

| id | file | mutation | failing test |
|---|---|---|---|
| TK0021-M9 | packages/dev/src/gate.ts | accepted a FIFO as the review report instead of refusing it | `dev/review > a FIFO at the report path fails instead of blocking the gate` |
| TK0021-M10 | packages/dev/src/gate.ts | re-ran a rework instead of reusing the one the run recorded | `dev/rework > a replay of the same rework run appends and counts nothing` |
| TK0021-M11 | packages/dev/src/steps.ts | kept the rework mark when the worktree started a new attempt | `dev/rework > a new attempt in the same flow run appends the next rework` |
| TK0021-M12 | packages/dev/src/gate.ts | filled a missing finding line with 0 instead of refusing the report | `dev/review > a finding without a line is an invalid report and is retried` |

## TK0021 — rework 4: the retry keeps the round's arguments

| id | file | mutation | failing test |
|---|---|---|---|
| TK0021-M13 | packages/dev/src/gate.ts | counted the retry as a new review, so the first review's retry got `args` instead of `firstArgs` | `dev/review > the retry after an invalid report keeps the round's arguments` |

## TK0022 — the dev merge, integrate and cleanup

| id | file | mutation | failing test |
|---|---|---|---|
| TK0022-M1 | packages/dev/src/integrate.ts | removed the replay check against the remote's main, so a recovery pushed the candidate again | `dev/integrate > a kill after the push recovers with no second push` |
| TK0022-M2 | packages/dev/src/integrate.ts | made `headMoved` always false, so a branch that moved past the verified sha was not recorded | `dev/integrate > the verified sha is merged even after the branch head moves` |
| TK0022-M3 | packages/dev/src/integrate.ts | treated a merge conflict as a plain failure instead of `conflict` | `dev/integrate > a conflict appends the conflict rework and leaves main alone` |
| TK0022-M4 | packages/dev/src/actions.ts | removed the waiting-phase check from `merge` and `reject` | `dev actions > merge and reject refuse a running task` |
| TK0022-M5 | packages/dev/src/integrate.ts | stopped recording a failing cleanup hook | `dev/cleanup > a failing hook is recorded and the task stays merged` |

## TK0030 — the holder's commit waits like the backend on a busy store

| id | file | mutation | failing test |
|---|---|---|---|
| TK0030-M1 | `packages/engine/test/fixtures/sqlite-hold.ts` | removed the holder's busy timeout, so its `COMMIT` returned `SQLITE_BUSY` when the opener's busy handler briefly held a shared lock | `opening waits while another process holds the store` (1 failure in 50 runs under load) |

## TK0022 — rework 3: a push that lands and reports an error

| id | file | mutation | failing test |
|---|---|---|---|
| TK0022-M6 | packages/dev/src/integrate.ts | removed the check that the remote's main contains the candidate after a failed push, so a push that landed was rebuilt and pushed again | `dev/integrate > a push that lands and reports an error is not pushed again` |

## TK0023 — dev scheduling

| id | file | mutation | failing test |
|---|---|---|---|
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

## TK0023 — rework 2: durable starts, manual-start eligibility and the verify phase

| id | file | mutation | failing test |
|---|---|---|---|
| TK0023-M11 | packages/dev/src/schedule.ts | removed the claim recovery, so a task left running with no run stayed stranded | `dev scheduling > a claim whose start never landed returns to ready and starts again` |
| TK0023-M12 | packages/dev/src/schedule.ts | let the manual-start pass reset both concurrency counters | `dev scheduling > start still respects the repository concurrency` |
| TK0023-M13 | packages/dev/src/schedule.ts | skipped the dependency check for a requested start | `dev scheduling > start still respects a dependency` |
| TK0023-M14 | packages/dev/src/gate.ts | set the early verify failure back to `running` instead of `review` | `dev/verify > a verify with no branch still records the review phase` |

## TK0023 — rework 3: a real dependency wait and a child-process crash test

| id | file | mutation | failing test |
|---|---|---|---|
| TK0023-M15 | packages/dev/src/steps.ts | ignored the flow's `blockedBy` parameter, so a cancelled dependency prepared a worktree instead of a person wait | `dev scheduling > a cancelled dependency leaves the dependent task as a person wait` |
| TK0023-M16 | packages/dev/src/schedule.ts | disabled the claim recovery, so the child-process crash test leaves the claimed task stranded | `dev scheduling > a claim whose start never landed returns to ready and starts again` |

## TK0023 — rework 5: claimed starts, cancellation and real merge lines

| id | file | mutation | failing test |
|---|---|---|---|
| TK0023-M17 | packages/dev/src/service.ts | cleared `startRequested` when the claim was taken instead of when the run recorded itself | `dev scheduling > a manual start survives a crash before the run records itself` |
| TK0023-M18 | packages/dev/src/steps.ts | let a cancelled task through the claim check | `dev scheduling > a cancelled task never starts work` |
| TK0023-M19 | packages/dev/src/schedule.ts | printed `waiting -> merged` when answering the merge instead of waiting for the integrate result | `dev scheduling reports the integration transition > a refused push prints integrating -> waiting, never merged` |
| TK0023-M20 | packages/dev/src/steps.ts | skipped the claim-token comparison, so an older run could write a newer claim's task | `dev/worktree > a run whose token does not match the claim writes nothing` |


## TK0023 — rework 6: a guarded write re-checks under the lock

| id | file | mutation | failing test |
|---|---|---|---|
| TK0023-M21 | packages/dev/src/steps.ts | checked the caller's stale task data instead of re-reading the task under the repository lock, so a concurrent cancel was overwritten | `dev/worktree > a cancel that lands between the guard and the write is not overwritten` |

## TK0024 — dogfood switch

| id | file | mutation | failing test |
|---|---|---|---|
| TK0024-M3 | packages/engine/src/config/config.ts | left `harness-radian` out of the plugins a new home installs | `operad config > the default plugins are shell, the radian harness and dev` |
| TK0024-M4 | packages/cli/src/main.ts | skipped resolving a scoped object id before reading history, so a task keyed by its repository had no run | `dogfood end to end > a task survives a killed run and reaches a merge with a history of every step` |

## TK0024 — rework 2: an event wait and the whole user output

| id | file | mutation | failing test |
|---|---|---|---|
| TK0024-M6 | packages/cli/src/main.ts | wrote an internal word into the loop's own output | `dogfood end to end > a task survives a killed run and reaches a merge with a history of every step` |
| TK0024-M7 | packages/cli/src/main.ts | wrote an internal word into a `pending --json` page | `dogfood end to end > a task survives a killed run and reaches a merge with a history of every step` |
| TK0024-M8 | packages/cli/test/e2e.test.ts | installed no store watcher, so the wait only looked once instead of on each change | `dogfood end to end > a task survives a killed run and reaches a merge with a history of every step` |

## TK0032 — a read-only remote check and a refused push

| id | file | mutation | failing test |
|---|---|---|---|
| TK0032-M1 | packages/dev/src/check.ts | ignored a failed `git ls-remote` and reported a missing branch instead of an unreachable remote | `dev init check > an unreachable remote is a failed check with git's message` |
| TK0032-M2 | packages/dev/src/check.ts | treated a reachable remote with any branch as having the main branch | `dev init check > a reachable remote without the main branch is a failed check that writes nothing` |
| TK0032-M3 | packages/dev/src/check.ts | passed the fetch URL to `git ls-remote` instead of the remote name | `dev init check > the check asks through the remote name, not its URL` |
| TK0032-M4 | packages/dev/src/views.ts | left the failed integration out of the task's note while it waits | `dev/integrate > a remote that refuses the push is failed with git's message` |

## TK0032 — rework 2: every line of git's stderr

| id | file | mutation | failing test |
|---|---|---|---|
| TK0032-M5 | packages/dev/src/check.ts | reported only the first line of git's stderr for an unreachable remote | `dev init check > an unreachable remote keeps every line of git's stderr` |
| step-timeout-M1 | packages/engine/src/runner/runner.ts | `timeoutMsFor` ignored the step type's `timeoutSecs` and always used the runner's step timeout | `runner > a step's own timeoutSecs replaces the runner's step timeout` |
| reviewer-stall-M1 | packages/dev/src/gate.ts | stopped passing `reviewer.stallSecs` to the review harness step | `dev/review > reviewer.stallSecs reaches the harness step, and is absent when unset` |

## TK0012 — serve runs steps

| id | file | mutation | failing test |
|---|---|---|---|
| TK0012-M1 | packages/engine/src/flow/validate.ts | stopped counting `interrupted` as a possible result of an unsafe step | `validateFlow > requires an interrupted edge for every unsafe step` |
| TK0012-M2 | packages/dev/flows/dev.flow.ts | removed the `worktree` step's `interrupted` edge | `the dev flow > loads with the gate and the rework edges` |
| TK0012-M3 | packages/engine/src/loop/serve.ts | treated every `running` run as a crash, so a freshly requested effect was recovered instead of run | `serve loop > a recorded answer runs the next step in serve's process` |
| TK0012-M4 | packages/dev/src/schedule.ts | stopped reconciling a waiting task with the runs in the log, so an orphaned task was never repaired | `dev scheduling > serve repairs a task whose run ended without an edge, and reject runs again` |
| TK0012-M5 | packages/harness-radian/src/process.ts | stopped pausing the stall timer while a tool call was open | `harness-radian/agent > an open tool call pauses the stall timer until it settles` |
| TK0012-M6 | packages/engine/src/runner/runner.ts | recorded pid 0 on the step-start fact instead of the executing process | `operad with the dev plugin > dev:reject from the CLI records, and serve runs the next step` |

## TK0011 — short plan and task ids

| id | file | mutation | failing test |
|---|---|---|---|
| TK0011-M9 | packages/dev/src/model.ts | `parseId` rejected the old `PL`/`TK` form, so an old id in two repositories was ambiguous | `operad with the dev plugin > show and dev:confirm take an old id, and an id is matched exactly` |
| TK0011-M10 | packages/dev/src/model.ts | `numberById` skipped ids in the old form, so allocation started from 1 instead of the highest old number | `dev per-repository ids > new ids count past old ids in either form` |
| TK0011-M11 | packages/dev/src/model.ts | `formatId` emitted the old `PL`/`TK` form for new objects | `dev per-repository ids > ids count up across different slugs in one repository` |

## T-0019-http-api — the HTTP interface of serve

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M1 | packages/engine/src/http/token.ts | `tokensEqual` returned true without comparing | `http server > refuses a missing, a wrong and a rotated token` |
| T-0019-http-api-M2 | packages/engine/src/http/token.ts | `rotateHttpToken` kept the current token instead of generating a new one | `http server > refuses a missing, a wrong and a rotated token` |
| T-0019-http-api-M3 | packages/engine/src/http/address.ts | accepted every `172.x` address as RFC 1918 instead of `172.16.0.0/12` | `http server > classifies every listen address class and refuses a wildcard` |
| T-0019-http-api-M4 | packages/engine/src/http/server.ts | mapped a section timeout to `400` instead of `504` | `http server > lists types and objects, gets one object, and pages a section` |
| T-0019-http-api-M5 | packages/engine/src/http/server.ts | recorded the token itself as the HTTP actor id | `http server > acts with a note, refuses without one, and needs confirmed for a confirm action`; `http server > never writes the token to the store, its facts or history` |
| T-0019-http-api-M6 | packages/engine/src/http/server.ts | ignored `Last-Event-ID`, so a reconnect replayed nothing | `http server > streams changes, resumes from Last-Event-ID and resets an old id` |
| T-0019-http-api-M7 | packages/engine/src/config/config.ts | ignored `http.enabled` and always kept the interface off | `operad config > reads http options and applies their defaults` |
| T-0019-http-api-M8 | packages/engine/src/http/server.ts | skipped the listen-address check before binding | `operad serve http > refuses a wildcard at start and names the entry` |
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
| TK0002-M14 | packages/harness-radian/src/index.ts | `parseResult` dropped the Result's `model_error` | `harness-radian/agent > a Result record's model_error is passed through as data` and `dev/review hardening > a radian Result with a model_error makes the real harness report unavailable` |
| TK0002-M15 | packages/dev/src/gate.ts | removed the cap on unavailable waits | `dev/review hardening > an unavailable model waits at most MAX_REVIEW_WAITS times, across a restart` |
| TK0002-M16 | packages/dev/src/gate.ts | started a reviewer run that cannot end inside the step deadline | `dev/review hardening > runs that cannot fit in the step deadline are skipped and a person decides` |
| TK0002-M17 | packages/dev/src/actions.ts | offered merge, reject, rework and reverify during the review model wait | `dev:rework and dev:reverify > a review waiting for its model offers no merge, reject, rework or reverify` |
| TK0002-M18 | packages/dev/flows/dev.flow.ts | set the flow's visit bound to 10, below the review waits | `the dev flow > loads with the gate and the rework edges` |
## TK0013 — pi runs under Bun

| id | file | mutation | failing test |
|---|---|---|---|
| TK0013-M1 | packages/harness-pi/spike/fake-provider.ts | dropped the tool call from the fake assistant message | `a tool call to read runs` |
| TK0013-M2 | packages/harness-pi/spike/pi-session.ts | `createSpikeSession` ignored the supplied session manager and used an in-memory one | `a session file reopens and a second prompt sees the first message` |
| TK0013-M3 | packages/harness-pi/spike/fake-provider.ts | set `usage.totalTokens` to 0 in the fake assistant message | `a prompt ends with the fixed answer and message_end carries usage` |
| TK0013-M4 | packages/harness-pi/spike/auth-writer.ts | `hold` mode wrote its credential without taking the lock | `auth.json locking blocks a second writer until the lock is released` |
| TK0013-M5 | packages/harness-pi/spike/auth-writer.ts | `unlocked-read` read the file after the gate instead of snapshotting it before | `the same read-modify-write without the lock loses a credential` |
| lead-actions-M1 | packages/dev/src/service.ts | the claim ignored the version it was given and checked only the phase | `dev:rework and dev:reverify > rework racing merge in two processes: exactly one wins` |
| lead-actions-M2 | packages/dev/src/actions.ts | `dev:rework` did not reset the count of automatic reworks | `dev:rework and dev:reverify > a lead rework resets the streak of automatic reworks, and numbers on` |
| lead-actions-M3 | packages/dev/src/actions.ts | `dev:reverify` kept the old verify result, so the verify step would replay it | `dev:rework and dev:reverify > reverify from a gate failure clears the gate results and answers reverify` |
| lead-actions-M4 | packages/dev/src/actions.ts | a failed answer left the claim (the lead section) on the task | `dev:rework and dev:reverify > an answer that fails gives the claim back` |
| lead-actions-M5 | packages/dev/src/actions.ts | `dev:reverify` accepted a task that never worked | `dev:rework and dev:reverify > reverify of a task that never worked refuses and leaves it alone` |
| lead-actions-M6 | packages/dev/flows/dev.flow.ts | the `reverify` choice had no edge to `verify` | `the dev flow > loads with the gate and the rework edges` |
| waiting-notices-M1 | packages/dev/src/announce.ts | the event key carried a random part, so a replayed step emitted a second event | `dev.waiting > work did nothing: one event, once, also when the step runs again` |
| waiting-notices-M2 | packages/dev/src/views.ts | a plan row left out its auto level and priority | `dev views > a plan row shows the derived state and merged/total` |
| waiting-notices-M3 | packages/engine/src/views/presentation.ts | the History section skipped the actions people ran | `operad with the dev plugin > a plan shows its auto level and priority, and its history shows who confirmed and set it` |
| waiting-notices-M4 | packages/dev/src/actions.ts | `dev:merge` accepted a task with no verified commit | `dev actions > merge refuses a task whose head was never verified, and says why` |
| waiting-notices-M5 | packages/engine/src/views/presentation.ts | `show` with no id listed the oldest changes first | `operad with the dev plugin > show without an id lists the ten latest changes; an unknown id lists the five closest` |
| waiting-notices-M6 | packages/engine/src/views/presentation.ts | an unknown id listed the farthest ids instead of the closest | `operad with the dev plugin > show without an id lists the ten latest changes; an unknown id lists the five closest` |
| waiting-notices-M7 | packages/engine/src/trigger/kernel.ts | an event recorded in a run lost its summary text | `dev.waiting > work did nothing: one event, once, also when the step runs again` |
| waiting-notices-M8 | packages/dev/src/views.ts | lists never named the repository | `operad with the dev plugin > lists name the repository once more than one is registered` |
| waiting-notices-M9 | packages/dev/flows/dev.flow.ts | a worker that did nothing went to the wait without an announce step | `the dev flow > loads with the gate and the rework edges` |
| waiting-notices-M10 | packages/dev/src/announce.ts | a stopped run returned `done`, so the wait lost the step that stopped | `dev.waiting > a stopped worktree step names the step that stopped: one event, once, also when the step runs again` |
| waiting-notices-M11 | packages/dev/src/actions.ts | `dev:priority` on a plan with auto off printed nothing | `dev actions > priority on a plan whose auto level is off says the scheduler will not start it` |
| waiting-notices-M12 | packages/dev/src/views.ts | a long diff was not paged by file | `dev views > the diff section is the stat and the diff, and pages by file when long` |
| bun-fd-guard-M1 | packages/harness-radian/src/process.ts | the old code: the sentinel's `stdio` had a fourth pipe and the harness stderr went to `child.stdio[3]` | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (child exits 137, 3 of 3 runs) |
| bun-fd-guard-M2 | packages/harness-radian/src/process.ts | the stderr tail was not read back from the file (`stderrTail.push("")`) | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (tails `[""]` instead of `["oops"]`) |
| bun-fd-guard-M3 | packages/harness-radian/src/process.ts | the fixed code with `stdio` set back to four pipes, the fourth one unused | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (child exits 137) |

## T-0019-http-api — rework 2: the cancel test waits on no real timer

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M9 | packages/shell/src/process.ts | the stop skipped its grace SIGKILL, so a line that ignores SIGTERM kept the group alive | `shell/command > cancel stops the process group and reports interrupted` (timed out after 5000ms) |
| bun-fd-guard-M4 | packages/harness-radian/src/process.ts | `stdio` set back to four pipes | `child process stdio > no source spawns with more than three stdio entries or reads stdio[3] or higher` (names `packages/harness-radian/src/process.ts:434` and bf3a73e) |
| review-did-not-finish-M1 | packages/dev/src/announce.ts | named the reason `review failed` again | `dev.waiting > a review that did not finish: one event, once, also when the step runs again` |

## T-0019-http-api — rework 3: SSE ids, stream limits, rotation and the HTTP confirm hint

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M10 | packages/engine/src/http/server.ts | the resume check ignored the boot id, so an id from an earlier serve looked current | `http server > a Last-Event-ID from an earlier serve gets one reset` |
| T-0019-http-api-M11 | packages/engine/src/http/server.ts | `push` accepted every event, so a client that stopped reading kept an unbounded queue | `http server > ends a client that stops reading instead of growing without bound` |
| T-0019-http-api-M12 | packages/engine/src/http/server.ts | the token watcher noticed a rotation but did not end the open streams | `http server > rotating the token ends the event streams opened with the old one` |
| T-0019-http-api-M13 | packages/engine/src/http/server.ts | `Bun.serve` got a body limit eight times the protocol's | `http server > refuses a request body larger than one mebibyte` |
| T-0019-http-api-M14 | packages/engine/src/views/presentation.ts | the confirm refusal always said `pass --yes`, also over HTTP | `http server > acts with a note, refuses without one, and needs confirmed for a confirm action` |

## T-0019-http-api — rework 4: lead actions claim the version they were offered

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M15 | packages/dev/src/actions.ts | claimed at the version read inside the action instead of the version the action was offered on, so two lead actions both won | `dev:rework and dev:reverify > an action offered a stale object loses even while the task still waits` |

## T-0019-http-api — rework 5: the act body's optional id

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M16 | packages/engine/src/http/server.ts | made `POST /v1/act` require an id again, so the handler answered `400` before the views could name the missing object | `http server > accepts an act body without an id and lets the views name the missing object` |

## TK0005 — the platform module

| id | file | mutation | failing test |
|---|---|---|---|
| TK0005-M1 | packages/engine/src/platform/sqlite-open.ts | `setBusyTimeout` installed no busy timeout | `the busy timeout is installed on the connection` |
| TK0005-M2 | packages/dev/src/lock.ts | did not map `LockTimeoutError` to the dev lock error | `the repository lock > a live holder past the deadline is a dev lock error naming its pid` |
| TK0005-M3 | packages/engine/src/platform/file-lock.ts | `linkExclusive` reported success when the target already existed | `the lock file > a live holder blocks until the deadline and names its pid` (and six more in that file) |
| TK0005-M4 | packages/engine/src/platform/process-group.ts | the shared stop never sent the grace SIGKILL | `process groups` and the harness-radian tests (timed out) |
| TK0005-M5 | packages/engine/src/platform/sqlite-open.ts | `enableWal` rethrew `SQLITE_BUSY` instead of waiting | `switching to WAL waits while another process holds the database` |
| TK0005-M6 | packages/engine/src/platform/watch.ts | `resolveSubscriptionWatch` ignored an injected watch | `the injected watch, timer and period replace the defaults` |
| TK0005-M7 | packages/engine/test/platform/no-copies.test.ts | dropped the `process.kill(-` pattern from the scan | `the platform module is the only copy > the scan finds each forbidden call outside platform/` |
| TK0006-M1 | packages/dev/src/service.ts | `claimTaskStart` skipped the area check under the lock | `two schedulers on one store never start two tasks of one area` |
| TK0006-M2 | packages/dev/src/service.ts | `areaHolder` ignored tasks in the review phase | `a claim is refused while a task of the area is running or reviewing` |
| TK0006-M3 | packages/dev/src/service.ts | `areaHolder` ignored the repository | `the same area in another repository does not block` (and the two-scheduler test) |

## TK0015 — pi worker

| id | file | mutation | failing test |
|---|---|---|---|
| TK0015-M1 | packages/harness-pi/src/worker.ts | a message with no cost object counted as price 0 instead of unpriced | `a model with no price has cost.micros null` |
| TK0015-M2 | packages/harness-pi/src/worker.ts | `cache_read` taken from `cacheWrite` | `a prompt that ends writes the lines in order and a Result with usage, cost and sessionId` |
| TK0015-M3 | packages/harness-pi/src/worker.ts | the `agent_settled` line not written | `a prompt that ends writes the lines in order and a Result with usage, cost and sessionId` |
| TK0015-M4 | packages/harness-pi/src/worker.ts | cancelled run returned exit code 0 instead of 143 | `SIGTERM during a slow fake stream writes a cancelled Result and exits 143` |
| TK0015-M5 | packages/harness-pi/src/worker.ts | resource loader discovery on, `agentDir` set to `$HOME/.pi/agent` | `nothing under the fake HOME .pi is read or created` |
| TK0015-M6 | packages/harness-pi/src/worker.ts | `resumeSession` ignored (always a new session) | `resume: the second run sees the first answer in the context the fake model receives` |
| TK0017-M1 | packages/access-match/src/command.ts | `\|` removed from the split operators | `split operator "\|" reaches the part after it` |
| TK0017-M2 | packages/access-match/src/index.ts | relative paths joined to `cwd` without resolving `..` | `~ is expanded, relative paths are joined to cwd, and .. is resolved` |
| TK0017-M3 | packages/harness-pi/src/worker.ts | the `tool_call` hook returns `undefined` instead of `{ block: true, reason }` | `a denied bash call is blocked, a blocked line is written, the model gets the reason and the run ends done` |
| TK0017-M4 | packages/access-match/src/command.ts | `xargs` and `eval` not seen as inline code | `inline code xargs is refused though no rule names it` |

## TK0014 — the shared harness process helper

| id | file | mutation | failing test |
|---|---|---|---|
| TK0014-M1 | packages/harness-process/src/process.ts | ignored the `toolEvent` classifier, so no line counted as a tool call | `a pi tool call pauses the stall timer until its end line` |
| TK0014-M2 | packages/harness-radian/src/index.ts | mapped radian's `ToolExecutionStarted` to `"tool-end"` | `harness-radian/agent > an open tool call pauses the stall timer until it settles` |

## TK0016 — harness-pi agent step

| id | file | mutation | failing test |
|---|---|---|---|
| TK0016-M1 | packages/harness-pi/src/index.ts | `piToolEvent` returned `undefined` for `tool_execution_start`, so no tool call opened | `harness-pi/agent > silence with an open tool call is not a stall` |
| TK0016-M2 | packages/harness-pi/src/index.ts | a missing Result line after a signal was `failed` instead of `interrupted` | `harness-pi/agent > a worker killed with SIGKILL ends interrupted and leaves the test alive` |
| TK0016-M3 | packages/harness-pi/src/index.ts | `resumeSession` was left out of the worker's stdin | `harness-pi/agent > resumeSession is passed through to the worker's stdin` |
| TK0016-M4 | packages/harness-pi/src/index.ts | a usage-limit error text was never `usage_limit` | `harness-pi/agent > a model_error failure about a usage limit is usage_limit` |
| TK0016-M5 | packages/harness-pi/src/index.ts | the step stopped declaring `denyCommands` in `enforces` | `harness-pi/agent > the step declares the deny fields it enforces and a timeout above its wall time` |

## TK0009 — plugin follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| TK0009-M1 | packages/engine/src/platform/process-group.ts | the drain grace used `globalThis.setTimeout` instead of the injected clock | `shell/command > a child that leaves the group cannot hold the command open` (timed out) |
| TK0009-M2 | packages/engine/src/platform/process-group.ts | a finished line took the TERM/grace stop instead of a direct SIGKILL | `process groups > a finished line is stopped with a single SIGKILL` |
| TK0009-M3 | packages/engine/src/platform/process-group.ts | the sentinel looped forever instead of watching the host process | `the sentinel's host > a sentinel whose host was killed ends when its line finishes` |
| TK0009-M4 | packages/engine/src/platform/process-group.ts | `exitFromStatus` mapped status 130 to a signal and dropped the code | `shell/command > a command that exits 130 keeps the exit code in the fact` |
| TK0009-M5 | packages/engine/src/platform/process-group.ts | `ControlReader.destroy()` set closed before the stream close could resolve the waiter | `the control reader > destroy resolves a pending read` (timed out) |
| TK0009-M6 | packages/shell/src/index.ts | the aborted-before-first-line branch named a log that was never written | `shell/check > an abort before the first line is interrupted and leaves a log` |
| TK0009-M7 | packages/dev/src/service.ts | the generated dev.json left out `$schema` | `dev repositories > add writes settings and excludes, list reads it, remove refuses open tasks` |
| TK0009-M8 | packages/harness-radian/test/support.ts | `processesUnder` returned nothing | `the guard sees a process whose command line names a temp directory` |
| TK0009-M9 | packages/harness-process/src/process.ts | the harness drain used `globalThis.setTimeout` instead of the injected clock | `the harness process > a child that leaves the group cannot hold the run open` (timed out) |
| TK0009-M10 | packages/harness-process/src/process.ts | a finished harness run took the grace stop instead of a direct SIGKILL | `the harness process > a child that leaves the group cannot hold the run open` (sleeps 1) |
## TK0018 — pi dogfood

| id | file | mutation | failing test |
|---|---|---|---|
| TK0018-M1 | packages/harness-pi/src/index.ts | the step's declared results named `cancelled` instead of `interrupted`, so they differed from radian's | `this repository's dev.json with the pi worker > worker.use harness-pi/agent validates and the dev flow resolves it` |
- [cli](packages/cli/MUTATIONS.md)
- [dev](packages/dev/MUTATIONS.md)
- [engine](packages/engine/MUTATIONS.md)
- [harness-pi](packages/harness-pi/MUTATIONS.md)
- [harness-radian](packages/harness-radian/MUTATIONS.md)
- [shell](packages/shell/MUTATIONS.md)
- [source-cron](packages/source-cron/MUTATIONS.md)
## T-0020 — pairing, links and the notification hook

| id | file | mutation | failing test |
|---|---|---|---|
| T-0020-M1 | packages/engine/src/notify/notify.ts | dropped the `recorded.has(key)` skip, so every pass notified again | `notify > a restart of serve does not notify again for the same wait` |
| T-0020-M2 | packages/engine/src/notify/notify.ts | the notification key left out the wait id | `notify > a new wait on the same run notifies again` |
| T-0020-M3 | packages/engine/src/notify/notify.ts | a cancelled command was recorded as sent | `notify > stopping serve cancels a running command and records nothing` |
| T-0020-M4 | packages/engine/src/http/link.ts | `objectLink` stopped URL-encoding the id | `http server > an object carries its link, URL-encoded, and so does its pending item` |
| T-0020-M5 | packages/cli/src/qr.ts | the format bits lost their `0x5412` mask | `qr encoder > the format bits for level M match the standard's table` |
| T-0020-M6 | packages/cli/src/qr.ts | version 8's block layout became four equal blocks | `qr encoder > every version round-trips at its capacity, and the next byte needs the next version` |
| T-0020-M7 | packages/cli/src/main.ts | `pair` stopped refusing a non-terminal without `--show-token` | `operad pair > refuses without a terminal and prints nothing of the token` |
| T-0020-M8 | packages/engine/src/notify/notify.ts | `OPERAD_LINK` left out of the command's environment | `notify > a waiting task runs the command once with the four variables` |
| T-0020-M9 | packages/engine/src/config/config.ts | `notify.on` accepted any value | `operad config > rejects a malformed notify section` |
