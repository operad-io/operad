# Mutation records

| id | file | mutation | failing test |
|---|---|---|---|

## TK0013 — flow definition

| id | file | mutation | failing test |
|---|---|---|---|
| TK0013-M1 | packages/engine/src/flow/validate.ts | inverted the missing-edge check (`!hasOwn` → `hasOwn`) | `validateFlow > names a result with no edge` |
| TK0013-M2 | packages/engine/src/flow/validate.ts | unknown plugin step type fell back to an empty result list instead of an error | `validateFlow > names an unknown plugin step type` |
| TK0013-M3 | packages/engine/src/flow/validate.ts | disabled the unreachable-step check | `validateFlow > names an unreachable step` |
| TK0013-M4 | packages/engine/src/flow/load.ts | dropped the file name from the import-error message | `loadFlow > names the file when a module throws on import` |
| TK0013-M5 | packages/engine/src/flow/define-flow.ts | removed the `wait_person` result-name check | `tsc -b`: `define-flow.test.ts(51,7): Unused '@ts-expect-error' directive` |
| TK0013-M6 | packages/engine/src/flow/validate.ts | disabled the duplicate-id check | `validateFlow > names duplicate step ids` |

## TK0013 — rework 2: plugin step names match exactly

| id | file | mutation | failing test |
|---|---|---|---|
| TK0013-M7 | packages/engine/src/flow/validate.ts | restored the fallback from `dev/command` to the unqualified `command` | `validateFlow > matches a plugin step type by its full name only` |

## TK0011 — jsonl log backend

| id | file | mutation | failing test |
|---|---|---|---|
| TK0011-M1 | `packages/engine/src/log/jsonl.ts` | `truncateTornLine` returned immediately, so a torn final line stayed on disk | `log backend: jsonl > a torn last line is cut off on open` |
| TK0011-M2 | `packages/engine/src/log/jsonl.ts` | `append` skipped the `expectedSeq` comparison | `log backend: jsonl > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0011-M3 | `packages/engine/src/log/secret.ts`, `packages/engine/src/log/json-value.ts` | `Secret.toJSON` returned the value and the JSON walker stopped rejecting `Secret` | `log backend: jsonl > a Secret never reaches the log` |
| TK0011-M4 | `packages/engine/src/log/jsonl.ts` | `recordInput` ignored the dedupe index | `log backend: jsonl > recordInput stores one record per (source, sourceKey)` |
| TK0011-M5 | `packages/engine/src/log/jsonl.ts` | `startRun` stopped refusing an active flow/object pair | `log backend: jsonl > startRun keeps one active run per flow and object` |
| TK0011-M6 | `packages/engine/src/log/jsonl.ts` | `ensureSchema` stopped refusing a newer `schema_version` | `log backend: jsonl > a newer schema_version is refused with a clear error` |

## TK0011 — review fixes

| id | file | mutation | failing test |
|---|---|---|---|
| TK0011-M7 | `packages/engine/src/log/jsonl.ts` | `#rebuildInputs` recorded the file size from `statSync` instead of the bytes it had read | `opening a store does not miss an input appended during the rebuild` |
| TK0011-M8 | `packages/engine/src/log/json-value.ts` | the JSON walker stopped rejecting a callable `toJSON` | `log backend: jsonl > a payload with a toJSON method is refused and writes nothing` |

## TK0014 — kernel: pure decide, evolve and replay

| id | file | mutation | failing test |
|---|---|---|---|
| TK0014-M1 | `packages/engine/src/kernel/decide.ts` | made the visit limit unreachable (`visit > Number.MAX_SAFE_INTEGER`) | `decide: visits > ends the run when a step is entered past the default maxVisits` |
| TK0014-M2 | `packages/engine/src/kernel/decide.ts` | changed the crash-loop stop from `>=` to `>` | `decide: recover > requests a safe step again and stops after three recoveries` |
| TK0014-M3 | `packages/engine/src/kernel/decide.ts` | treated every step as replay-safe on recover | `decide: recover > interrupts an unsafe step and leaves it` |
| TK0014-M4 | `packages/engine/src/kernel/decide.ts` | skipped the declared-result check | `decide: step_result > turns an undeclared result into an interrupted failure` |
| TK0014-M5 | `packages/engine/src/kernel/decide.ts` | inverted the timed-wait comparison (`now > due` returned early) | `decide: tick > does nothing before a timed wait is due` |
| TK0014-M6 | `packages/engine/src/kernel/decide.ts` | removed the step_result effect id/status/step guard | `decide: step_result > ignores a result for an unknown effect` |
| TK0014-M7 | `packages/engine/src/kernel/state.ts` | recorded a completed result as still `outstanding` | `evolve: each fact kind > step_result records the result once` |

## TK0012 — sqlite log backend

| id | file | mutation | failing test |
|---|---|---|---|
| TK0012-M1 | `packages/engine/src/log/sqlite.ts` | `append` skipped the `expectedSeq` comparison | `log backend: sqlite > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0012-M2 | `packages/engine/src/log/sqlite.ts` | `startRun` stopped refusing an active flow/object pair; the partial unique index still rejected the insert | `log backend: sqlite > startRun keeps one active run per flow and object` |
| TK0012-M3 | `packages/engine/src/log/sqlite.ts` | `ensureSchema` stopped refusing a newer `schema_version` | `log backend: sqlite > a newer schema_version is refused with a clear error` |
| TK0012-M4 | `packages/engine/src/log/sqlite.ts` | `recordInput` used `INSERT OR REPLACE`, so a duplicate reported `duplicate: false` | `log backend: sqlite > recordInput stores one record per (source, sourceKey)` |
| TK0012-M5 | `packages/engine/src/log/sqlite.ts` | `read` stopped reporting a missing run | `log backend: sqlite > a run file deleted by hand makes read fail without touching other runs` |
| TK0012-M6 | `packages/engine/src/log/sqlite.ts` | `read` ordered facts newest first | `log backend: sqlite > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0012-M7 | `packages/engine/src/log/sqlite.ts` | open errors were rethrown unwrapped, so a read-only directory surfaced a raw SQLite error | `opening a store in a read-only directory fails with a clear error` |
| TK0012-M8 | `packages/engine/src/log/sqlite.ts` | `endRun` threw on an already-ended run | `log backend: sqlite > endRun is idempotent, unknown runs fail, and an ended run takes no facts` |

## TK0012 — rework 2: wait for the writer without polling

| id | file | mutation | failing test |
|---|---|---|---|
| TK0012-M9 | `packages/engine/src/log/sqlite.ts` | `setWalMode` rethrew `SQLITE_BUSY` instead of waiting for the other writer through the busy handler | `opening waits while another process holds the store` |

## TK0015 — plugin interface

| id | file | mutation | failing test |
|---|---|---|---|
| TK0015-M1 | packages/engine/src/plugin/registry.ts | removed the duplicate plugin-name check | `plugin registry validation > rejects two plugins with the same name` |
| TK0015-M2 | packages/engine/src/plugin/registry.ts | removed the try/catch around an action's `when` | `plugin registry validation > hides and logs an action whose when throws` |
| TK0015-M3 | packages/engine/src/plugin/registry.ts | called the flow loader without the loaded step types | `plugin registry > gives the flow loader the loaded step types` |
| TK0015-M4 | packages/engine/src/plugin/registry.ts | removed the `operadPlugin` version check | `plugin registry validation > rejects a plugin with an unsupported API version` |
| TK0015-M5 | packages/engine/src/plugin/registry.ts | disabled the short-command clash check between plugins | `plugin registry validation > rejects two plugins that declare the same short command` |
| TK0015-M6 | packages/engine/src/plugin/registry.ts | skipped the check that a step returned a declared result | `plugin registry validation > rejects a step that returns a result it did not declare` |
| TK0015-M7 | packages/engine/src/plugin/store.ts | stopped appending a fact when an object is put | `plugin registry > runs the test plugin's step, command and action end to end` |

## TK0016 — runner and views

| id | file | mutation | failing test |
|---|---|---|---|
| TK0016-M1 | packages/engine/src/runner/service.ts | dropped the run id from the input key, so the second run's start was a duplicate | `operad command > pending, running and history answer in user words` |
| TK0016-M2 | packages/engine/src/runner/runner.ts | returned `ok` from the wall-time branch instead of a declared failure | `runner > a step that never ends becomes a failed result` |
| TK0016-M3 | packages/engine/src/runner/lock.ts | treated every existing lock as held, ignoring a dead PID | `runner > the run lock keeps one runner per run and clears a stale pid` |
| TK0016-M4 | packages/engine/src/loop/serve.ts | removed the due-time check, so a wait was woken early | `serve loop > does not wake a wait before it is due` |
| TK0016-M5 | packages/engine/src/views/history.ts | dropped the words for an interrupted unsafe step | `serve loop > recovers an unsafe run into a person wait, and an action ends it` |
| TK0016-M6 | packages/engine/src/views/pending.ts | suppressed the plugin actions on a waiting run | `operad command > pending, running and history answer in user words` |
| TK0016-M7 | packages/engine/src/config/config.ts | ignored the sqlite backend and always chose jsonl | `operad config > reads plugins and a sqlite store with a relative path` |
| TK0016-M8 | packages/engine/src/runner/service.ts | stopped ending the log run when the run ended | `runner > drives a run to the end, one batch per input` |

## TK0016 — rework 2: crash consistency, bounded steps, defaults and history

| id | file | mutation | failing test |
|---|---|---|---|
| TK0016-M9 | packages/engine/src/runner/service.ts | treated every recorded input as applied, even when no fact used it | `runner > an input recorded before a crash is applied on recovery` |
| TK0016-M10 | packages/engine/src/runner/runner.ts | replaced the wall-time message with a generic one | `runner > a synchronous step is stopped by the wall time` |
| TK0016-M11 | packages/engine/src/config/config.ts | installed no default plugin | `operad command > init creates the home and prints each plugin check` |
| TK0016-M12 | packages/engine/src/loop/serve.ts | stopped listening for the abort while sleeping | `serve loop > a sleeping loop ends as soon as the signal aborts` |
| TK0016-M13 | packages/cli/src/main.ts | dropped the ambiguity check for an untyped object id | `operad command > history resolves a plugin object without mixing object types` |
| TK0016-M14 | packages/cli/src/main.ts | accepted arguments to `serve` | `operad command > serve rejects arguments as a usage error` |
| TK0016-M15 | packages/engine/src/plugin/file-store.ts | stopped refreshing a reader from the file | `the file plugin store > a second reader sees facts another writer appended` |
| TK0016-M16 | packages/engine/src/plugin/builtin/shell.ts | reported a non-zero exit as success | `the base shell plugin > a command that exits non-zero is a failed result` |

## TK0016 — rework 4: a failure is never recorded as a success result

| id | file | mutation | failing test |
|---|---|---|---|
| TK0016-M17 | packages/engine/src/runner/runner.ts | made `chooseFailure` fall back to the step's first declared result instead of naming the failure | `runner > a step that throws is not recorded as its success result` |
| TK0016-M18 | packages/engine/src/runner/runner.ts | removed the `preferInterrupted` early return, so a failed check reported its declared success result | `runner > a check that throws is not recorded as ready` |

## TK0026 — trigger core: one start entry and event rules

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M1 | packages/engine/src/trigger/kernel.ts | ignored the stored result of a duplicate event and routed it again | `the kernel start entry > the same event twice records one input and starts one run` |
| TK0026-M2 | packages/engine/src/trigger/kernel.ts | stopped writing the event into the active run's history | `the kernel start entry > an event for an object with an active run goes into that run's history` |
| TK0026-M3 | packages/engine/src/trigger/kernel.ts | used the literal `$event.object` instead of the event's object | `the kernel start entry > a rule takes the event's object and its params reach the flow` |
| TK0026-M4 | packages/engine/src/plugin/registry.ts, packages/engine/src/trigger/kernel.ts | removed the step event type prefix check in both places | `the kernel start entry > ctx.emit starts a matched flow and a bad type is refused` |
| TK0026-M5 | packages/engine/src/kernel/decide.ts | disabled the hop-limit skip fact when a run ends | `the kernel start entry > hops stop after the ninth event and the history says why` |
| TK0026-M6 | packages/source-cron/src/index.ts | returned the minute after the last tick instead of the latest due minute | `the cron source > a three-hour gap emits only the latest tick` |
| TK0026-M7 | packages/engine/src/trigger/rules.ts | disabled the flow-exists check at load | `trigger rules > a rule whose flow does not exist is refused at load` |
| TK0026-M8 | packages/engine/src/trigger/kernel.ts | dropped the input id from the start metadata | `the kernel start entry > the start fact is caused by the recorded event` |

## TK0026 — rework 2: review fixes

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M9 | packages/engine/src/loop/serve.ts | started the tick request with `log.startRun` instead of the kernel entry | `serve loop > starts a run a plugin asks for on tick` |
| TK0026-M10 | packages/engine/src/loop/serve.ts, packages/engine/src/trigger/kernel.ts | emitted the run-end event before ending the run, and stopped ending it inside the emitter | `the kernel start entry > a recovered run emits its end event once and starts the chained flow` |
| TK0026-M11 | packages/engine/src/trigger/kernel.ts | dropped the global `trigger_observed` fact for an observed event | `the kernel start entry > observe records what it would have started` |
| TK0026-M12 | packages/engine/src/log/sqlite.ts | disabled the migration of a legacy `inputs.run_id TEXT NOT NULL` table | `a store from before global inputs is migrated on open` |
| TK0026-M13 | packages/engine/src/loop/serve.ts | skipped loading `triggers.json` for a kernel built inside `serveOnce` | `serve loop > recovery starts a run-end chain without a kernel argument` |

## TK0026 — rework 7: a run-end event survives the end of its run

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M14 | packages/engine/src/runner/service.ts | marked the run ended before recording its end event | `run-end recovery > a crash after the run is ended still records its end event` |

## TK0017 — the base shell plugin is a package of its own

| id | file | mutation | failing test |
|---|---|---|---|
| TK0017-M1 | packages/shell/src/index.ts | reported a non-zero exit as a pass | `shell/command > a non-zero exit is a failure with its code and output path` |
| TK0017-M2 | packages/shell/src/index.ts | kept running check lines after the first failure | `shell/check > stops at the first failure and names the line` |
| TK0017-M3 | packages/shell/src/index.ts | never compared a probe's exit code with the previous probe | `shell/probe > becomes ready when the exit code differs from the previous probe` |
| TK0017-M4 | packages/shell/src/index.ts | reported a timeout as a signal failure | `shell/command > a timeout is a failure that says so` |
| TK0017-M5 | packages/shell/src/index.ts | skipped the working-directory check, so a missing cwd became a spawn failure | `shell/command > a cwd that does not exist fails with a clear reason` (and the same check test) |
| TK0017-M6 | packages/shell/src/process.ts | kept 20 000 lines in the fact instead of 20 | `shell/command > megabytes of output land in the log and only the tail is in the fact` |
| TK0017-M7 | packages/engine/src/kernel/decide.ts | dropped the check params from the poll effect | `decide: tick > keeps a check's params in the poll effect` |
| TK0017-M8 | packages/engine/src/runner/runner.ts | ran a wait check without its params | `a flow through the runner > waits on shell/probe with its params` |
| TK0017-M9 | packages/shell/src/process.ts | signaled only the process group leader, not the group | `shell/command > a child that outlives the line is in the group and is stopped` |
| TK0017-M10 | packages/engine/src/runner/runner.ts | terminated a cancelled worker without asking it to stop its processes | `a flow through the runner > a run cancel stops the command's process group in a worker` |

## TK0017 — rework 3: bounded cleanup and injected time

| id | file | mutation | failing test |
|---|---|---|---|
| TK0017-M11 | packages/shell/src/process.ts | dropped the drain limit and waited for the output pipes to close | `shell/command > a child that leaves the group cannot hold the command open` (timed out) |
| TK0017-M12 | packages/shell/src/process.ts | sent the grace SIGKILL without checking that the group still exists | `runLine > the grace SIGKILL is not sent to a group that ended` |
| TK0017-M13 | packages/shell/src/index.ts | ignored the injected clock for `shell/command` | `shell/command > a timeout is a failure that says so` |
| TK0017-M14 | packages/shell/src/index.ts | passed no timeout to a `shell/check` line | `shell/check > a line that exceeds the timeout fails and names it` |

## TK0017 — rework 5: the group cannot end before the grace SIGKILL

| id | file | mutation | failing test |
|---|---|---|---|
| TK0017-M15 | packages/shell/src/process.ts | dropped the sentinel from the wrapper, so the group ends when the line exits | `runLine > the group outlives a finished line until the grace SIGKILL` |

## TK0017 — rework 11: the sentinel's trap before any signal, and env coverage

| id | file | mutation | failing test |
|---|---|---|---|
| TK0017-M16 | packages/shell/src/process.ts | left the line's stderr out of the log instead of folding it into the command's output | `shell/command > a non-zero exit is a failure with its code and output path` |
| TK0017-M17 | packages/shell/src/process.ts | passed only the step's `env` to the command, dropping the host environment | `shell/command > the host environment is still there when env is given` |
| TK0017-M18 | packages/shell/src/index.ts | stopped passing the step's `env` to the line runner | `shell/command > env is added to the command's environment` |
| TK0017-M19 | packages/shell/src/process.ts | removed the sentinel's TERM trap, so the stop's SIGTERM ends the group before the grace | `runLine > the sentinel survives the stop's SIGTERM` |

## TK0017 — rework 15: the stop's order and the trap have teeth

| id | file | mutation | failing test |
|---|---|---|---|
| TK0017-M20 | packages/shell/src/process.ts | removed the wait for the sentinel's `ready` before the stop's first signal | `runLine > a stop before ready waits for the sentinel's trap` |

## TK0025 — presentation views

| id | file | mutation | failing test |
|---|---|---|---|
| TK0025-M1 | packages/engine/src/views/presentation.ts | disabled the Promise check on `row` | `presentation views > a Promise or a slow row becomes an error row, not a crash` |
| TK0025-M2 | packages/engine/src/views/presentation.ts | wrapped a timed-out `load` in a generic section error | `presentation views > a section over the timeout and over the cap is reported` |
| TK0025-M3 | packages/engine/src/views/presentation.ts | removed the required-note check in `act` | `presentation views > runs actions with a required note and with confirmation` |
| TK0025-M4 | packages/engine/src/views/presentation.ts | removed the confirmation check in `act` | `presentation views > runs actions with a required note and with confirmation` |
| TK0025-M5 | packages/engine/src/plugin/registry.ts | dropped the warning for two plugins' clashing default keys | `presentation views > a key clash drops the later default and the action still runs` |
| TK0025-M6 | packages/engine/src/views/presentation.ts | removed the event stream's bound | `presentation views > events coalesce a repeated id and stay bounded for a slow consumer` |
| TK0025-M7 | packages/cli/src/main.ts | printed pending actions with `/` instead of `:` | `operad presentation commands > pending lists actions as plugin:action` |
| TK0025-M8 | packages/cli/src/main.ts | stopped colouring the two kernel flags | `operad presentation commands > colours follow only waiting and running` |
| TK0025-M9 | packages/engine/src/views/presentation.ts | only added the kernel history section when the plugin was loaded | `presentation views > an unknown id and an unloaded plugin's object are clear` |

## TK0025 — rework 2: colour, cross-process events and an injected clock

| id | file | mutation | failing test |
|---|---|---|---|
| TK0025-M10 | packages/cli/src/markdown.ts | made `renderMarkdown` ignore its `colour` option and always return plain text | `operad presentation commands > show styles Markdown for a terminal and stays plain otherwise` |
| TK0025-M11 | packages/engine/src/plugin/file-store.ts | stopped watching the store directory, leaving subscriptions process-local | `presentation views > events reach a reader when another store writes the object` |
| TK0025-M12 | packages/engine/src/log/jsonl.ts | stopped watching the runs directory, leaving subscriptions process-local | `presentation views > events reach a reader when another jsonl log appends` |
| TK0025-M13 | packages/engine/src/log/sqlite.ts | stopped watching the database directory, leaving subscriptions process-local | `presentation views > events reach a reader when another sqlite log appends` |
| TK0025-M14 | packages/engine/src/views/presentation.ts | measured a row with `Date.now` instead of the injected clock | `presentation views > a Promise or a slow row becomes an error row, not a crash` |
| TK0025-M15 | packages/engine/src/views/presentation.ts | sliced the section at an arbitrary byte instead of a UTF-8 boundary | `presentation views > a truncated section keeps every multibyte character whole` |

## TK0025 — rework 4: a poll fallback when no watch event arrives

| id | file | mutation | failing test |
|---|---|---|---|
| TK0025-M16 | packages/engine/src/log/sqlite.ts | never started the `PRAGMA data_version` poll | `sqlite.test.ts > a subscription learns of a write when the watch never fires` |
| TK0025-M17 | packages/engine/src/log/jsonl.ts | never started the run-file poll | `jsonl.test.ts > a subscription learns of a write when the watch never fires` |
| TK0025-M18 | packages/engine/src/log/sqlite.ts | reported every poll as unchanged instead of comparing `data_version` | `sqlite.test.ts > a subscription learns of a write when the watch never fires` |

## TK0025 — rework 6: the cross-process event tests really cross processes

| id | file | mutation | failing test |
|---|---|---|---|
| TK0025-M19 | packages/engine/test/fixtures/append-fact-child.ts | made the child write a different object, so only an in-process write could satisfy the reader | `presentation views > events reach a reader when another sqlite log appends` |

## TK0019 — dev objects, commands and actions

| id | file | mutation | failing test |
|---|---|---|---|
| TK0019-M1 | packages/dev/src/model.ts | stopped skipping headings inside a fenced block | `dev model > a fenced Rework heading is text, not a section` |
| TK0019-M2 | packages/dev/src/service.ts | took no repository lock, so two adds read the same next number | `dev plans and tasks > two task adds at once get distinct ids and lose nothing` |
| TK0019-M3 | packages/dev/src/service.ts | allowed a plan with no tasks to be confirmed | `dev plans and tasks > confirming a plan readies its proposed tasks; an empty plan is refused` |
| TK0019-M4 | packages/engine/src/plugin/registry.ts | made the action name alone its identity, so plan and task actions clashed | `dev actions > confirm is one name on a plan and on a task` |
| TK0019-M5 | packages/dev/src/service.ts | stopped collecting a running task's run id when a plan was cancelled | `dev plans and tasks > cancelling a plan cancels a running task and asks the kernel to cancel its run` |

## TK0019 — rework 3: default dev, per-repository ids and a durable lock

| id | file | mutation | failing test |
|---|---|---|---|
| TK0019-M6 | packages/engine/src/config/config.ts | installed only the shell plugin by default | `operad config > the default plugins are the shell plugin and dev` |
| TK0019-M7 | packages/dev/src/commands.ts | looked a task up by its bare id instead of the repository's store key in `task edit`/`task update` | `operad with the dev plugin > task edit and update resolve the repository like every other command` |
| TK0019-M8 | packages/dev/src/service.ts | dropped the cancelled-plan recheck inside `addTask`'s lock | `dev checks inside the lock > task add rechecks that its plan is not cancelled` |
| TK0019-M9 | packages/dev/src/service.ts | dropped the open-task recheck inside `removeRepository`'s lock | `dev checks inside the lock > repo remove rechecks that no task is open` |
| TK0019-M10 | packages/dev/src/service.ts | let `repositoryOf` return a repository marked removed | `dev checks inside the lock > a write refuses a repository that was removed` |
| TK0019-M11 | packages/dev/src/model.ts | made `storeKey` return the bare id, so two repositories shared one key | `dev per-repository ids > two repositories may both hold TK0001-work under different keys` |
| TK0019-M12 | packages/dev/src/service.ts | skipped the takeover of a lock whose pid is dead | `the dev lock survives a dead holder > a lock left by a dead pid is taken over` (timed out) |
| TK0019-M13 | packages/dev/src/service.ts | removed the source-checkout wording from `repo add`'s refusal | `repo add never writes into the operad checkout > the operad source checkout is refused` |

## TK0019 — rework 4: the lock protocol and scoped bare ids

| id | file | mutation | failing test |
|---|---|---|---|
| TK0019-M14 | packages/dev/src/lock.ts | release deleted the renamed lock before checking whose nonce it held | `the repository lock > release never deletes another process's lock` |
| TK0019-M15 | packages/dev/src/lock.ts | takeover deleted the renamed lock without comparing its nonce with the dead record's | `the repository lock > a newer live lock renamed during a takeover is put back` |
| TK0019-M16 | packages/dev/src/lock.ts | wrote the record to `dev.lock` before the link, so a crash between the two left a lock | `the repository lock > a crash between the tmp write and the link leaves no lock` |
| TK0019-M17 | packages/engine/src/views/presentation.ts | skipped the plugin's `resolve` hook before the suffix lookup | `operad with the dev plugin > a bare id resolves in the repository of the current directory` |
| TK0019-M18 | packages/dev/src/lock.ts | treated an unreadable lock as dead immediately instead of after 30 s | `the repository lock > an unparsable lock is live until its mtime is 30 seconds old` |

## TK0019 — rework 5: the missed event and the lock's open handles

| id | file | mutation | failing test |
|---|---|---|---|
| TK0019-M19 | packages/engine/src/plugin/file-store.ts | kept only the directory watch in a subscription and dropped the poll fallback | `the file plugin store > a subscription still reports a write the watch does not` |
| TK0019-M20 | packages/dev/src/lock.ts | left the wait's directory watch and fallback timer open when it finished | `the repository lock > a real wait closes its watch and its timer` |

## TK0026 — rework 10: a start survives a crash after its run exists

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M15 | packages/engine/src/loop/serve.ts | stopped adopting a pending start before spawning a run | `the kernel start entry > a crash after the run is created keeps the event that started it` |

## TK0026 — rework 14: the log alone decides an event's outcome

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M16 | packages/engine/src/trigger/kernel.ts | removed the log lookup that finds the run an input started | `event receipt recovery > a crash after startRun in auto mode keeps one outcome` |

## TK0026 — rework 15: one outcome per input, no sidecar

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M17 | packages/engine/src/log/jsonl.ts | made `recordOutcome` always append instead of returning the stored outcome | `event receipt recovery > two concurrent receives in observe mode keep one outcome` |

## TK0026 — rework 16: claim first, act second

| id | file | mutation | failing test |
|---|---|---|---|
| TK0026-M18 | packages/engine/src/trigger/kernel.ts | moved a candidate's start before its resolve claim | `event receipt recovery > dismiss and startCandidate race; exactly one wins` |

## TK0018 — the radian harness plugin

| id | file | mutation | failing test |
|---|---|---|---|
| TK0018-M1 | packages/harness-radian/src/index.ts | skipped the non-zero exit check, so exit 1 became `done` | `harness-radian/agent > a non-zero exit is a failure that says so` |
| TK0018-M2 | packages/harness-radian/src/index.ts | defaulted an absent Result cost to `{ micros: 0 }` instead of `null` | `harness-radian/agent > a Result record without a cost leaves the cost unknown, not zero` |
| TK0018-M3 | packages/harness-radian/src/process.ts | marked the wall-time stop as a stall | `harness-radian/agent > wallTimeSecs stops a run that never ends` |
| TK0018-M4 | packages/harness-radian/src/index.ts | sent a 1 MB prompt through argv instead of stdin | `harness-radian/agent > a prompt over 1 MB goes through stdin unchanged` |
| TK0018-M5 | packages/engine/src/runner/runner.ts | passed no flow params to a step | `harness-radian:prompt > runs the fake once with the prompt unchanged and ends with its result` |
| TK0018-M6 | packages/harness-radian/src/process.ts | skipped the PATH lookup, so a missing radian became a spawn failure | `harness-radian/agent > a radian that is not on PATH fails with a clear reason` |
| TK0018-M7 | packages/harness-radian/src/index.ts | treated a zero exit without a Result as success | `harness-radian/agent > a zero exit without a Result record is a failure that says so` |
| TK0018-M8 | packages/harness-radian/src/index.ts | classified a cancelled run as a failure instead of `interrupted` | `harness-radian/agent > cancel stops the process group and reports interrupted` |
| TK0018-M9 | packages/harness-radian/src/process.ts | stopped resetting the stall timer on each output line | `harness-radian/agent > no new output line for stallSecs stops the group` |

## TK0018 — rework 2: a failed spawn settles and output stays bounded

| id | file | mutation | failing test |
|---|---|---|---|
| TK0018-M10 | packages/harness-radian/src/process.ts | `finish()` waited only for `exit`, which a failed spawn never emits | `harness-radian/agent > a spawn failure after the cwd check settles as a failure, not a hang` (timed out after 5000ms) |
| TK0018-M11 | packages/harness-radian/src/process.ts | multiplied the longest-line bound by 1024, removing any practical bound on an unterminated stream | `harness-radian/agent > an unterminated output stream is stopped, not buffered forever` (never settled; the buffer kept growing) |
| TK0018-M12 | packages/harness-radian/src/index.ts | recorded an over-long line as a signal exit instead of `line_too_long` | `harness-radian/agent > an unterminated output stream is stopped, not buffered forever` (`exit` instead of `line_too_long`) |

## TK0018 — rework 3: the JSONL log applies backpressure

| id | file | mutation | failing test |
|---|---|---|---|
| TK0018-M13 | packages/harness-radian/src/jsonl-log.ts | `push` flushed a full buffer without returning the pending write, so the caller never waited | `jsonl log > a full buffer returns the write the caller must wait for` |
| TK0018-M14 | packages/harness-radian/src/process.ts | `Lines.push` delivered every line of a chunk without waiting for the line handler | `harness-radian/agent > a line handler that is still busy stops the reader from reading ahead` |

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

## TK0012 — serve runs steps

| id | file | mutation | failing test |
|---|---|---|---|
| TK0012-M1 | packages/engine/src/flow/validate.ts | stopped counting `interrupted` as a possible result of an unsafe step | `validateFlow > requires an interrupted edge for every unsafe step` |
| TK0012-M2 | packages/dev/flows/dev.flow.ts | removed the `worktree` step's `interrupted` edge | `the dev flow > loads with the gate and the rework edges` |
| TK0012-M3 | packages/engine/src/loop/serve.ts | treated every `running` run as a crash, so a freshly requested effect was recovered instead of run | `serve loop > a recorded answer runs the next step in serve's process` |
| TK0012-M4 | packages/dev/src/schedule.ts | stopped reconciling a waiting task with the runs in the log, so an orphaned task was never repaired | `dev scheduling > serve repairs a task whose run ended without an edge, and reject runs again` |
| TK0012-M5 | packages/harness-radian/src/process.ts | stopped pausing the stall timer while a tool call was open | `harness-radian/agent > an open tool call pauses the stall timer until it settles` |
| TK0012-M6 | packages/engine/src/runner/runner.ts | recorded pid 0 on the step-start fact instead of the executing process | `operad with the dev plugin > dev:reject from the CLI records, and serve runs the next step` |
