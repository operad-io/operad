# Mutation records

Each package keeps its mutation checks in `MUTATIONS.md`; a row names the broken file, what was broken and the failing test, with an id like `TK0001-M1`.

- [access-match](packages/access-match/MUTATIONS.md)
- [chat](packages/chat/MUTATIONS.md)
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

## Outside packages

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
