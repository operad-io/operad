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
