# Mutation records

Each package keeps its mutation checks in `MUTATIONS.md`; a row names the broken file, what was broken and the failing test, with an id like `TK0001-M1`.

- [access-match](packages/access-match/MUTATIONS.md)
- [bot](packages/bot/MUTATIONS.md)
- [chat](packages/chat/MUTATIONS.md)
- [cli](packages/cli/MUTATIONS.md)
- [dev](packages/dev/MUTATIONS.md)
- [engine](packages/engine/MUTATIONS.md)
- [harness/claude](packages/harness/claude/MUTATIONS.md)
- [harness/codex](packages/harness/codex/MUTATIONS.md)
- [harness/pi](packages/harness/pi/MUTATIONS.md)
- [harness/process](packages/harness/process/MUTATIONS.md)
- [harness/radian](packages/harness/radian/MUTATIONS.md)
- [mcp](packages/mcp/MUTATIONS.md)
- [pool](packages/pool/MUTATIONS.md)
- [review-grading](packages/review-grading/MUTATIONS.md)
- [shell](packages/shell/MUTATIONS.md)
- [source-cron](packages/source-cron/MUTATIONS.md)
- [telegram](packages/telegram/MUTATIONS.md)
- [tui](packages/tui/MUTATIONS.md)

## Outside packages

| id | file | mutation | failing test |
|---|---|---|---|
| T-0091-M1 | scripts/stress.sh | the final exit status ignored failures | `scripts/stress.sh > a fixture failing every third run reports the counts and exits 1` |
| T-0091-M2 | scripts/stress.sh | `stop_helpers` no longer killed the helpers | `scripts/stress.sh > --load starts busy helpers and none is left after exit` |
| T-0091-M3 | scripts/stress.sh | removed the cap of `--load` at the CPU count | `scripts/stress.sh > --load never starts more helpers than there are CPUs` |
| T-0115-M1 | scripts/stress.sh | the helper loops no longer checked that the script is alive | `scripts/stress.sh > SIGKILL of the script leaves no helper alive` |
| T-0115-M2 | scripts/test/stress-group.ts | the runner's SIGTERM handler no longer killed the stress group | `scripts/stress.sh > SIGTERM to the test runner mid-test leaves no stress.sh or helper` |
| T-0115-M3 | scripts/stress.sh | `STRESS_CPUS` was ignored | `scripts/stress.sh > --load never starts more helpers than there are CPUs` |
| T-0115-M4 | scripts/stress.sh | the script no longer stopped when its starting process was gone | `scripts/stress.sh > SIGKILL to the test runner mid-test leaves no stress.sh or helper` |
| T-0143-M1 | scripts/stress.sh | a held lock was treated as free, so a second run did not wait | `scripts/stress.sh > the machine-wide lock > a second run waits while the first holds the lock, and starts when it ends` |
| T-0143-M2 | scripts/stress.sh | a holder was always taken for alive, so a dead pid's lock was never taken over | `scripts/stress.sh > the machine-wide lock > a lock held by a dead pid is taken over` |
| T-0143-M3 | scripts/stress.sh | the exit trap no longer released the lock | `scripts/stress.sh > the machine-wide lock > SIGTERM leaves no helper or test process and releases the lock` |
| T-0143-M4 | scripts/stress.sh | `--no-lock` still took the lock | `scripts/stress.sh > the machine-wide lock > --no-lock runs while another run holds the lock` |
| T-0109-M1 | scripts/check-install.ts | the link-exists test never reported a missing link | `scripts/check-install.ts > a worktree with the access-match link removed fails fast with the bun install line` |
| T-0109-M2 | scripts/stress.sh | removed the `check-install.ts` call | `scripts/check-install.ts > scripts/stress.sh refuses to start on a stale install` |
| T-0109-M3 | bunfig.toml | emptied the test preload | `scripts/check-install.ts > bun test in such a worktree stops on the same line before running a test` |
| LEAD-REMOTE-CLEAN-M1 | scripts/remote-check.sh | `git clean` kept every `node_modules` again (`-fdx -e node_modules`), so a package directory from an earlier commit stayed behind | `remote-check.sh > a package directory left from an earlier commit is removed, root node_modules is kept` |
| T-0238-M1 | scripts/remote-check.sh | a task check tried only slot 1 whatever `OPERAD_CHECK_SLOTS` said | `remote-check.sh > slots and the integration lane > with two slots two checks run at once in different trees and a third waits` |
| T-0238-M2 | scripts/remote-check.sh | the integration lane took the task slots | `remote-check.sh > slots and the integration lane > with every task slot taken an integration check runs at once, in its own tree` |
| T-0238-M3 | scripts/remote-check.sh | ran the command before validating `OPERAD_CHECK_SLOTS` and `OPERAD_CHECK_LANE` when no host is set | `remote-check.sh > slots and the integration lane > a bad OPERAD_CHECK_SLOTS or OPERAD_CHECK_LANE stops the check even with no host` |
| T-0234-M1 | scripts/remote-check.sh | the `--` form joined its words with a plain space instead of quoting each, so a word with a quote or `$` was split or run by the host shell | `remote-check.sh > the -- form > a word with quotes, backquotes, $ and a regex arrives byte for byte and is not run` |
| T-0259-M1 | .operad/dev.json | the rerun no longer ran `bun install --frozen-lockfile` before the test | `remote-check.sh > the -- form > a rerun after a checkout that changes the workspace packages installs first and reaches the test` |
| T-0255-M1 | scripts/test/remote-check.test.ts | the tests passed the surrounding check's `OPERAD_CHECK_*` settings on to the script again | `remote-check.sh > slots and the integration lane > a task check never takes the integration slot, and a second integration waits for the first` (run with `OPERAD_CHECK_LANE=integration OPERAD_CHECK_SLOTS=2` in the environment) |
| T-0377-M5 | scripts/publish.sh | removed the registry check, so `--publish` packed and published a version that was already on the registry | `publish.sh > --publish skips a version the registry already has` (also the ordering test) |
| T-0377-M9 | scripts/publish.sh | put `harness/process` before its `@operad-io/mcp` dependency again | `publish.sh > the real order puts every package after its @operad-io dependencies` |
| T-0429-M1 | scripts/test/adr-references.test.ts | dropped the `第 N 条` citation pattern | `a backlog decision is cited by its ADR > a citation is reported with the file and the line` |
| T-0429-M2 | scripts/test/adr-snapshot.test.ts | dropped the rule that catches the plan word "later" | `the ADRs are snapshots, not plans > a violation names the file and the line` |

## T-0297 — follow-ups from the flaky-test work

| id | file | mutation | failing test |
|---|---|---|---|
| T-0297-M1 | scripts/stress.sh | the lock holder was alive whenever `ps -p` found any process with its pid | `scripts/stress.sh > the machine-wide lock > a lock whose pid now belongs to another program is taken over` |
| T-0297-M2 | scripts/stress.sh | `STRESS_CPUS=0` was accepted and capped `--load` at 0 | `scripts/stress.sh > STRESS_CPUS=0 is refused instead of starting no helper` |
| T-0297-M3 | scripts/stress.sh | no watcher stopped the `bun test` child when the script itself was SIGKILLed | `scripts/stress.sh > SIGKILL of the script stops the test runner it started` |
| T-0297-M4 | scripts/stress.sh | the default lock path was under `TMPDIR` again | `scripts/stress.sh > the machine-wide lock > two runs with different TMPDIR values still share the lock` |
| T-0322-M1 | scripts/test/steady.fixture.ts | defined `testWorld` again outside `@operad-io/engine/testing` | `test helpers > a test helper named like one of @operad-io/engine/testing is defined only there` |
| T-0322-M2 | scripts/run-tests.sh | dropped the call that prints the slowest tests | `run-tests.sh > a run ends with the slowest tests and a full run appends one line to the times file` |
| T-0322-M3 | scripts/test-times.ts | counted failed runs in the median | `test times > a failed run and a line that is not a run are left out` |
| T-0322-M4 | scripts/test/test-helpers.test.ts | the scan visited only `test` directories again, so `packages/pool/support.ts` defining `testWorld` passed | `test helpers > a test helper named like one of @operad-io/engine/testing is defined only there` |
| T-0357-M1 | scripts/test/run-tests.test.ts | the test passed the caller's `OPERAD_TEST_PARALLEL` on to `run-tests.sh` again | `run-tests.sh > a run ends with the slowest tests and a full run appends one line to the times file` (run with `OPERAD_TEST_PARALLEL=5` in the environment) |
| T-0370-M1 | docs/user/config.md | the `mcp.confirmActions` table row was removed | `scripts/test/docs-coverage.test.ts > the user docs > every schema property has a table row on its page` |
| T-0370-M2 | docs/user/http.md | the `http.port` table row was removed (`tui.md` keeps a row of the same name) | `scripts/test/docs-coverage.test.ts > the user docs > every schema property has a table row on its page` |
| T-0373-M1 | docs/plugins/exports.md | the `GROWTH_EVENT_INTERVAL_MS` table row was removed (no other page has a row for it) | `scripts/test/plugin-docs.test.ts > the plugin docs > every export a plugin can import has an entry under docs/plugins` |
| T-0373-M2 | scripts/test/plugin-docs.allow.json | `definePlugin`, which `packages/pool/src/index.ts` imports, was added to the allow list | `scripts/test/plugin-docs.test.ts > the plugin docs > a name a plugin package imports is never on the allow list` |
| T-0373-M3 | docs/plugins/types.md | the `PluginStepResult` table row (a type `packages/pool/src/index.ts` imports) was removed | `scripts/test/plugin-docs.test.ts > the plugin docs > every export a plugin can import has an entry under docs/plugins` |
| T-0375-M1 | scripts/test/fixtures/hold.ts | the hold no longer checked that its owner was alive (the loop only retried the read) | `remote-check.sh > a blocked fixture ends when the test that started it is killed` |

## T-0402-check-stall-limit — the check's heartbeat and a remote stop

| id | file | mutation | failing test |
|---|---|---|---|
| T-0402-M1 | scripts/run-tests.sh | the heartbeat printed on wall time even when no report or output file grew, so a silent hang would keep resetting the gate's stall timer | `run-tests.sh > a silent step prints no heartbeat that would hide a stall` |
| T-0402-M2 | scripts/remote-check.sh | the watcher on the host session was removed, so a local stop closed the connection but left the remote command running | `remote-check.sh > a stop of the local check ends the command on the host` (the remote pid was still present after 5 s) |
| T-0402-M3 | scripts/run-tests.sh | the heartbeat's growth comparison was reversed, so a step whose output grew never printed one | `run-tests.sh > a step whose output grows still prints a heartbeat` (expected `run-tests: still running`) |
| T-0414-M4 | scripts/run-tests.sh | the heartbeat no longer counts the heavy step's captured output (`*.out`) as growth | `run-tests.sh > heavy output growing alone prints a heartbeat while the heavy step is still open` |
| T-0414-M7 | scripts/run-tests.sh | the heartbeat no longer exits when the script's process is gone (the `kill -0` line is deleted) | `run-tests.sh > the heartbeat ends by itself when the script is killed without a chance to stop it` |
| T-0424-M1 | scripts/tla.sh | the sha256 comparison of the downloaded jar was replaced by `false`, so a jar with the wrong hash was kept and run | `scripts/tla.sh > a download whose sha256 differs is refused and not kept` |

## T-0417 — the ADR snapshot test

| id | file | mutation | failing test |
|---|---|---|---|
| T-0417-M1 | scripts/test/adr-snapshot.test.ts | the date rule no longer matched a `YYYY-MM-DD` date (the pattern required an extra character) | `the ADRs are snapshots, not plans > a violation names the file and the line` |

## T-0421 — references to backlog decisions

| id | file | mutation | failing test |
|---|---|---|---|
| T-0421-M1 | AGENTS.md | put a backlog file name followed by a decision number back in the kernel paragraph, outside `docs/backlog/` | `a backlog decision is cited by its ADR > no file outside docs/backlog cites a backlog decision by number` |
