# Mutation records — `engine`

Rows whose mutation broke code in `packages/engine/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

## TK0012 — rework 2: wait for the writer without polling

| id | file | mutation | failing test |
|---|---|---|---|
| TK0012-M9 | `packages/engine/src/platform/sqlite-open.ts` | `enableWal` rethrew `SQLITE_BUSY` instead of waiting for the other writer through the busy handler | `switching to WAL waits while another process holds the database` (TK0008 replaced the 100 ms hold with a release the test sends once the opener reports SQLITE_BUSY; the old name was `opening waits while another process holds the store`) |

## TK0016 — rework 4: a failure is never recorded as a success result

| id | file | mutation | failing test |
|---|---|---|---|
| TK0016-M18 | packages/engine/src/runner/runner.ts | removed the `preferInterrupted` early return from `chooseFailure`, so a failed check was named "failed", which a wait step does not accept; the failure was never recorded and the run stayed blocked (re-recorded in TK0008: it does not report a success result) | `runner > a check that throws is not recorded as ready` |

## TK0017 — rework 3: bounded cleanup and injected time

| id | file | mutation | failing test |
|---|---|---|---|
| TK0017-M12 | packages/engine/src/platform/process-group.ts | sent the grace SIGKILL without checking `sentinelExited()` (the check replaced the removed `groupExists` one; re-recorded in TK0008, with the test it never had) | `process groups > nothing is signaled after the sentinel exits` |

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

## T-0019-http-api — rework 3: SSE ids, stream limits, rotation and the HTTP confirm hint

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M10 | packages/engine/src/http/server.ts | the resume check ignored the boot id, so an id from an earlier serve looked current | `http server > a Last-Event-ID from an earlier serve gets one reset` |
| T-0019-http-api-M11 | packages/engine/src/http/server.ts | `push` accepted every event, so a client that stopped reading kept an unbounded queue | `http server > ends a client that stops reading instead of growing without bound` |
| T-0019-http-api-M12 | packages/engine/src/http/server.ts | the token watcher noticed a rotation but did not end the open streams | `http server > rotating the token ends the event streams opened with the old one` |
| T-0019-http-api-M13 | packages/engine/src/http/server.ts | `Bun.serve` got a body limit eight times the protocol's | `http server > refuses a request body larger than one mebibyte` |
| T-0019-http-api-M14 | packages/engine/src/views/presentation.ts | the confirm refusal always said `pass --yes`, also over HTTP | `http server > acts with a note, refuses without one, and needs confirmed for a confirm action` |

## T-0019-http-api — rework 5: the act body's optional id

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M16 | packages/engine/src/http/server.ts | made `POST /v1/act` require an id again, so the handler answered `400` before the views could name the missing object | `http server > accepts an act body without an id and lets the views name the missing object` |

## T-0020 — pairing, links and the notification hook

| id | file | mutation | failing test |
|---|---|---|---|
| T-0020-M1 | packages/engine/src/notify/notify.ts | dropped the `recorded.has(key)` skip, so every pass notified again | `notify > a restart of serve does not notify again for the same wait` |
| T-0020-M2 | packages/engine/src/notify/notify.ts | the notification key left out the wait id | `notify > a new wait on the same run notifies again` |
| T-0020-M3 | packages/engine/src/notify/notify.ts | a cancelled command was recorded as sent | `notify > stopping serve cancels a running command and records nothing` |
| T-0020-M4 | packages/engine/src/http/link.ts | `objectLink` stopped URL-encoding the id | `http server > an object carries its link, URL-encoded, and so does its pending item` |
| T-0020-M8 | packages/engine/src/notify/notify.ts | `OPERAD_LINK` left out of the command's environment | `notify > a waiting task runs the command once with the four variables` |
| T-0020-M9 | packages/engine/src/config/config.ts | `notify.on` accepted any value | `operad config > rejects a malformed notify section` |
| TK0008-M2 | `packages/engine/src/platform/sqlite-open.ts` | `enableWal` returned whatever mode SQLite answered instead of failing when it is not wal | `a database that cannot be WAL is an error, not a loop` |
| TK0008-M3 | `packages/engine/src/flow/validate.ts` | wrote a step's `next` edges with `next[result] = target`, which drops a result named `__proto__` | `validateFlow > accepts a result named __proto__` |
| TK0008-M4 | `packages/engine/src/log/jsonl.ts` | `parseFact` stopped checking that a fact line carries a JSON payload | `a fact line without a payload is a corrupt log, not a fact with no payload` |
| TK0008-M5 | `packages/engine/src/plugin/registry.ts` | accepted a plugin command named like a kernel verb | `plugin registry validation > refuses a plugin command that shares a name with a kernel verb` |
| TK0008-M6 | `packages/engine/src/plugin/registry.ts` | `pending` skipped a waiting run whose object is missing from the store | `plugin registry validation > pending keeps a waiting run whose object is missing from the store` |
| TK0008-M7 | `packages/engine/src/runner/service.ts` | `parseObjectKey` read `flow:<plugin>/<flow>` as a real object | `serve loop > a run started without an object has no object` |
| TK0008-M8 | `packages/engine/src/config/config.ts` | `init` no longer added the default plugins to a config that names none | `operad config > init adds the default plugins to a config that names none` |
| TK0008-M9 | `packages/engine/src/config/config.ts` | an older config's moved module name was not mapped | `operad config > an older config's moved module name still loads` |
| TK0008-M11 | `packages/engine/src/views/presentation.ts` | the named repository was not handed to a type's resolver | `operad with the dev plugin > show and an action take --repo for a bare id from outside any repository` |
| TK0008-M12 | `packages/engine/src/trigger/kernel.ts` | `realizeStart` dropped the access profile when it created the run | `run access profile > a run a plugin starts on tick records the profile in the log` |
| TK0008-M13 | `packages/engine/src/kernel/decide.ts` | the poll_check effect left out the wait's params | `decide: tick > a poll_check effect carries the wait's check params` |
| TK0008-M14 | `packages/engine/src/kernel/decide.ts` | an unexpected result dropped what the step said | `decide: step_result > an undeclared result keeps what the step said` |
| TK0008-M15 | `packages/engine/src/runner/runner.ts` | `WORKER_ABORT_GRACE_MS` back to 1000 ms, not above two process-group graces | `runner > an aborted worker gets longer than the slowest process-group stop` |

| id | file | mutation | failing test |
|---|---|---|---|
| TK0013-M1 | packages/engine/src/flow/validate.ts | inverted the missing-edge check (`!hasOwn` → `hasOwn`) | `validateFlow > names a result with no edge` |
| TK0013-M2 | packages/engine/src/flow/validate.ts | unknown plugin step type fell back to an empty result list instead of an error | `validateFlow > names an unknown plugin step type` |
| TK0013-M3 | packages/engine/src/flow/validate.ts | disabled the unreachable-step check | `validateFlow > names an unreachable step` |
| TK0013-M4 | packages/engine/src/flow/load.ts | dropped the file name from the import-error message | `loadFlow > names the file when a module throws on import` |
| TK0013-M5 | packages/engine/src/flow/define-flow.ts | removed the `wait_person` result-name check | `tsc -b`: `define-flow.test.ts(51,7): Unused '@ts-expect-error' directive` |
| TK0013-M6 | packages/engine/src/flow/validate.ts | disabled the duplicate-id check | `validateFlow > names duplicate step ids` |
| TK0013-M7 | packages/engine/src/flow/validate.ts | restored the fallback from `dev/command` to the unqualified `command` | `validateFlow > matches a plugin step type by its full name only` |
| TK0011-M1 | `packages/engine/src/log/jsonl.ts` | `truncateTornLine` returned immediately, so a torn final line stayed on disk | `log backend: jsonl > a torn last line is cut off on open` |
| TK0011-M2 | `packages/engine/src/log/jsonl.ts` | `append` skipped the `expectedSeq` comparison | `log backend: jsonl > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0011-M3 | `packages/engine/src/log/secret.ts`, `packages/engine/src/log/json-value.ts` | `Secret.toJSON` returned the value and the JSON walker stopped rejecting `Secret` | `log backend: jsonl > a Secret never reaches the log` |
| TK0011-M4 | `packages/engine/src/log/jsonl.ts` | `recordInput` ignored the dedupe index | `log backend: jsonl > recordInput stores one record per (source, sourceKey)` |
| TK0011-M5 | `packages/engine/src/log/jsonl.ts` | `startRun` stopped refusing an active flow/object pair | `log backend: jsonl > startRun keeps one active run per flow and object` |
| TK0011-M6 | `packages/engine/src/log/jsonl.ts` | `ensureSchema` stopped refusing a newer `schema_version` | `log backend: jsonl > a newer schema_version is refused with a clear error` |
| TK0011-M7 | `packages/engine/src/log/jsonl.ts` | `#rebuildInputs` recorded the file size from `statSync` instead of the bytes it had read | `opening a store does not miss an input appended during the rebuild` |
| TK0011-M8 | `packages/engine/src/log/json-value.ts` | the JSON walker stopped rejecting a callable `toJSON` | `log backend: jsonl > a payload with a toJSON method is refused and writes nothing` |
| TK0014-M1 | `packages/engine/src/kernel/decide.ts` | made the visit limit unreachable (`visit > Number.MAX_SAFE_INTEGER`) | `decide: visits > ends the run when a step is entered past the default maxVisits` |
| TK0014-M2 | `packages/engine/src/kernel/decide.ts` | changed the crash-loop stop from `>=` to `>` | `decide: recover > requests a safe step again and stops after three recoveries` |
| TK0014-M3 | `packages/engine/src/kernel/decide.ts` | treated every step as replay-safe on recover | `decide: recover > interrupts an unsafe step and leaves it` |
| TK0014-M4 | `packages/engine/src/kernel/decide.ts` | skipped the declared-result check | `decide: step_result > turns an undeclared result into an interrupted failure` |
| TK0014-M5 | `packages/engine/src/kernel/decide.ts` | inverted the timed-wait comparison (`now > due` returned early) | `decide: tick > does nothing before a timed wait is due` |
| TK0014-M6 | `packages/engine/src/kernel/decide.ts` | removed the step_result effect id/status/step guard | `decide: step_result > ignores a result for an unknown effect` |
| TK0014-M7 | `packages/engine/src/kernel/state.ts` | recorded a completed result as still `outstanding` | `evolve: each fact kind > step_result records the result once` |
| TK0012-M1 | `packages/engine/src/log/sqlite.ts` | `append` skipped the `expectedSeq` comparison | `log backend: sqlite > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0012-M2 | `packages/engine/src/log/sqlite.ts` | `startRun` stopped refusing an active flow/object pair; the partial unique index still rejected the insert | `log backend: sqlite > startRun keeps one active run per flow and object` |
| TK0012-M3 | `packages/engine/src/log/sqlite.ts` | `ensureSchema` stopped refusing a newer `schema_version` | `log backend: sqlite > a newer schema_version is refused with a clear error` |
| TK0012-M4 | `packages/engine/src/log/sqlite.ts` | `recordInput` used `INSERT OR REPLACE`, so a duplicate reported `duplicate: false` | `log backend: sqlite > recordInput stores one record per (source, sourceKey)` |
| TK0012-M5 | `packages/engine/src/log/sqlite.ts` | `read` stopped reporting a missing run | `log backend: sqlite > a run file deleted by hand makes read fail without touching other runs` |
| TK0012-M6 | `packages/engine/src/log/sqlite.ts` | `read` ordered facts newest first | `log backend: sqlite > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0012-M7 | `packages/engine/src/log/sqlite.ts` | open errors were rethrown unwrapped, so a read-only directory surfaced a raw SQLite error | `opening a store in a read-only directory fails with a clear error` |
| TK0012-M8 | `packages/engine/src/log/sqlite.ts` | `endRun` threw on an already-ended run | `log backend: sqlite > endRun is idempotent, unknown runs fail, and an ended run takes no facts` |
| TK0012-M9 | `packages/engine/src/platform/sqlite-open.ts` | `enableWal` rethrew `SQLITE_BUSY` instead of waiting for the other writer through the busy handler | `opening waits while another process holds the store` |
| TK0015-M1 | packages/engine/src/plugin/registry.ts | removed the duplicate plugin-name check | `plugin registry validation > rejects two plugins with the same name` |
| TK0015-M2 | packages/engine/src/plugin/registry.ts | removed the try/catch around an action's `when` | `plugin registry validation > hides and logs an action whose when throws` |
| TK0015-M3 | packages/engine/src/plugin/registry.ts | called the flow loader without the loaded step types | `plugin registry > gives the flow loader the loaded step types` |
| TK0015-M4 | packages/engine/src/plugin/registry.ts | removed the `operadPlugin` version check | `plugin registry validation > rejects a plugin with an unsupported API version` |
| TK0015-M5 | packages/engine/src/plugin/registry.ts | disabled the short-command clash check between plugins | `plugin registry validation > rejects two plugins that declare the same short command` |
| TK0015-M6 | packages/engine/src/plugin/registry.ts | skipped the check that a step returned a declared result | `plugin registry validation > rejects a step that returns a result it did not declare` |
| TK0015-M7 | packages/engine/src/plugin/store.ts | stopped appending a fact when an object is put | `plugin registry > runs the test plugin's step, command and action end to end` |
| TK0016-M1 | packages/engine/src/runner/service.ts | dropped the run id from the input key, so the second run's start was a duplicate | `operad command > pending, running and history answer in user words` |
| TK0016-M2 | packages/engine/src/runner/runner.ts | returned `ok` from the wall-time branch instead of a declared failure | `runner > a step that never ends becomes a failed result` |
| TK0016-M3 | packages/engine/src/runner/lock.ts | treated every existing lock as held, ignoring a dead PID | `runner > the run lock keeps one runner per run and clears a stale pid` |
| TK0016-M4 | packages/engine/src/loop/serve.ts | removed the due-time check, so a wait was woken early | `serve loop > does not wake a wait before it is due` |
| TK0016-M5 | packages/engine/src/views/history.ts | dropped the words for an interrupted unsafe step | `serve loop > recovers an unsafe run into a person wait, and an action ends it` |
| TK0016-M6 | packages/engine/src/views/pending.ts | suppressed the plugin actions on a waiting run | `operad command > pending, running and history answer in user words` |
| TK0016-M7 | packages/engine/src/config/config.ts | ignored the sqlite backend and always chose jsonl | `operad config > reads plugins and a sqlite store with a relative path` |
| TK0016-M8 | packages/engine/src/runner/service.ts | stopped ending the log run when the run ended | `runner > drives a run to the end, one batch per input` |
| TK0016-M9 | packages/engine/src/runner/service.ts | treated every recorded input as applied, even when no fact used it | `runner > an input recorded before a crash is applied on recovery` |
| TK0016-M10 | packages/engine/src/runner/runner.ts | replaced the wall-time message with a generic one | `runner > a synchronous step is stopped by the wall time` |
| TK0016-M11 | packages/engine/src/config/config.ts | installed no default plugin | `operad command > init creates the home and prints each plugin check` |
| TK0016-M12 | packages/engine/src/loop/serve.ts | stopped listening for the abort while sleeping | `serve loop > a sleeping loop ends as soon as the signal aborts` |
| TK0016-M15 | packages/engine/src/plugin/file-store.ts | stopped refreshing a reader from the file | `the file plugin store > a second reader sees facts another writer appended` |
| TK0016-M16 | packages/engine/src/plugin/builtin/shell.ts | reported a non-zero exit as success | `the base shell plugin > a command that exits non-zero is a failed result` (removed) |
| TK0016-M17 | packages/engine/src/runner/runner.ts | made `chooseFailure` fall back to the step's first declared result instead of naming the failure | `runner > a step that throws is not recorded as its success result` |
| TK0026-M1 | packages/engine/src/trigger/kernel.ts | ignored the stored result of a duplicate event and routed it again | `the kernel start entry > the same event twice records one input and starts one run` |
| TK0026-M2 | packages/engine/src/trigger/kernel.ts | stopped writing the event into the active run's history | `the kernel start entry > an event for an object with an active run goes into that run's history` |
| TK0026-M3 | packages/engine/src/trigger/kernel.ts | used the literal `$event.object` instead of the event's object | `the kernel start entry > a rule takes the event's object and its params reach the flow` |
| TK0026-M4 | packages/engine/src/plugin/registry.ts, packages/engine/src/trigger/kernel.ts | removed the step event type prefix check in both places | `the kernel start entry > ctx.emit starts a matched flow and a bad type is refused` |
| TK0026-M5 | packages/engine/src/kernel/decide.ts | disabled the hop-limit skip fact when a run ends | `the kernel start entry > hops stop after the ninth event and the history says why` |
| TK0026-M7 | packages/engine/src/trigger/rules.ts | disabled the flow-exists check at load | `trigger rules > a rule whose flow does not exist is refused at load` |
| TK0026-M8 | packages/engine/src/trigger/kernel.ts | dropped the input id from the start metadata | `the kernel start entry > the start fact is caused by the recorded event` |
| TK0026-M9 | packages/engine/src/loop/serve.ts | started the tick request with `log.startRun` instead of the kernel entry | `serve loop > starts a run a plugin asks for on tick` |
| TK0026-M10 | packages/engine/src/loop/serve.ts, packages/engine/src/trigger/kernel.ts | emitted the run-end event before ending the run, and stopped ending it inside the emitter | `the kernel start entry > a recovered run emits its end event once and starts the chained flow` |
| TK0026-M11 | packages/engine/src/trigger/kernel.ts | dropped the global `trigger_observed` fact for an observed event | `the kernel start entry > observe records what it would have started` |
| TK0026-M12 | packages/engine/src/log/sqlite.ts | disabled the migration of a legacy `inputs.run_id TEXT NOT NULL` table | `a store from before global inputs is migrated on open` |
| TK0026-M13 | packages/engine/src/loop/serve.ts | skipped loading `triggers.json` for a kernel built inside `serveOnce` | `serve loop > recovery starts a run-end chain without a kernel argument` |
| TK0026-M14 | packages/engine/src/runner/service.ts | marked the run ended before recording its end event | `run-end recovery > a crash after the run is ended still records its end event` |
| TK0017-M6 | packages/engine/src/platform/process-group.ts | kept 20 000 lines in the fact instead of 20 | `shell/command > megabytes of output land in the log and only the tail is in the fact` |
| TK0017-M7 | packages/engine/src/kernel/decide.ts | dropped the check params from the poll effect | `decide: tick > keeps a check's params in the poll effect` |
| TK0017-M8 | packages/engine/src/runner/runner.ts | ran a wait check without its params | `a flow through the runner > waits on shell/probe with its params` |
| TK0017-M9 | packages/engine/src/platform/process-group.ts | signaled only the process group leader, not the group | `shell/command > a child that outlives the line is in the group and is stopped` |
| TK0017-M10 | packages/engine/src/runner/runner.ts | terminated a cancelled worker without asking it to stop its processes | `a flow through the runner > a run cancel stops the command's process group in a worker` |
| TK0017-M11 | packages/engine/src/platform/process-group.ts | dropped the drain limit and waited for the output pipes to close | `shell/command > a child that leaves the group cannot hold the command open` (timed out) |
| TK0017-M12 | packages/engine/src/platform/process-group.ts | sent the grace SIGKILL without checking that the group still exists | `process groups > the grace SIGKILL is not sent to a group that ended` |
| TK0017-M15 | packages/engine/src/platform/process-group.ts | dropped the sentinel from the wrapper, so the group ends when the line exits | `process groups > the group outlives a finished line until the grace SIGKILL` |
| TK0017-M16 | packages/engine/src/platform/process-group.ts | left the line's stderr out of the log instead of folding it into the command's output | `shell/command > a non-zero exit is a failure with its code and output path` |
| TK0017-M17 | packages/engine/src/platform/process-group.ts | passed only the step's `env` to the command, dropping the host environment | `shell/command > the host environment is still there when env is given` |
| TK0017-M19 | packages/engine/src/platform/process-group.ts | removed the sentinel's TERM trap, so the stop's SIGTERM ends the group before the grace | `process groups > the sentinel survives the stop's SIGTERM` |
| TK0017-M20 | packages/engine/src/platform/process-group.ts | removed the wait for the sentinel's `ready` before the stop's first signal | `process groups > a stop before ready waits for the sentinel's trap` |
| TK0025-M1 | packages/engine/src/views/presentation.ts | disabled the Promise check on `row` | `presentation views > a Promise or a slow row becomes an error row, not a crash` |
| TK0025-M2 | packages/engine/src/views/presentation.ts | wrapped a timed-out `load` in a generic section error | `presentation views > a section over the timeout and over the cap is reported` |
| TK0025-M3 | packages/engine/src/views/presentation.ts | removed the required-note check in `act` | `presentation views > runs actions with a required note and with confirmation` |
| TK0025-M4 | packages/engine/src/views/presentation.ts | removed the confirmation check in `act` | `presentation views > runs actions with a required note and with confirmation` |
| TK0025-M5 | packages/engine/src/plugin/registry.ts | dropped the warning for two plugins' clashing default keys | `presentation views > a key clash drops the later default and the action still runs` |
| TK0025-M6 | packages/engine/src/views/presentation.ts | removed the event stream's bound | `presentation views > events coalesce a repeated id and stay bounded for a slow consumer` |
| TK0025-M9 | packages/engine/src/views/presentation.ts | only added the kernel history section when the plugin was loaded | `presentation views > an unknown id and an unloaded plugin's object are clear` |
| TK0025-M11 | packages/engine/src/plugin/file-store.ts | stopped watching the store directory, leaving subscriptions process-local | `presentation views > events reach a reader when another store writes the object` |
| TK0025-M12 | packages/engine/src/log/jsonl.ts | stopped watching the runs directory, leaving subscriptions process-local | `presentation views > events reach a reader when another jsonl log appends` |
| TK0025-M13 | packages/engine/src/log/sqlite.ts | stopped watching the database directory, leaving subscriptions process-local | `presentation views > events reach a reader when another sqlite log appends` |
| TK0025-M14 | packages/engine/src/views/presentation.ts | measured a row with `Date.now` instead of the injected clock | `presentation views > a Promise or a slow row becomes an error row, not a crash` |
| TK0025-M15 | packages/engine/src/views/presentation.ts | sliced the section at an arbitrary byte instead of a UTF-8 boundary | `presentation views > a truncated section keeps every multibyte character whole` |
| TK0025-M16 | packages/engine/src/log/sqlite.ts | never started the `PRAGMA data_version` poll | `sqlite.test.ts > a subscription learns of a write when the watch never fires` |
| TK0025-M17 | packages/engine/src/log/jsonl.ts | never started the run-file poll | `jsonl.test.ts > a subscription learns of a write when the watch never fires` |
| TK0025-M18 | packages/engine/src/log/sqlite.ts | reported every poll as unchanged instead of comparing `data_version` | `sqlite.test.ts > a subscription learns of a write when the watch never fires` |
| TK0025-M19 | packages/engine/test/fixtures/append-fact-child.ts | made the child write a different object, so only an in-process write could satisfy the reader | `presentation views > events reach a reader when another sqlite log appends` |
| TK0019-M4 | packages/engine/src/plugin/registry.ts | made the action name alone its identity, so plan and task actions clashed | `dev actions > confirm is one name on a plan and on a task` |
| TK0019-M6 | packages/engine/src/config/config.ts | installed only the shell plugin by default | `operad config > the default plugins are the shell plugin and dev` |
| TK0019-M14 | packages/engine/src/platform/file-lock.ts | release deleted the renamed lock before checking whose nonce it held | `the lock file > release never deletes another process's lock` |
| TK0019-M15 | packages/engine/src/platform/file-lock.ts | takeover deleted the renamed lock without comparing its nonce with the dead record's (also T-0065-M4) | `the lock file > a newer live lock renamed during a takeover is put back` |
| TK0019-M16 | packages/engine/src/platform/file-lock.ts | wrote the record to `dev.lock` before the link, so a crash between the two left a lock | `the lock file > a crash between the tmp write and the link leaves no lock` |
| TK0019-M17 | packages/engine/src/views/presentation.ts | skipped the plugin's `resolve` hook before the suffix lookup | `operad with the dev plugin > a bare id resolves in the repository of the current directory` |
| TK0019-M18 | packages/engine/src/platform/file-lock.ts | treated an unreadable lock as dead immediately instead of after 30 s | `the lock file > an unparsable lock is live until its mtime is 30 seconds old` |
| TK0019-M19 | packages/engine/src/plugin/file-store.ts | kept only the directory watch in a subscription and dropped the poll fallback | `the file plugin store > a subscription still reports a write the watch does not` |
| TK0019-M20 | packages/engine/src/platform/watch.ts | left the wait's directory watch and fallback timer open when it finished | `the lock file > a real wait closes its watch and its timer` |
| TK0026-M15 | packages/engine/src/loop/serve.ts | stopped adopting a pending start before spawning a run | `the kernel start entry > a crash after the run is created keeps the event that started it` |
| TK0026-M16 | packages/engine/src/trigger/kernel.ts | removed the log lookup that finds the run an input started | `event receipt recovery > a crash after startRun in auto mode keeps one outcome` |
| TK0026-M17 | packages/engine/src/log/jsonl.ts | made `recordOutcome` always append instead of returning the stored outcome | `event receipt recovery > two concurrent receives in observe mode keep one outcome` |
| TK0026-M18 | packages/engine/src/trigger/kernel.ts | moved a candidate's start before its resolve claim | `event receipt recovery > dismiss and startCandidate race; exactly one wins` |
| TK0018-M5 | packages/engine/src/runner/runner.ts | passed no flow params to a step | `harness-radian:prompt > runs the fake once with the prompt unchanged and ends with its result` |
| TK0028-M1 | packages/engine/src/plugin/paging.ts | made `matchesWhere` accept every object | `object list > filters on an indexed field (jsonl)` |
| TK0028-M2 | packages/engine/src/plugin/file-store.ts | stopped comparing a list cursor`s object type | `object list > refuses a cursor from another object type (jsonl)` |
| TK0028-M3 | packages/engine/src/plugin/action-schema.ts | skipped the enum check in `validateActionArgs` | `operad presentation commands > an enum argument is listed in help and validated` |
| TK0028-M4 | packages/engine/src/kernel/decide.ts | wrote `actor: null` into `person_answered` | `decide: person_answer > records who answered in person_answered` |
| TK0028-M5 | packages/engine/src/plugin/file-store.ts | made `subscribeFacts` ignore its cursor | `object facts > a subscription after a cursor gets only later facts (jsonl)` |
| TK0028-M6 | packages/engine/src/plugin/registry.ts | left the actor out of the action`s fact | `plugin registry > records who asked in the action's fact` |
| TK0028-M7 | packages/engine/src/plugin/file-store.ts | made a fact unsubscribe remove only the listener, never stopping the shared watcher | `store lifecycle and concurrency > stops the watcher when the last fact subscription ends` |
| TK0028-M8 | packages/engine/src/plugin/sqlite-store.ts | treated a declared empty index as an undeclared type | `store lifecycle and concurrency > refuses any filter when the type declares an empty index (sqlite)` |
| TK0028-M9 | packages/engine/src/runner/step-worker.ts | opened a JSONL store in the worker instead of the configured backend | `runner > a worker step writes to the configured sqlite store` |
| TK0028-M10 | packages/engine/src/plugin/file-store.ts | removed the append lock and took the next sequence from the stale entry count | `store lifecycle and concurrency > two jsonl writers assign unique, contiguous sequences` |
| TK0028-M11 | packages/engine/src/plugin/sqlite-store.ts | stopped polling for facts another connection committed | `store lifecycle and concurrency > a sqlite subscription sees a fact another connection appended` |
| TK0028-M13 | packages/engine/src/plugin/action-schema.ts | accepted a `role: "note"` property without type `"string"` | `plugin registry validation > rejects a note property that is not a string` |
| TK0028-M14 | packages/engine/src/plugin/registry.ts | left the actor out of the action context | `plugin registry > an action receives the person's actor` |
| TK0029-M1 | packages/engine/src/plugin/settings.ts | stopped filling declared defaults into an absent settings field | `plugin settings > fills declared defaults and gives the step a read-only section` |
| TK0029-M2 | packages/engine/src/plugin/settings.ts | made `deepFreeze` return the value without freezing it | `plugin settings > fills declared defaults and gives the step a read-only section` |
| TK0029-M3 | packages/engine/src/plugin/secrets.ts | wrote the secret file with mode 0644 instead of 0600 | `plugin secrets > set/get round-trips and writes 0600 in a 0700 directory` |
| TK0029-M4 | packages/engine/src/plugin/registry.ts | skipped every `requires` check | `plugin requires > refuses a plugin whose required plugin is missing` |
| TK0029-M5 | packages/engine/src/plugin/registry.ts | accepted every access profile field instead of refusing an unenforced one | `run access profile > refuses a field no step of the flow enforces, naming the field and step` |
| TK0029-M6 | packages/engine/src/plugin/load.ts | loaded a plugin even when its config entry said `enabled: false` | `plugin enable and disable > a disabled plugin is not loaded and its objects return after enable` |
| TK0029-M7 | packages/engine/src/kernel/decide.ts | dropped the access profile from the `run_started` fact | `run access profile > accepts a field one step of the flow enforces and gives it to every step` |
| TK0029-M9 | packages/engine/src/log/sqlite.ts | left a schema_version 1 store refused instead of adding `runs.access` | `opens a schema_version 1 store and adds the access column` |
| TK0029-M10 | packages/engine/src/log/jsonl.ts | left a schema_version 1 store refused instead of upgrading the marker | `opens a schema_version 1 store and upgrades the marker` |
| TK0029-M11 | packages/engine/src/config/config.ts | turned a null settings section into `{}` | `plugin settings > a null settings section refuses the plugin instead of becoming an empty object` |
| TK0029-M12 | packages/engine/src/plugin/registry.ts | accepted a null access profile as absent | `run access profile > refuses a null profile, which is not an access object` |
| TK0029-M13 | packages/engine/test/fixtures/plugins/secret-notes.ts | wrote the secret value into the step's fact | `plugin secrets > a run that uses a secret leaves it out of facts, history, environment and log files` |
| TK0026-M19 | packages/engine/src/trigger/kernel.ts | derived the emitting plugin from the event type instead of the caller | `the kernel start entry > emitStep checks the type against the caller's plugin, not the type` |
| TK0026-M20 | packages/engine/src/log/jsonl.ts | skipped the unique-key lookup, so a duplicate observe appended a second fact | `event receipt recovery > two processes delivering the same observe event write one fact (jsonl)` |
| TK0026-M21 | packages/engine/src/log/sqlite.ts | skipped the unique-key lookup, so a duplicate observe hit the unique index | `event receipt recovery > two processes delivering the same observe event write one fact (sqlite)` |
| TK0027-M1 | packages/engine/src/trigger/rules.ts | stopped removing plugin rules whose source and type a user rule names | `trigger rules > a user rule replaces every plugin rule with the same source and type` |
| TK0027-M2 | packages/engine/src/trigger/rules.ts | kept a later plugin's rule for a pair an earlier plugin already owns | `trigger rules > a later plugin's rule for the same pair is skipped and both are named` |
| TK0027-M3 | packages/engine/src/plugin/registry.ts | skipped validating the rules a plugin ships | `trigger rules > an invalid plugin rule is refused at load with the plugin name and index` |
| TK0027-M4 | packages/engine/src/plugin/registry.ts | stopped checking that a plugin rule's flow is loaded | `trigger rules > a plugin rule whose flow does not exist is refused at load` |
| TK0027-M7 | packages/engine/src/trigger/rules.ts | cast a rule's `start.params` without the log's JSON-value check | `trigger rules > a plugin rule whose params are not JSON is refused at load with the plugin name and index` |
| TK0027-M8 | packages/engine/src/trigger/rules.ts | joined source and type with a NUL instead of a JSON pair | `trigger rules > distinct source and type pairs are not confused when they contain a NUL` |
| TK0027-M9 | packages/engine/src/trigger/rules.ts | treated an explicitly undefined `start.params` as if the key were absent | `trigger rules > a plugin rule with an explicitly undefined params is refused at load` |
| TK0027-M10 | packages/engine/src/trigger/rules.ts | checked `start.params` through a second property read instead of the captured value | `trigger rules > a plugin rule's params are read once and the checked value is the one kept` |
| TK0027-M11 | packages/engine/src/trigger/rules.ts | checked the params but returned the original, accessor-bearing object | `trigger rules > a nested getter's params are frozen into a plain JSON snapshot at load` |
| TK0029-M14 | packages/engine/src/plugin/load.ts | treated every access error as a missing config file, not just `ENOENT` | `loadPluginRegistry > reports an unreadable config file instead of loading nothing` |
| TK0030-M1 | `packages/engine/test/fixtures/sqlite-hold.ts` | removed the holder's busy timeout, so its `COMMIT` returned `SQLITE_BUSY` when the opener's busy handler briefly held a shared lock | `opening waits while another process holds the store` (1 failure in 50 runs under load) |
| TK0024-M3 | packages/engine/src/config/config.ts | left `harness-radian` out of the plugins a new home installs | `operad config > the default plugins are shell, the radian harness and dev` |
| step-timeout-M1 | packages/engine/src/runner/runner.ts | `timeoutMsFor` ignored the step type's `timeoutSecs` and always used the runner's step timeout | `runner > a step's own timeoutSecs replaces the runner's step timeout` |
| TK0012-M1 | packages/engine/src/flow/validate.ts | stopped counting `interrupted` as a possible result of an unsafe step | `validateFlow > requires an interrupted edge for every unsafe step` |
| TK0012-M3 | packages/engine/src/loop/serve.ts | treated every `running` run as a crash, so a freshly requested effect was recovered instead of run | `serve loop > a recorded answer runs the next step in serve's process` |
| TK0012-M6 | packages/engine/src/runner/runner.ts | recorded pid 0 on the step-start fact instead of the executing process | `operad with the dev plugin > dev:reject from the CLI records, and serve runs the next step` |
| waiting-notices-M3 | packages/engine/src/views/presentation.ts | the History section skipped the actions people ran | `operad with the dev plugin > a plan shows its auto level and priority, and its history shows who confirmed and set it` |
| waiting-notices-M5 | packages/engine/src/views/presentation.ts | `show` with no id listed the oldest changes first | `operad with the dev plugin > show without an id lists the ten latest changes; an unknown id lists the five closest` |
| waiting-notices-M6 | packages/engine/src/views/presentation.ts | an unknown id listed the farthest ids instead of the closest | `operad with the dev plugin > show without an id lists the ten latest changes; an unknown id lists the five closest` |
| waiting-notices-M7 | packages/engine/src/trigger/kernel.ts | an event recorded in a run lost its summary text | `dev.waiting > work did nothing: one event, once, also when the step runs again` |
| TK0005-M1 | packages/engine/src/platform/sqlite-open.ts | `setBusyTimeout` installed no busy timeout | `the busy timeout is installed on the connection` |
| TK0005-M3 | packages/engine/src/platform/file-lock.ts | `linkExclusive` reported success when the target already existed | `the lock file > a live holder blocks until the deadline and names its pid` (and six more in that file) |
| TK0005-M4 | packages/engine/src/platform/process-group.ts | the shared stop never sent the grace SIGKILL | `process groups` and the harness-radian tests (timed out) |
| TK0005-M5 | packages/engine/src/platform/sqlite-open.ts | `enableWal` rethrew `SQLITE_BUSY` instead of waiting (also TK0008-M1) | `switching to WAL waits while another process holds the database` |
| TK0005-M6 | packages/engine/src/platform/watch.ts | `resolveSubscriptionWatch` ignored an injected watch | `the injected watch, timer and period replace the defaults` |
| TK0005-M7 | packages/engine/test/platform/no-copies.test.ts | dropped the `process.kill(-` pattern from the scan | `the platform module is the only copy > the scan finds each forbidden call outside platform/` |
| TK0009-M1 | packages/engine/src/platform/process-group.ts | the drain grace used `globalThis.setTimeout` instead of the injected clock | `shell/command > a child that leaves the group cannot hold the command open` (timed out) |
| TK0009-M2 | packages/engine/src/platform/process-group.ts | a finished line took the TERM/grace stop instead of a direct SIGKILL | `process groups > a finished line is stopped with a single SIGKILL` |
| TK0009-M3 | packages/engine/src/platform/process-group.ts | the sentinel looped forever instead of watching the host process | `the sentinel's host > a sentinel whose host was killed ends when its line finishes` |
| TK0009-M4 | packages/engine/src/platform/process-group.ts | `exitFromStatus` mapped status 130 to a signal and dropped the code | `shell/command > a command that exits 130 keeps the exit code in the fact` |
| TK0009-M5 | packages/engine/src/platform/process-group.ts | `ControlReader.destroy()` set closed before the stream close could resolve the waiter | `the control reader > destroy resolves a pending read` (timed out) |
| T-0021-M1 | packages/engine/src/runner/limits.ts | `grant` compared `held > concurrent` instead of `held >= concurrent`, giving one place too many | `step limits (memory) > two steps run, the third starts when one ends` |
| T-0021-M2 | packages/engine/src/runner/limits.ts | `compareQueue` ordered the queue newest first | `step limits (memory) > a queue is first come, first served across four` |
| T-0021-M3 | packages/engine/src/runner/limits.ts | `grant` counted the places held under every key, not just the key being granted | `step limits (memory) > different keys do not block each other and no key is never limited` |
| T-0021-M4 | packages/engine/src/plugin/registry.ts | a step started with `ctx.runStep` took no place under its key | `step limits (memory) > a step a step starts counts against the key` |
| T-0021-M5 | packages/engine/src/loop/serve.ts | a `serve` pass no longer granted free places | `step limits survive a crash > after the result, before the next is granted: the next gets the slot on restart` |
| T-0021-M6 | packages/engine/src/runner/limits.ts | `acquire` wrote `step_queued` again for a step that already had its place | `step limits survive a crash > after step_slot, before the step starts: the step runs holding its slot` |
| T-0021-M7 | packages/engine/src/plugin/registry.ts | stopped checking that `limit.key` is a function | `plugin registry validation > step limits > refuses a declaration of the wrong shape, naming plugin and step type` |
| T-0021-M8 | packages/engine/src/runner/limits.ts | `queuedSteps` counted one more step ahead than there was | `step limits (memory) > two steps run, the third starts when one ends` |
| T-0021-M11 | packages/engine/src/runner/limits.ts | a `step_queued` after a `step_released` for the same effect was ignored again | `step limits after a released place > a step queued again after its release gets a place` |
| T-0022-M1 | packages/engine/src/plugin/usage.ts | `validateUsage` skipped the last token field | `validateUsage > refuses each wrong field and names it` |
| T-0022-M2 | packages/engine/src/plugin/usage.ts | `readUsage` read an old fact's `cache_write` as `cacheread` | `readUsage > reads a fact stored before the standard field existed` |
| T-0022-M3 | packages/engine/src/plugin/registry.ts | the harness result check never ran | `end results > the plugin check refuses a harness step that declares another name` |
| T-0022-M4 | packages/engine/src/plugin/usage.ts | `END_RESULTS` lost `nothing`, so the manual's table no longer matched | `end results > the manual's table lists exactly the exported results` |
| T-0022-M12 | packages/engine/src/plugin/usage.ts | `readUsage` did not report a malformed usage | `readUsage > a malformed standard usage is reported once, naming the field` |
| T-0022-M13 | packages/engine/src/plugin/usage.ts | `readUsage` read an old `incomplete` cost as exact | `readUsage > reads a fact stored before the standard field existed` |
| engine-followups-2-M1 | `packages/engine/src/runner/runner.ts` | `timer.unref()` put back on the in-process step timeout timer (the test child had top-level await, which Bun keeps alive, so it hid the missing timer; the child now runs from a plain function) | `runner > a step that never settles still times out in a memory-backed process` |
| engine-followups-2-M2 | `packages/engine/src/config/config.ts` | `addDefaultPlugins` wrote the config file in place instead of a temp file and rename | `operad config > a failed write leaves the existing config whole` |
| engine-followups-2-M4 | `packages/engine/src/plugin/registry.ts` | a run whose object is missing got `at: 0` instead of the run's last time | `plugin registry validation > a waiting run with no object shows its own last time and is logged once` |
| engine-followups-2-M5 | `packages/engine/src/plugin/registry.ts` | the missing object was logged on every call, not once per run | `plugin registry validation > a waiting run with no object shows its own last time and is logged once` |
| T-0027-M6 | packages/engine/src/config/config.ts | `readMcp` dropped `confirmActions` and returned an empty list | `operad config > reads mcp actions and applies their defaults` |
| TK0009-M11 | `packages/engine/src/platform/process-group.ts` | the shell's own exit replaced the status in its end record when the exit event came first | `a line's end record > a status the shell wrote survives the shell's exit arriving first` |
| TK0009-M12 | `packages/engine/src/platform/process-group.ts` | the sentinel did not watch its host while the line ran | `the sentinel's host > a line still running when its host dies is stopped with its sentinel` |
| TK0009-M13 | `packages/engine/src/platform/process-group.ts` | a control pipe that closed while the sentinel lived was followed by a wait for the sentinel's exit with no stop | `a control pipe that closes early > the group is stopped instead of waited for` |
| T-0024-M1 | `packages/engine/src/runner/ask.ts` | a second claim for the same question was not refused as already answered | `ctx.ask > of two answers at once one wins and the other is refused` |
| T-0024-M2 | `packages/engine/src/runner/ask.ts` | a claimed answer without its fact was never written by the waiting step | `ctx.ask > an answer claimed by a process that stopped before the fact is still delivered` |
| T-0024-M3 | `packages/engine/src/runner/ask.ts` | the grace took the first value that was set (the call over the config) instead of the narrowest | `ctx.ask > the grace is the narrowest of the call, the step param and the config` |
| T-0024-M4 | `packages/engine/src/runner/ask.ts` | asking again after a crash wrote a second `ask_opened` | `ctx.ask survives a crash > after ask_opened, before the answer: asked again, one item` |
| T-0024-M5 | `packages/engine/src/runner/ask.ts` | an answer to a question whose step ended without closing it was taken | `ctx.ask survives a crash > an answer to a question whose step ended without closing it is refused and recorded` |
| T-0024-M6 | `packages/engine/src/kernel/decide.ts` | the flow wait after a timed-out ask took a new wait id | `ctx.ask (memory) > an answer after the timeout goes through the flow wait with one item` |
| T-0024-M7 | `packages/engine/src/views/pending.ts` | a question a step waits on was not listed as pending | `ctx.ask (memory) > an answer within the grace goes to the waiting step` |
| T-0024-M8 | `packages/engine/src/flow/validate.ts` | a `waiting` edge to a step that is not a wait_person step was accepted | `validateFlow > a step that can end waiting needs a waiting edge to a wait_person step` |
| T-0024-M9 | `packages/engine/src/plugin/registry.ts` | `onTimeout: "reject_once"` ended the step waiting | `ctx.ask > reject_once returns to the step with rejected` |
| T-0024-M10 | `packages/engine/src/runner/runner.ts` | the step's own timeout kept running while a question was open | `ctx.ask > the step's own timeout does not run while it waits for an answer` |
| T-0024-M11 | `packages/engine/src/runner/runner.ts` | the runner told a worker's question it was refused | `ctx.ask (file) > an answer within the grace goes to the waiting step` |
| T-0024-M12 | `packages/engine/src/runner/ask.ts` | a question already timed out was waited for again after a crash | `ctx.ask survives a crash > after the timeout, before the flow wait: the wait is reached with the same id` |
| T-0024-M13 | `packages/engine/src/runner/ask.ts` | a question already answered was not delivered from the fact after a crash | `ctx.ask survives a crash > after ask_answered, before the step reads it: delivered from the fact` |
| T-0024-M14 | `packages/engine/src/config/config.ts` | `ask.graceSecs` without a value read as 1 instead of 600 | `operad config > reads ask.graceSecs and rejects a malformed ask section` |
| T-0024-M16 | `packages/engine/src/plugin/registry.ts` | `ctx.ask` with onTimeout waiting did not check that the step declares `waiting` | `ctx.ask > a step that asks with onTimeout waiting must declare waiting` |
| T-0024-M17 | `packages/engine/src/config/config.ts` | `ask.graceSecs` above the timer limit was accepted | `operad config > reads ask.graceSecs and rejects a malformed ask section` |
| T-0024-M18 | `packages/engine/src/runner/ask.ts` | a second question at once in one step was not refused | `ctx.ask > a second question at once in one step is refused` |
| T-0024-M19 | `packages/engine/src/runner/answer.ts` | an answer without a wait id went to the newest open question even when its step was dead | `ctx.ask survives a crash > an old open question does not change the error for an answer` |
| T-0024-M20 | `packages/engine/src/runner/ask.ts` | a duplicate claim was not refused, so two processes could both win | `ctx.ask answers from two processes > of two processes answering one question exactly one wins` |
| T-0024-M21 | `packages/engine/src/plugin/registry.ts` | a call's grace above the timer limit was accepted | `ctx.ask > a grace above the timer limit is refused` |
| T-0023-M1 | `packages/engine/src/runner/runner.ts` | the in-process step timeout used real timers, not the runner's `timers` | `runFlow > with a fake clock a step timeout ends interrupted` |
| T-0023-M2 | `packages/engine/src/testing/world.ts` | `answer` accepted any wait id | `runFlow > a person wait is answered by id, and only with a choice it offers` |
| T-0023-M3 | `packages/engine/src/testing/clock.ts` | `advance` left out a timer due exactly at the target | `runFlow > a step timeout does not fire before the clock passes it` |
| T-0023-M4 | `packages/engine/src/testing/index.ts` | `emit` reported an unmatched event as started | `emit > an event no rule matches starts nothing` |
| T-0023-M5 | `packages/engine/src/testing/world.ts` | the world made one pass only, so a run started by a run's end was never run | `one world across calls > a run that ends by itself starts the next run, and it is run` |
| T-0023-M6 | `packages/engine/src/testing/world.ts` | a plugin given by path ran against a memory store, so its steps stayed in the test's process | `isolation > a plugin given by path runs its steps in a worker, as serve does` |
| T-0023-M7 | `packages/engine/src/testing/world.ts` | a repeated event key was reported as started | `one world across calls > the same key arriving twice starts one run` |
| T-0023-M8 | `packages/engine/src/runner/runner.ts` | a worker step's timeout used real timers, not the runner's `timers` | `isolation > a fake clock times out a step in a worker too` |
| T-0025-M1 | `packages/engine/src/runner/grants.ts` | `useGrant` did not look for an earlier `grant_used`, so a used permission could be used again | `a one-time permission survives a crash > using a permission twice, from two callers, succeeds once` |
| T-0025-M2 | `packages/engine/src/plugin/registry.ts` | a step with `resumable: false` kept the `onTimeout` the call asked for | `ask resume (memory) > a step that cannot resume has its question forced to reject_once` |
| T-0025-M3 | `packages/engine/src/kernel/decide.ts` | a grant that named the approving choice was given for any choice | `decide: an answered question returns to the step > a grant that names the approving choice is not given for another` |
| T-0025-M4 | `packages/engine/src/runner/grants.ts` | `useGrant` returned true without writing `grant_used` | `a one-time permission survives a crash > a crash right after grant_used does not give the permission twice` |
| T-0025-M10 | `packages/engine/src/kernel/decide.ts` | any choice approved a grant (no named choice, no `approve` default) | `decide: an answered question returns to the step > with no named choice only "approve" gives the permission` |
| T-0025-M11 | `packages/engine/src/kernel/decide.ts` | the answer reached only a step the wait edge pointed to directly | `decide: an answered question returns to the step > the answer reaches the step that asked through a step in between` |
| T-0025-M12 | `packages/engine/src/plugin/registry.ts` | `ctx.ask` accepted a grant with no approving choice for a question with choices | `a question that offers a permission is checked before anyone is asked > a question with choices needs the grant to name the choice that approves` |
| T-0025-M13 | `packages/engine/src/plugin/registry.ts` | a step with `grants: false` could ask for a permission | `a question that offers a permission is checked before anyone is asked > a step that cannot enforce a permission cannot ask for one` |
| tui-autostart-M1 | packages/engine/src/config/config.ts | `DEFAULT_HTTP` was disabled again | `operad config > a missing config means jsonl at <home>/store` |
| tui-autostart-M2 | packages/engine/src/config/config.ts | an `http` section without `enabled` meant off | `operad config > reads http options and applies their defaults` |
| tui-autostart-M19 | packages/engine/src/loop/serve.ts | `serve()` took its own lock instead of the one handed to it | `a second operad serve > exits 4 on a held home before it reads the config, the store or the port` (the first serve failed against its own lock) |
| pending-row-M1 | packages/engine/src/views/pending.ts | the rows were built but not put on the items | `pending items carry their object's row > the row is the one the list shows, with the run flags` and the others in that file |
| pending-row-M2 | packages/engine/src/views/pending.ts | a candidate carried an object, so it got a row | `pending items carry their object's row > a candidate has no row` |
| pending-row-M3 | packages/engine/src/views/presentation.ts | the error row for a gone object had no `no object` message | `pending items carry their object's row > an object deleted after the run started gets an error row, and the rest are listed` |
| pending-row-M4 | packages/engine/src/views/presentation.ts | a built row lost its waiting flag, so it differed from the list's | `pending items carry their object's row > the row is the one the list shows, with the run flags` |
| T-0048-M1 | packages/engine/src/plugin/filters.ts | an error row was judged by the filter's states like any other | `object type filters > an error row is shown by every filter` |
| T-0048-M2 | packages/engine/src/views/presentation.ts | a row the filter left out was not counted in `hidden` | `object type filters > a filter keeps matching rows and counts the rest as hidden`, `a filter that hides every row returns no rows and the total` |
| T-0048-M3 | packages/engine/src/views/presentation.ts | a filtered page never gave a `next` cursor | `object type filters > paging works within the filtered list and never returns a short page early` |
| T-0048-M4 | packages/engine/src/plugin/registry.ts | a plugin could declare a filter named `all` | `object type filters > plugin loading refuses a malformed declaration with the field path` |
| T-0048-M5 | packages/engine/src/http/server.ts | `GET /v1/objects` without `filter` ignored the type's default | `filters over HTTP > /v1/types lists filters and /v1/objects applies them` |
| T-0032-M1 | packages/engine/src/http/server.ts | `GET /v1/keys` reported every binding as `plugin`, hiding the person's override | `http server > GET /v1/keys lists the plugin defaults and the person's overrides` |

## T-0047 — a qualified id and `--repo` must agree

| id | file | mutation | failing test |
|---|---|---|---|
| T-0047-M6 | packages/engine/src/views/presentation.ts | show accepted `--repo` that differs from a qualified id | `dev` cli test `a qualified id with an unknown repository, or a conflicting --repo, is refused` |
| T-0043-M8 | packages/engine/src/plugin/registry.ts | a nested step did not pass the parent's event destination on | `dev/work with workers > a rework waits for its worker while another worker is free` (`pool.waiting` could not be sent) |
| T-0069-M1 | packages/engine/src/views/presentation.ts | the mark check never rejected a value | `presentation views > an unknown mark is an error row naming the allowed marks` |
| T-0069-M2 | packages/engine/src/views/presentation.ts | the badge limit refused 16 characters instead of 17 | `presentation views > a badge over 16 characters or over several lines is an error row` |
| T-0069-M3 | packages/engine/src/views/presentation.ts | a valid mark was left off the row | `presentation views > a valid mark and badge pass through list and get; a plain row is unchanged` |

## T-0068 — the running view names the object and times the step

| id | file | mutation | failing test |
|---|---|---|---|
| T-0068-M1 | packages/engine/src/views/running.ts | a new attempt (`effect_requested`) no longer reset the step time | `the running view names the object and times the step > step time resets on a new step and on a new attempt` |
| T-0068-M2 | packages/engine/src/views/running.ts | an error row's message was returned as the title | `the running view names the object and times the step > a throwing row leaves the title null` |
| typed-bare-id-M1 | packages/engine/src/views/presentation.ts | a typed bare id (`task:T-0043-x`) skipped the scoped lookup | `presentation views > a typed bare id finds a scoped object of its type, as the app opens a row` |

## T-0065 — a cancelled line never hangs, and a lock takeover keeps one holder

| id | file | mutation | failing test |
|---|---|---|---|
| T-0065-M1 | packages/engine/src/platform/process-group.ts | the stop sent its last SIGKILL once and did not look for a child the signal missed | `process groups > a straggler that missed the SIGKILL is killed again while the group exists`, `a child forked as the group is signaled does not outlive the stop` |
| T-0065-M2 | packages/engine/src/platform/process-group.ts | the stop that gave up on `ready` sent its SIGKILL once and did not look for a missed child | `process groups > a stop that gave up on ready also kills a straggler again`, `a stop before ready waits for the sentinel's trap` |
| T-0065-M3 | packages/engine/src/platform/process-group.ts | the look for a straggler found it and did not signal the group again | `process groups > a straggler that missed the SIGKILL is killed again while the group exists`, `a stop that gave up on ready also kills a straggler again` |
| T-0065-M5 | packages/engine/src/platform/process-group.ts | the sweep signalled the group id after the sentinel was reaped, when an unrelated group could own it | `process groups > no signal goes to the group id once the sentinel is reaped` |
| T-0065-M6 | packages/engine/src/platform/process-group.ts | the sweep ran although the first SIGKILL reported the group already gone, when an unrelated group could own the id | `process groups > a SIGKILL that finds no group starts no sweep` |

## T-0064 — mcp.channel config

| id | file | mutation | failing test |
|---|---|---|---|
| T-0064-M8 | packages/engine/src/config/config.ts | an unknown mcp.channel.notify entry was accepted | `operad config > rejects a malformed mcp section and keeps it when written` |
| T-0064-M6 | packages/engine/src/views/presentation.ts | the list row dropped the plugin's final flag | `the channel's sources > what the default sends > a plan-like object reaching its final state sends with reason ended` |

## T-0089 — fences per CommonMark

| id | file | mutation | failing test |
|---|---|---|---|
| T-0089-M1 | packages/engine/src/markdown.ts | an opening fence accepted only exactly three backticks (`{3}`), so `````diff` lost its language | `markdown fences > a four-backtick fence reads its language and colours a diff` |
| T-0089-M2 | packages/engine/src/markdown.ts | a closing fence ignored its length (any fence of the same character closed) | `markdown fences > a ``` line inside a ```` fence is content` |
| T-0089-M3 | packages/engine/src/markdown.ts | a closing fence ignored its character (a backtick fence closed a tilde fence) | `markdown fences > closing needs the same character and a length at least the opening's` |
| T-0089-M4 | packages/engine/src/markdown.ts | the language was the whole info string, not its first word | `markdown fences > only the first word of the info string is the language` |
| T-0089-M5 | packages/engine/src/markdown.ts | `---`/`+++` diff headers were drawn bold again instead of red/green | `markdown > a four-backtick diff colours + and - lines and keeps indentation` |
| T-0094-M8 | packages/engine/src/views/pending.ts | the pending view left out the plugins' standing items | `standing pending items > a plugin's items join the pending view, wait on no run and go when the plugin stops reporting them` |
| T-0094-M9 | packages/engine/src/plugin/registry.ts | a standing hook that threw was raised instead of logged | `standing pending items > a plugin's items join the pending view, wait on no run and go when the plugin stops reporting them` |
| T-0052-M1 | packages/engine/src/views/presentation.ts | `root` kept the rows that have a parent instead of those without | `row parent > root lists only rows with no parent, across types in type order` |
| T-0052-M2 | packages/engine/src/views/presentation.ts | a parent id matched only as written, not as the resolved `type:id` or bare id | `row parent > parent= lists only that parent's children and the row carries parent` |
| T-0052-M3 | packages/engine/src/views/presentation.ts | the level list ignored the type's filter, so no row was hidden | `row parent > the default filter applies under parent= and hidden counts the filtered rows` |
| T-0052-M4 | packages/engine/src/views/presentation.ts | a list without a type walked the types in reverse order | `row parent > root lists only rows with no parent, across types in type order` |
| T-0052-M5 | packages/engine/src/views/presentation.ts | the kernel dropped the row's `parent` | `row parent > parent= lists only that parent's children and the row carries parent` |
| T-0052-M6 | packages/engine/src/views/presentation.ts | a level cursor was accepted for a different parent | `row parent > pages keep the order and a cursor cannot be moved to another list` |
| T-0052-M7 | packages/engine/src/http/server.ts | `/v1/types` left out each type's plugin | `hierarchy over HTTP > /v1/types names the plugin and /v1/objects takes root and parent` |
| T-0052-M8 | packages/engine/src/http/server.ts | `/v1/objects` ignored `parent=` | `hierarchy over HTTP > /v1/types names the plugin and /v1/objects takes root and parent` |
| T-0074-M1 | packages/engine/src/views/history.ts | `runHistoryLines` kept the "moving to" reason for plain results (dropped the PLAIN_RESULTS check) | `readable run history > one line per step attempt with time, outcome and duration` |
| T-0074-M2 | packages/engine/src/views/history.ts | a running step's time so far was measured from its own start (always 0s) | `readable run history > a running step shows how long so far, a person's answer keeps its line` |
| T-0074-M3 | packages/engine/src/views/history.ts | the date line was never written | `readable run history > a new day gets a date line` |
| T-0074-M4 | packages/engine/src/views/history.ts | `oneLine` cut details even with `full` | `readable run history > details are cut to one line, and --full keeps them` |
| T-0074-M5 | packages/engine/src/views/presentation.ts | the run id was printed in the heading as well as at the end | `shows a row, the section directory, the kernel history and actions` |
| T-0074-M6 | packages/engine/src/views/history.ts | an entered end step opened an attempt line (the end-step skip removed) | `readable run history > a run that ends on an end step has no line for that step` |
| T-0053-M8 | packages/engine/src/views/presentation.ts | a list did not run the types' `prepare` first | `object type prepare > a list and a get see objects the type brings up to date first, once` |
| T-0075-M20 | packages/engine/src/views/running.ts | a run waiting for a person counted as running, so a plugin view saw a current step | `the running view names the object and times the step > the current step of a run is what the running view reports, and nothing once it waits or ends` |
| T-0075-M24 | packages/engine/src/views/running.ts | an ended run reported the step it ended in even when it was waiting for a person | `the running view names the object and times the step > an ended run reports the step it was in, but not a person wait` |
| T-0075-M25 | packages/engine/src/views/running.ts | an ended run was read after its end, so no step was in flight | `the running view names the object and times the step > an ended run reports the step it was in, but not a person wait` |
| T-0096-M1 | packages/engine/src/plugin/registry.ts | `startProblem` did not follow a step's `calls` | `a start whose called step is not loaded > absent: the plugin is not loaded at all` |
| T-0096-M2 | packages/engine/src/plugin/registry.ts | a disabled plugin was reported as not loaded | `a start whose called step is not loaded > disabled: refused with the step, the plugin and the command` |
| T-0096-M3 | packages/engine/src/trigger/kernel.ts | `realizeStart` did not refuse a flow with a missing step | `a start whose called step is not loaded > absent: the plugin is not loaded at all` |
| T-0096-M4 | packages/engine/src/loop/serve.ts | serve spawned a child for a run whose called step is missing | `a start whose called step is not loaded > recovery leaves a run whose called step went missing, and says why` |
| T-0096-M5 | packages/engine/src/plugin/registry.ts | a nested call was never checked against `calls` | `calls > a call the step did not declare fails in tests` |
| T-0096-M6 | packages/engine/src/plugin/registry.ts | every nested call to a harness step was refused | `calls > a call a step of a harness plugin needs no declaration` |
| T-0053-M10 | packages/engine/src/views/presentation.ts | a tree list did not run the types' `prepare` first | `object type prepare > a root list called first sees them too` |
| T-0079-M1 | packages/engine/src/markdown.ts | number columns were shrinkable like text columns | `table fit > squeezed hard, text columns give way and number columns keep their width` |
| T-0079-M2 | packages/engine/src/markdown.ts | numbers, durations and money were left-aligned | `table fit > numbers, durations and money are right-aligned` |
| T-0079-M3 | packages/engine/src/markdown.ts | the column gap was three spaces instead of two | `table fit > a table narrower than the width keeps its content, without pipes` |
| T-0079-M6 | packages/engine/src/markdown.ts | cell widths were counted in code points, not display columns | `table fit > wide characters are measured in columns, so a CJK title fits` |
| T-0106-M1 | packages/engine/test/fixtures/plugins/testing-isolation.ts | `resetCalls` did nothing, so the in-process count kept growing across reruns | `isolation > in process, module state is shared: faster, not isolated` (fails on rerun 2 of `--rerun-each`) |
| T-0098-M1 | packages/engine/src/loop/code-watch.ts | `diffFingerprints` ignored a removed file | `code fingerprints > a changed, added or removed file differs; the same text written again does not` |
| T-0098-M2 | packages/engine/src/loop/code-watch.ts | an event during the quiet period no longer restarted it | `a code watch > acts once, a quiet period after the last event` |
| T-0098-M3 | packages/engine/src/loop/code-watch.ts | an event while the answer was pending started a quiet period | `a code watch > a reload ends the watch; a change during the answer does nothing more` |
| T-0098-M4 | packages/engine/src/loop/code-watch.ts | a kept change was offered again for the same files | `a code watch > a kept change is not offered again until the files change again` |
| T-0098-M5 | packages/engine/src/loop/code-watch.ts | a changed settings file no longer made a kept change be offered again | `a code watch > a settings file changing after a kept change is offered again` |
| T-0098-M6 | packages/engine/src/loop/code-watch.ts | `stop` left the directory watches open | `a code watch > a stopped watch ignores events and leaves no timers` |
| T-0098-M7 | packages/engine/src/loop/code-watch.ts | `stop` left the fallback timer set | `a code watch > a stopped watch ignores events and leaves no timers` |
| T-0098-M8 | packages/engine/src/runner/runner.ts | a hand-over wrote no line for history | `a run's process between steps > hands over after a step, says so in history, and a fresh process finishes without repeating it` |
| T-0098-M9 | packages/engine/src/runner/runner.ts | a hand-over was asked for when the run had ended | `a run's process between steps > goes on when nothing asks for a hand-over` |
| T-0096-M9 | packages/engine/src/trigger/kernel.ts | `refusedStarts` listed nothing for a refused start | `a start whose called step is not loaded > enabling the plugin and starting again works; the event was kept` |
| T-0096-M10 | packages/engine/src/trigger/kernel.ts | `startCandidate` recorded the person's choice before refusing, so the candidate left the pending view | `a candidate started while its plugin is disabled > stays pending with the reason, and starts after the plugin is enabled` |
| T-0096-M11 | packages/engine/src/trigger/kernel.ts | `refusedStarts` skipped a candidate whose choice was recorded | `a candidate started while its plugin is disabled > a choice recorded before the refusal is listed with the reason` |
| T-0107-M3 | packages/engine/src/platform/process-group.ts | a passed line no longer got the SIGKILL to its group, so a backgrounded child lived on | `shell/command > a child that outlives the line is in the group and is stopped` (child now `sleep 30`, longer than `waitForGone` waits) |
| T-0107-M4 | packages/engine/src/platform/process-group.ts | a cancelled command was sent no signal at all | `a flow through the runner > a run cancel stops the command's process group in a worker` (line now `sleep 30`) |
| T-0090-M1 | packages/engine/src/views/presentation.ts | a section result dropped the plugin's `pages` | `presentation views > reads sections, pages with next and grows a live section` |
| T-0146-M1 | packages/engine/src/plugin/registry.ts | a step that ended did not sweep the processes carrying its marker | `what a step leaves behind > a detached loop in a new process group is gone when the step ends` |
| T-0146-M2 | packages/engine/src/platform/step-reap.ts | the sweep picked every marked process of the home, not just the step's marker | `what a step leaves behind > a process of another run, and one with no marker, are not touched` |
| T-0146-M3 | packages/engine/src/platform/step-reap.ts | the sweep ignored the home in the marker | `what a step leaves behind > a process of the same run and step in another home is not touched` |
| T-0146-M4 | packages/engine/src/platform/process-group.ts | `runLine` no longer put the marker in the command's environment | `what a step leaves behind > a detached loop in a new process group is gone when the step ends` |
| T-0146-M5 | packages/engine/src/platform/step-reap.ts | the serve-start sweep stopped processes of active runs too | `serve loop > serve start stops marked processes of runs that are not active, and says so once` |
| T-0146-M6 | packages/engine/src/loop/serve.ts | `serve` did not run the start sweep | `serve loop > serve start stops marked processes of runs that are not active, and says so once` |
| T-0146-M7 | packages/engine/src/platform/step-reap.ts | the first of two steps with one marker swept when it ended | `what a step leaves behind > of two steps with one marker at once, only the last to end sweeps` |
| T-0146-M8 | packages/engine/src/platform/step-reap.ts | the sweep no longer climbed from a marked process to the shell that started it | `what a step leaves behind > a system shell that starts the marked process again is stopped with it` |
| T-0146-M9 | packages/engine/src/platform/process-group.ts | `runLine` no longer told the platform its sentinel, so nothing below it was followed | `what a step leaves behind > a system shell loop left in the background is stopped, though the system hides its environment` |
| T-0080-M1 | packages/engine/src/views/settings.ts | `setSetting` skipped the schema validation | `settings > an invalid value is refused with the schema's reason and nothing is written` |
| T-0080-M2 | packages/engine/src/views/settings.ts | a confirm setting was written without `confirmed` | `settings > a confirm setting needs confirmed` |
| T-0080-M3 | packages/engine/src/views/settings.ts | a setting not marked editable could be changed | `settings > a setting that is not editable, or unknown, is refused` |
| T-0080-M4 | packages/engine/src/views/settings.ts | `writeFileAtomic` wrote part of the text into the target before the rename | `settings > a writer killed before the rename leaves the old file whole` |
| T-0080-M5 | packages/engine/src/views/settings.ts | the write replaced the file with only the changed key | `settings > the rest of the file keeps its keys, order and indent` |
| T-0080-M6 | packages/engine/src/views/settings.ts | a project setting was written to `config.json` instead of the repository's `.operad/` file | `settings > project scope names the repository and writes its own file` |
| T-0080-M7 | packages/engine/src/http/server.ts | `POST /v1/settings` treated every request as confirmed | `http server > GET and POST /v1/settings list, change and refuse settings` |
| T-0080-M8 | packages/engine/src/plugin/action-schema.ts | the `editable` and `confirm` marks were not checked to be booleans | `settings declarations > editable and confirm must be booleans` |
| T-0123-M1 | packages/engine/src/views/presentation.ts | the row no longer carried the plugin's `after` | `hierarchy over HTTP > /v1/types names the plugin and /v1/objects takes root and parent` |
| T-0123-M2 | packages/engine/src/views/presentation.ts | `after` entries were not checked, so a non-string or empty id passed | `hierarchy over HTTP > /v1/types names the plugin and /v1/objects takes root and parent` |
| T-0112-M7 | packages/engine/src/views/presentation.ts | an action whose result is already true still ran its refusal path instead of succeeding with the line | `an action that cannot run > a result that is already true succeeds with the plugin's line and runs nothing` |
| T-0112-M8 | packages/engine/src/views/presentation.ts | an unknown action said "no loaded plugin declares action" instead of naming the object first | `an action that cannot run > the kernel's own refusals have the same shape: the object first, then what to do` |
| T-0112-M9 | packages/engine/src/http/server.ts | a refused action left no status in the server log | `http server > acts with a note, refuses without one, and needs confirmed for a confirm action` |
| T-0127-M1 | packages/engine/src/http/server.ts | `stop` waited for the listeners with no bound, so one that never stops hung the hand-over | `http server > stop does not wait for ever on a listener that will not stop, and names its address` |
| T-0127-M2 | packages/engine/src/http/server.ts | `stop` did not report the addresses that failed to release | `http server > stop does not wait for ever on a listener that will not stop, and names its address` |
| T-0146-M10 | packages/engine/src/platform/step-reap.ts | a fork seen by the watch no longer made the tracker look at the forking process's children | `what a step leaves behind > loops a command's shell left in the background are stopped, though the system hides their environment` |
| T-0146-M11 | packages/engine/src/platform/step-reap.ts | a member of a followed process group was taken whatever its start time | `what a step leaves behind > a process group id that was reused later is not taken for the step's` |
| T-0146-M12 | packages/engine/src/platform/step-reap.ts | a group leader that ended was never noted as gone | `what a step leaves behind > a process group id that was reused later is not taken for the step's` |
| T-0129-M1 | packages/engine/src/views/presentation.ts | a bare id still collected matches from the facts after a declared type matched | `presentation views > a bare id found in a declared type wins over a type only the facts remember` |
| T-0114-M3 | packages/engine/src/views/running.ts | a wait for a person was not a stretch of its own (the `person` flag always false) | `the running view names the object and times the step > a run's times: steps, a person wait of its own, and the run's end` |
| T-0150-M2 | packages/engine/src/platform/step-reap.ts | `lastValue` returned the first match instead of the last | `the ps -E command column > an argument that spells the variables does not override the environment` |
| T-0085-M4 | packages/engine/src/views/settings.ts | a listed setting left out its allowed values | `settings > lists every setting with value, default, description and marks` |
| T-0161-M1 | packages/engine/src/views/running.ts | a running item dropped its object's row mark | `the running view names the object and times the step > an item carries its object's row mark, and none when the row has none` |

## T-0158 — the pending view leaves out a wait its plugin answers itself

| id | file | mutation | failing test |
|---|---|---|---|
| T-0158-M3 | packages/engine/src/views/pending.ts | a marked wait stayed in the pending view when `withAuto` was not given | `the pending view and the plugin's automatic answer > a marked wait is left out of the pending view unless asked for` (packages/mcp/test/channel.test.ts) |
| T-0175-M1 | packages/engine/src/views/presentation.ts | the dependents of a shown object listed the objects that do not follow it | `operad mcp > show of a task lists the tasks after it` (packages/mcp/test/server.test.ts) |

## T-0060 — a repository flow keeps its graph

| id | file | mutation | failing test |
|---|---|---|---|
| T-0060-M3 | packages/engine/src/plugin/registry.ts | a second declaration of a name replaced the graph instead of keeping the first | `a name already used keeps the graph it got first` |

## T-0177 — a standing item carries the actions of its object

| id | file | mutation | failing test |
|---|---|---|---|
| T-0177-M6 | packages/engine/src/plugin/registry.ts | a standing item's object came with no actions (`actions: []` instead of `actionsHolding`) | `a proposed task is pending > a task added by \`task add\` is pending with confirm and cancel, drawn waiting, and leaves on confirm` (packages/dev/test/proposed-pending.test.ts) |
| T-0153-M1 | packages/engine/test/wait-for-file.ts | the wait looked once, then waited on the directory watch alone, with no 100 ms look | `store lifecycle and concurrency > two jsonl writers assign unique, contiguous sequences` (timed out 20 of 200 stressed runs with the old watch-only wait; not deterministic) |

## T-0207 — one-shot commands set no directory watch

| id | file | mutation | failing test |
|---|---|---|---|
| T-0207-M1 | packages/engine/src/plugin/file-store.ts | `ensureWatch` started the watch even when the store was opened without following | `the file plugin store > a store opened for one-shot use sets no watch or timer on subscribe` |
| T-0207-M2 | packages/engine/src/plugin/sqlite-store.ts | `ensurePolling` started the timer even when the store was opened without following | `store lifecycle and concurrency > a sqlite store opened for one-shot use starts no timer` |
| T-0207-M3 | packages/engine/src/platform/watch.ts | `followsChanges` returned true for every caller | `a log opened for a one-shot command starts no watch or timer` |
| T-0207-M4 | packages/engine/src/views/presentation.ts | a view subscribed to its store and log even when it was opened for a one-shot command | `object type prepare > a one-shot view adds no change listener` |

## T-0205 — process groups and code fingerprints on Linux

| id | file | mutation | failing test |
|---|---|---|---|
| T-0205-M2 | packages/engine/src/platform/process-group.ts | the sentinel killed its group with `kill -KILL -- "-$$"`, which dash rejects, so a line whose host died stayed running | `the sentinel's host > a line still running when its host dies is stopped with its sentinel` (Linux) |
| T-0205-M3 | packages/engine/src/loop/code-watch.ts | `hashFile` trusted a size and mtime cache key again, even for a file written within the millisecond | `a code watch > the timer finds a change no event reported` (Linux; the same stale hash made the other watch tests miss a same-size rewrite in some runs) |
| T-0205-M4 | packages/engine/src/loop/code-watch.ts | the cache trusted a hash whenever the key matched and the stamp was old, including a hash read while the stamp was still fresh | `code fingerprints > a hash read while its stamps were fresh is read again after they are old` |

## T-0165 — a queued step is not failed by a slow grant

| id | file | mutation | failing test |
|---|---|---|---|
| T-0165-M1 | packages/engine/src/runner/limits.ts | `locked` took the file lock without first serializing the grants of one process | `step limits > a step cancelled while it waits leaves the queue` (3 of 20 stressed runs at `--load 2`; not deterministic) |

## T-0165 — the pid-file wait keeps a timer look

| id | file | mutation | failing test |
|---|---|---|---|
| T-0165-M2 | packages/engine/test/platform/step-reap.test.ts | the pid-file wait used the directory watch alone, with no timer look | `what a step leaves behind > a system shell that starts the marked process again is stopped with it` (timed out at 30 s in the check; 0 of 200 stressed runs at `--load 2`; not deterministic) |
| T-0207-M5 | packages/engine/src/plugin/file-store.ts | `ensureWatch` stopped before starting the shared watch even for a following store | `the file plugin store > a following store watches and polls once for all its listeners` |

## T-0206 — the plugin store reads only past its offset

| id | file | mutation | failing test |
|---|---|---|---|
| T-0206-M1 | packages/engine/src/plugin/file-store.ts | read the facts from byte 0 instead of from `this.offset`, so every refresh read the whole file | `the file plugin store > a second reader sees facts another writer appended`; `the file plugin store > refresh reads only past its offset, and a torn multi-byte line waits for its newline` |
| T-0206-M2 | packages/engine/src/plugin/file-store.ts | treated the bytes after the last newline as complete, so a torn line was consumed before its newline landed | `the file plugin store > refresh reads only past its offset, and a torn multi-byte line waits for its newline` |
| T-0208-M1 | packages/engine/src/store-copy/copy.ts | skipped the check that the new store's files do not exist | `store copy > it refuses a target that already exists` |
| T-0208-M2 | packages/engine/src/store-copy/copy.ts | took no home lock, so a running serve did not stop the copy | `store copy > it refuses while serve or a run has the store open, and writes nothing` |
| T-0208-M3 | packages/engine/src/store-copy/copy.ts | did not look at the run locks | `store copy > it refuses while serve or a run has the store open, and writes nothing` |
| T-0208-M4 | packages/engine/src/store-copy/copy.ts | wrote every plugin object version as a plain fact, never as an object | `store copy > a store with a finished, a waiting and a failed run answers the same from its copy` |
| T-0208-M5 | packages/engine/src/store-copy/copy.ts | dropped the unique key of each global fact | `store copy > a store with a finished, a waiting and a failed run answers the same from its copy`; `store copy > jsonl to sqlite to jsonl gives equal facts` |
| T-0208-M6 | packages/engine/src/store-copy/copy.ts | copied runs newest first, so a waiting run started before the older run of the same flow and object | `store copy > jsonl to sqlite to jsonl gives equal facts` |
| T-0208-M7 | packages/engine/src/log/sqlite.ts | `startRun` ignored the `runId` option | `log backend: sqlite > the runId option names the runs it starts` |
| T-0208-M8 | packages/engine/src/log/jsonl.ts | `readGlobal` left out the unique key | `log backend: jsonl > readGlobal returns the unique key a fact was written with` |
| T-0208-M9 | packages/engine/src/store-copy/copy.ts | opened the jsonl source itself instead of a snapshot, so its recovery cut the torn tail | `store copy > a store with a finished, a waiting and a failed run answers the same from its copy` |
| T-0208-M10 | packages/engine/src/store-copy/copy.ts | `useStore` did not look at the run locks | `store copy > use refuses while a run holds the store` |
| T-0208-M11 | packages/engine/src/store-copy/copy.ts | the run-lock check called `lockHeld`, which removes a stale lock file from the source | `store copy > copy and use change nothing under the source directory` |
| T-0208-M12 | packages/engine/src/store-copy/copy.ts | opened the source's plugin objects in place instead of from the snapshot, which makes `plugins/` | `store copy > copy and use change nothing under the source directory` |

## T-0210 — follow-ups from the flow-stops reviews

| id | file | mutation | failing test |
|---|---|---|---|
| T-0210-M7 | packages/engine/src/notify/notify.ts | the person notifier sent a notice for a wait its plugin answers automatically | `notify > a wait the plugin answers itself sends no notice and is noticed later if it stays` |
| T-0210-M8 | packages/engine/src/views/presentation.ts | show listed a task of another repository with the same bare id in `after` as a dependent | `operad mcp > show of a task lists the tasks after it` (packages/mcp) |
| T-0210-M11 | packages/engine/src/plugin/registry.ts | a hook that throws counted as an automatic answer | `answeredAutomatically > a hook that throws counts as no and is logged` |

## T-0160 — settings follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0160-M1 | packages/engine/src/views/settings.ts | ran the read-modify-write without the lock file, so concurrent sets lost updates | `settings > sets at the same moment all land, and the file keeps its mode` |
| T-0160-M2 | packages/engine/src/views/settings.ts | dropped the chmod of the temporary file, so the config lost its mode on rename | `settings > sets at the same moment all land, and the file keeps its mode` |
| T-0188-M7 | packages/engine/src/plugin/registry.ts | an action could send an event whose source is operad | `ctx.emit in an action > the source operad is reserved for the kernel` |
| T-0188-M20 | packages/engine/src/plugin/registry.ts | the action context's harness list named plugins of another kind | `ctx.harnesses in an action > names the loaded plugins of kind harness` |
| T-0208-M13 | packages/engine/src/runner/runner.ts | a run ignored the store's move lock after taking its own lock | `store copy > a run that starts while the store is being copied is refused` |
| T-0208-M14 | packages/engine/src/store-copy/copy.ts | left the `locks/` directory the copy made in the source store | `store copy > a copy of a store with no locks directory leaves none behind` |
| T-0208-M15 | packages/engine/src/store-copy/copy.ts | skipped the check that the source did not change while it was copied | `store copy > a write that reaches the source after it was read makes the copy fail and leaves no target` |
| T-0208-M16 | packages/engine/src/log/jsonl.ts | removed the store-move check from every jsonl log write | `store copy > an answer or a plugin write while the store is being moved is refused` |
| T-0208-M17 | packages/engine/src/plugin/file-store.ts | removed the store-move check from the plugin store's append | `store copy > an answer or a plugin write while the store is being moved is refused` |
| T-0208-M18 | packages/engine/src/store-copy/copy.ts | took the snapshot without the locks the source's writers hold | `store copy > a plugin write under way when the copy starts is in the copy` |
| T-0208-M19 | packages/engine/src/store-copy/copy.ts | `useStore` did not compare the source with what the copy recorded | `store copy > use refuses a copy that is older than its source, and switching back is allowed` |
| T-0208-M20 | packages/engine/src/log/sqlite.ts | removed the store-move check from every sqlite log write | `store copy > a sqlite store refuses writes while a move holds it` |
| T-0208-M21 | packages/engine/src/plugin/sqlite-store.ts | removed the store-move check from the sqlite plugin store's writes | `store copy > a sqlite store refuses writes while a move holds it` |
| T-0131-M4 | packages/engine/src/views/history.ts | dropped the retry-step half of the pair check, so an alternating pair never folded | `folded repeats in run history > 37 unavailable reviews with their waits fold into one line` |
| T-0131-M5 | packages/engine/src/views/history.ts | left the outcome out of the fold signature, so a different outcome in between folded | `folded repeats in run history > the same step ending differently is not folded with the others` |
| T-0131-M6 | packages/engine/src/views/history.ts | normalized every number in the detail instead of only ISO times | `folded repeats in run history > attempts whose reasons differ by more than a time are not folded` |
| T-0131-M7 | packages/engine/src/views/history.ts | folded any two alternating steps, not only a step and its `_retry` step | `folded repeats in run history > two different steps that alternate are not a step and its retry` |

## T-0216 — a caller may observe the events of a step it runs

| id | file | mutation | failing test |
|---|---|---|---|
| T-0216-M3 | packages/engine/src/plugin/registry.ts | a step's events were not given to the caller's `observe` | `a step's events > a caller that observes a step sees its events besides the destination` |
| T-0251-M1 | packages/engine/src/trigger/kernel.ts | `recoverUnrouted` forgot its input position (reset to 0 each pass), so every pass read all inputs again | `a tick over a large history (sqlite) > reads what changed, not every input, answer and outcome ever recorded` |
| T-0251-M2 | packages/engine/src/loop/serve.ts | the recorded-answer reader forgot its input position (reset to 0 each pass) | `a tick over a large history (sqlite) > reads what changed, not every input, answer and outcome ever recorded` |
| T-0251-M3 | packages/engine/src/loop/serve.ts | an answer for a run that is no longer active stayed waiting and was looked at every pass | `a tick over a large history (jsonl) > reads what changed, not every input, answer and outcome ever recorded` |
| T-0251-M4 | packages/engine/src/plugin/sqlite-store.ts | `list` re-read and re-parsed every object, ignoring the remembered copy | `listing objects of a large type > an object that did not change is not read or parsed again` |
| T-0251-M5 | packages/engine/src/runner/ask.ts | the claimed-answer lookup used the wrong input id (run and wait swapped) | `ctx.ask > an answer claimed by a process that stopped before the fact is still delivered` |
| T-0251-M6 | packages/engine/src/log/jsonl.ts | `findInput` read the line at the wrong offset (start + 1) | `reading by position and by id (jsonl) > inputs after a position, one input by id, and outcomes after a sequence` |
| T-0251-M7 | packages/engine/src/log/jsonl.ts | `readOutcomesAfter` filtered every remembered outcome instead of bisecting the sequence-ordered list | `the jsonl backend over a large history > a lookup or a quiet read does not read the whole files` |
| T-0251-M8 | packages/engine/src/log/jsonl.ts | `findInput` read the whole inputs file besides using its remembered place | `the jsonl backend over a large history > a lookup or a quiet read does not read the whole files` |
| T-0251-M9 | packages/engine/src/log/jsonl.ts | the active-only run listing opened every ended run again | `the jsonl backend over a large history > listing the active runs does not open the logs of ended runs` |
| T-0251-M11 | packages/engine/src/log/jsonl.ts | the subscription poll listed the runs directory and statted every run, ended ones too | `the jsonl backend over a large history > a quiet tick costs the same with many ended runs: directory and file calls are counted` |
| T-0250-M1 | packages/engine/src/plugin/sqlite-store.ts | the constructor skipped `setBusyTimeout`, so a write met SQLITE_BUSY at once | `a write waits for another process's write transaction and succeeds after it commits` |
| T-0250-M3 | packages/engine/src/plugin/sqlite-store.ts | the constructor set `PRAGMA busy_timeout = 0` instead of the platform timeout | `the store's own connection has the platform busy timeout and WAL` (and `a write waits for another process's write transaction and succeeds after it commits`) |
| T-0250-M4 | packages/engine/src/store-copy/copy.ts | the copy's writer-hold opener skipped `enableWal` | `store copy > copying out of a sqlite home in rollback-journal mode leaves its databases in WAL` (packages/cli/test/store-copy.test.ts) |
| T-0251-M10 | packages/engine/src/log/jsonl.ts | `startRun` did not append its line to the runs index, so another handle never saw the run | `the jsonl backend over a large history > a quiet listing of the active runs does not list the runs directory` |
| T-0251-M12 | packages/engine/src/log/jsonl.ts | a runs index cut shorter than what was read was not rebuilt from the directory | `the jsonl backend over a large history > a missing or cut runs index is rebuilt from one read of the directory` |
| T-0251-M13 | packages/engine/src/log/jsonl.ts | a runs index ending in half a line was accepted instead of rebuilt | `the jsonl backend over a large history > a missing or cut runs index is rebuilt from one read of the directory` |
| T-0251-M14 | packages/engine/src/log/jsonl.ts | an index that cannot be opened threw instead of falling back to the directory | `the jsonl backend over a large history > a missing or cut runs index is rebuilt from one read of the directory` |
