# Mutation records

Each package keeps its mutation checks in `MUTATIONS.md`; a row names the broken file, what was broken and the failing test, with an id like `TK0001-M1`.

- [access-match](packages/access-match/MUTATIONS.md)
- [cli](packages/cli/MUTATIONS.md)
- [dev](packages/dev/MUTATIONS.md)
- [engine](packages/engine/MUTATIONS.md)
- [harness-claude](packages/harness-claude/MUTATIONS.md)
- [harness-pi](packages/harness-pi/MUTATIONS.md)
- [harness-process](packages/harness-process/MUTATIONS.md)
- [harness-radian](packages/harness-radian/MUTATIONS.md)
- [mcp](packages/mcp/MUTATIONS.md)
- [pool](packages/pool/MUTATIONS.md)
- [review-grading](packages/review-grading/MUTATIONS.md)
- [shell](packages/shell/MUTATIONS.md)
- [source-cron](packages/source-cron/MUTATIONS.md)
- [tui](packages/tui/MUTATIONS.md)
- [scripts and root tooling](scripts/MUTATIONS.md)
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
| TK0008-M1 | `packages/engine/src/platform/sqlite-open.ts` | `enableWal` rethrew every error, so SQLITE_BUSY was not waited out | `switching to WAL waits while another process holds the database` |
| TK0008-M2 | `packages/engine/src/platform/sqlite-open.ts` | `enableWal` returned whatever mode SQLite answered instead of failing when it is not wal | `a database that cannot be WAL is an error, not a loop` |
| TK0008-M3 | `packages/engine/src/flow/validate.ts` | wrote a step's `next` edges with `next[result] = target`, which drops a result named `__proto__` | `validateFlow > accepts a result named __proto__` |
| TK0008-M4 | `packages/engine/src/log/jsonl.ts` | `parseFact` stopped checking that a fact line carries a JSON payload | `a fact line without a payload is a corrupt log, not a fact with no payload` |
| TK0008-M5 | `packages/engine/src/plugin/registry.ts` | accepted a plugin command named like a kernel verb | `plugin registry validation > refuses a plugin command that shares a name with a kernel verb` |
| TK0008-M6 | `packages/engine/src/plugin/registry.ts` | `pending` skipped a waiting run whose object is missing from the store | `plugin registry validation > pending keeps a waiting run whose object is missing from the store` |
| TK0008-M7 | `packages/engine/src/runner/service.ts` | `parseObjectKey` read `flow:<plugin>/<flow>` as a real object | `serve loop > a run started without an object has no object` |
| TK0008-M8 | `packages/engine/src/config/config.ts` | `init` no longer added the default plugins to a config that names none | `operad config > init adds the default plugins to a config that names none` |
| TK0008-M9 | `packages/engine/src/config/config.ts` | an older config's moved module name was not mapped | `operad config > an older config's moved module name still loads` |
| TK0008-M10 | `packages/cli/src/main.ts` | a typed history id resolved an object type no plugin declares | `operad command > history does not resolve an object type no plugin declares` |
| TK0008-M11 | `packages/engine/src/views/presentation.ts` | the named repository was not handed to a type's resolver | `operad with the dev plugin > show and an action take --repo for a bare id from outside any repository` |
| TK0008-M12 | `packages/engine/src/trigger/kernel.ts` | `realizeStart` dropped the access profile when it created the run | `run access profile > a run a plugin starts on tick records the profile in the log` |
| TK0008-M13 | `packages/engine/src/kernel/decide.ts` | the poll_check effect left out the wait's params | `decide: tick > a poll_check effect carries the wait's check params` |
| TK0008-M14 | `packages/engine/src/kernel/decide.ts` | an unexpected result dropped what the step said | `decide: step_result > an undeclared result keeps what the step said` |
| TK0008-M15 | `packages/engine/src/runner/runner.ts` | `WORKER_ABORT_GRACE_MS` back to 1000 ms, not above two process-group graces | `runner > an aborted worker gets longer than the slowest process-group stop` |
| TK0008-M16 | `packages/dev/src/steps.ts` | a worker model error went to a person instead of waiting | `dev/work > unavailable: a model error waits for the model instead of a person` |
| TK0008-M17 | `packages/dev/src/steps.ts` | removed the bound on work waits | `dev/work > unavailable: after the allowed waits the failure goes to a person` |

## T-0030 — the TUI shell

| id | file | mutation | failing test |
|---|---|---|---|
| T-0030-M1 | packages/tui/src/state.ts | a cursor move near the end never asked for the next page | `the TUI reducer > moving past the end asks for the next page once and appends it once` |
| T-0030-M2 | packages/tui/src/state.ts | the two-pane threshold became `>` instead of `>=`, so 100 columns stayed one pane | `the TUI reducer > resize crosses 100 columns and carries the theme` |
| T-0030-M3 | packages/tui/src/state.ts | a Pending row lost its waiting flag | `the TUI reducer > each list maps its own flags to a row mark` |
| T-0030-M4 | packages/tui/src/state.ts | an appended page kept `loading` true | `the TUI reducer > moving past the end asks for the next page once and appends it once` |
| T-0030-M5 | packages/tui/src/view/index.ts | the waiting marker used the weak gray instead of the accent | `the TUI view > two panes show the header, a waiting marker and the footer` |
| T-0030-M6 | packages/tui/src/view/index.ts | the view always drew both panes, ignoring the width | `the TUI view > below 100 columns the right pane is gone` |
| T-0030-M7 | packages/cli/src/main.ts | `tui --url` dropped the URL instead of handing it to the app | `operad tui > passes the url and token to the terminal app` |
| T-0030-M8 | packages/cli/src/main.ts | `tui` no longer refused a non-terminal without a runner | `operad tui > needs a terminal unless a runner is injected` |

## T-0091 — scripts/stress.sh

The script lives in `scripts/`, which has no package of its own, so its rows are here.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0091-M1 | scripts/stress.sh | the final exit status ignored failures | `scripts/stress.sh > a fixture failing every third run reports the counts and exits 1` |
| T-0091-M2 | scripts/stress.sh | `stop_helpers` no longer killed the helpers | `scripts/stress.sh > --load starts busy helpers and none is left after exit` |
| T-0091-M3 | scripts/stress.sh | removed the cap of `--load` at the CPU count | `scripts/stress.sh > --load never starts more helpers than there are CPUs` |
| T-0115-M1 | scripts/stress.sh | the helper loops no longer checked that the script is alive | `scripts/stress.sh > SIGKILL of the script leaves no helper alive` |
| T-0115-M2 | scripts/test/stress-group.ts | the runner's SIGINT/SIGTERM handlers no longer killed the stress group | `scripts/stress.sh > killing the test runner mid-test leaves no stress.sh or helper` |
| T-0115-M3 | scripts/stress.sh | `STRESS_CPUS` was ignored | `scripts/stress.sh > --load never starts more helpers than there are CPUs` |
| T-0115-M4 | scripts/stress.sh | the script no longer stopped when its starting process was gone | `scripts/stress.sh > SIGKILL to the test runner mid-test leaves no stress.sh or helper` |
| T-0143-M1 | scripts/stress.sh | a held lock was treated as free, so a second run did not wait | `scripts/stress.sh > the machine-wide lock > a second run waits while the first holds the lock, and starts when it ends` |
| T-0143-M2 | scripts/stress.sh | a holder was always taken for alive, so a dead pid's lock was never taken over | `scripts/stress.sh > the machine-wide lock > a lock held by a dead pid is taken over` |
| T-0143-M3 | scripts/stress.sh | the exit trap no longer released the lock | `scripts/stress.sh > the machine-wide lock > SIGTERM leaves no helper or test process and releases the lock` |
| T-0143-M4 | scripts/stress.sh | `--no-lock` still took the lock | `scripts/stress.sh > the machine-wide lock > --no-lock runs while another run holds the lock` |

## T-0109 — stale install check

| id | file | mutation | failing test |
|---|---|---|---|
| T-0109-M1 | scripts/check-install.ts | the link-exists test never reported a missing link | `scripts/check-install.ts > a worktree with the access-match link removed fails fast with the bun install line` |
| T-0109-M2 | scripts/stress.sh | removed the `check-install.ts` call | `scripts/check-install.ts > scripts/stress.sh refuses to start on a stale install` |
| T-0109-M3 | bunfig.toml | emptied the test preload | `scripts/check-install.ts > bun test in such a worktree stops on the same line before running a test` |
| T-0109-M4 | packages/dev/bunfig.toml | emptied the package's test preload | `scripts/check-install.ts > bun test run from a package directory stops on the same line` |

## LEAD-REMOTE-CLEAN — remote-check leaves no stale package directory

| id | file | mutation | failing test |
|---|---|---|---|
| LEAD-REMOTE-CLEAN-M1 | scripts/remote-check.sh | `git clean` kept every `node_modules` again (`-fdx -e node_modules`), so a package directory from an earlier commit stayed behind | `remote-check.sh > a package directory left from an earlier commit is removed, root node_modules is kept` |

## T-0238 — remote-check.sh slots and the integration lane

| id | file | mutation | failing test |
|---|---|---|---|
| T-0238-M1 | scripts/remote-check.sh | a task check tried only slot 1 whatever `OPERAD_CHECK_SLOTS` said | `remote-check.sh > slots and the integration lane > with two slots two checks run at once in different trees and a third waits` |
| T-0238-M2 | scripts/remote-check.sh | the integration lane took the task slots | `remote-check.sh > slots and the integration lane > with every task slot taken an integration check runs at once, in its own tree` |
| T-0238-M3 | scripts/remote-check.sh | ran the command before validating `OPERAD_CHECK_SLOTS` and `OPERAD_CHECK_LANE` when no host is set | `remote-check.sh > slots and the integration lane > a bad OPERAD_CHECK_SLOTS or OPERAD_CHECK_LANE stops the check even with no host` |
