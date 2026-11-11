# Mutation records — `scripts`

Rows whose mutation broke code in `scripts/` or the root tooling, in the
order they were recorded. The root [MUTATIONS.md](../MUTATIONS.md)
explains the format and the row fields.

## T-0091 — scripts/stress.sh

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

## LEAD-REMOTE-CLEAN — remote-check leaves no stale package directory

| id | file | mutation | failing test |
|---|---|---|---|
| LEAD-REMOTE-CLEAN-M1 | scripts/remote-check.sh | `git clean` kept every `node_modules` again (`-fdx -e node_modules`), so a package directory from an earlier commit stayed behind | `remote-check.sh > a package directory left from an earlier commit is removed, root node_modules is kept` |
