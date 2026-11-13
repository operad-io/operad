---
description: Checking a change and reproducing a flaky test.
---

# Checks

How a change is checked before it merges, and how a flaky test is reproduced. The same checks gate a task of the `dev` plugin (see [its page](dev.md)).

## Why it exists

A change should be checked the same way whether a person or a `dev` task makes it, and the check should not cost more than the change needs. Running the whole suite for every small change is slow, so `check-changed.sh` tests only the packages a change can affect, and the full `verify.sh` runs once more at integration, before merge. `remote-check.sh` can run a check on another machine, in one of several slots, so that checks run at the same time do not share one working tree. A test that fails once and passes on a rerun is not ignored: the page treats it as a bug and gives a way to reproduce it, `stress.sh`. The rule is not to raise its timeout and not to add a retry inside the test.

## How it works

1. A check is a shell line. `bash scripts/verify.sh` installs with the lockfile, type-checks and runs every package's tests with `scripts/run-tests.sh`. `bash scripts/check-changed.sh` does the same installation and type-check, then picks the packages a change touches and the packages that load them, prints the choice (`all`, `none` or names) and tests only those.
2. `remote-check.sh` runs the line here, or when `OPERAD_CHECK_HOST` is set, copies `HEAD` to that host as a git bundle, takes a slot, checks out the commit and runs the line there. The output and the exit code come back as the line's own.
3. A `dev` task runs the lines in `gate.commands` against its commit. When a line fails, `dev` finds the failing test names with `failed.match` and runs each again alone with `failed.rerun`, which uses the `--` form of `remote-check.sh`. See [the gate and its settings](dev.md).
4. A test that passes only on its rerun is recorded. After `check.flakyTask` such passes (default 2), `dev` proposes a task to fix it, with the rule from `failed.rule` and the command from `failed.stress`.
5. That task runs `bash scripts/stress.sh` before the fix and after it, as described in [Reproducing a flaky test](#reproducing-a-flaky-test): `--rerun-each N` runs, optionally with `--load K` busy processes, and a summary of passes and failures.

Failures before the line runs, and what to do about them, are in [When a check fails](#when-a-check-fails). The host variables are in the table in [Checking a change](#checking-a-change).

## Checking a change

```sh
bash scripts/verify.sh
bash scripts/check-changed.sh
bash scripts/remote-check.sh '<command>'
bash scripts/remote-check.sh -- <word>...
```

`verify.sh` installs with the lockfile, type-checks and runs the whole test
suite with `scripts/run-tests.sh`. That script runs the test files in parallel
worker processes (`bun test --parallel`), and the `tui` package afterwards, one
file after another, because its terminal library does not load in a parallel
worker. `OPERAD_TEST_PARALLEL` (a whole number of 1 or more, default `2`) is the
number of worker processes; any other value stops the script with a message
that names the variable. Tests that start a real process, build a real git
repository, open a port or hold a lot of memory live under `test/heavy/` of
their package and run in a step of their own, beside the light step, in
`OPERAD_TEST_HEAVY_PARALLEL` workers (default `8`; `OPERAD_TEST_OVERLAP=0` runs
that step after the light one). Given package names (`bash scripts/run-tests.sh dev
shell`), it runs only those packages' tests. `check-changed.sh` installs and type-checks the same way, then tests only
the packages a change touches: every package with a file changed since the merge
base of `HEAD` and `origin/main` (committed, staged, unstaged or untracked), and
every package whose code loads one of those, directly or through others. A
package whose tests, not its code, load a changed package has its tests run too;
that goes no further. A change outside `packages/` (the lockfile, the root
manifest, `scripts/`, `docs/`, `.operad/`) tests every package. It prints the
packages it chose before the tests (`all`, `none`, or the names).
`OPERAD_CHECK_BASE` (a commit, default the merge base) changes what it compares
with. This repository's task check runs `check-changed.sh`, and its integration
runs `verify.sh`.

`remote-check.sh` runs a command here, or on the check host when
`OPERAD_CHECK_HOST` is set, at the same commit. It takes the command as one
argument (a shell command line), or after `--` as separate words that are passed
on as they are: no shell reads them as code on the way, so a word may hold
quotes, backquotes or `$`. The rerun of a failed test (`failed.rerun` in
`.operad/dev.json`) uses the `--` form, so it runs where the check ran.

`remote-check.sh` runs one command (a shell line) as a check. With
`OPERAD_CHECK_HOST` unset or empty it runs the line here, in the repository
root. With it set to an ssh destination (`user@host`) it copies `HEAD` to that
host as a git bundle, and there, holding one of `OPERAD_CHECK_SLOTS` slots
(the lock `~/.operad-check-<i>.lock`; it waits only when all are taken), fetches
`origin` and the bundle, checks out `HEAD`'s commit detached, removes untracked
files except `node_modules`, and runs the line. Each slot has its own tree, so a
checkout or clean in one never touches another: slot 1 uses the clone
`OPERAD_CHECK_TREE` (`~/Code/operad`), and every other slot uses a git worktree
of that clone made on first use, `<tree>-slot<i>` (for example
`~/Code/operad-slot2`), with its own `node_modules` once the line installs. With
`OPERAD_CHECK_LANE=integration` the check takes the one integration slot instead
(lock `~/.operad-check-integration.lock`, worktree `<tree>-integration`): an
integration never waits for a task check, and a task check never takes that
slot. The line sees `OPERAD_CHECK_SLOTS` on the host, so a check can use
`cores / (N + 1)` test workers. The output comes back as it is written and the
exit code is the line's; a failure before the line runs (bundle, copy,
connection, fetch, checkout) exits 1 with one line that names the step. The host
needs a clone of
the repository and Bun.

| Variable | Type | Default | What it does |
|---|---|---|---|
| `OPERAD_CHECK_HOST` | ssh destination | empty | Where the check runs; empty runs it here. |
| `OPERAD_CHECK_TREE` | path | `Code/operad` | The clone on the host, relative to its home directory. |
| `OPERAD_CHECK_SLOTS` | whole number, 1 or more | `1` | How many task checks run at once on the host; any other value stops the script. |
| `OPERAD_CHECK_LANE` | `integration` | unset | `integration` takes the integration slot instead of a task slot; any other value stops the script. |
| `OPERAD_CHECK_PATH` | directories | `$HOME/.bun-operad/bin:$HOME/.bun/bin` | Put first on the host's `PATH` before the line runs, expanded on the host. |
| `OPERAD_CHECK_SSH` | command | `ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=4` | The ssh command. |
| `OPERAD_CHECK_SCP` | command | `scp -q -o BatchMode=yes` | The scp command. |

Each variable is read when the script starts.

## When a check fails

A failure before the line runs (a missing clone, a failed bundle or copy, a
connection, fetch or checkout) exits 1 with one line that names the step; fix
that step and run the check again. A line that runs exits with the line's own
code and its output comes back as it was written. A task of the `dev` plugin
records the failing line, its exit code and the last output; see
[Troubleshooting](troubleshooting.md#checks-and-tests) for the messages and what
to do.

A test that failed and then passed on a rerun is a bug until shown otherwise.
Do not raise its timeout and do not add a retry inside the test. A task whose
brief is to fix a flaky test runs `scripts/stress.sh` twice: once to reproduce
before the fix and once to confirm after it, and states the command, the number
of runs and the result in its final answer. This repository gives that rule and
command to `dev` as `failed.rule` (`.operad/flaky.md`) and `failed.stress` in
`.operad/dev.json`; see [dev settings](dev.md). Every other task's check is
`bash scripts/check-changed.sh`; the full `bash scripts/verify.sh` runs once
more at integration, before merge.

## Reproducing a flaky test

```sh
bash scripts/stress.sh [--runs N] [--load K] [-t <name pattern>] <test files...>
```

The script runs `bun test` on the files with `--rerun-each N` (default 50) and
`--timeout 30000`. `-t` limits the run to tests whose name matches the pattern.
`--load K` starts K busy background processes for the length of the run (one
loops forking a short process, the rest spin), never more than the CPU count, to
imitate a gate under load; they are stopped when the script exits, however it
exits.

It prints the number of runs, passes and failures, each failing test name with
its count, and the path of the full log, and exits 1 when anything failed, when
no test ran, or when bun itself failed. A fix for a flaky test is done when a
stress run with `--load 2` passes whose `--runs` is chosen to take about ten
minutes (at least 20, at most 200); run one stress run at a time.
