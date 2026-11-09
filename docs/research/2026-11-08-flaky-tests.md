# Flaky-test survey after T-0065 (2026-11-08)

T-0065 (cancel-hang) is merged (`d5c87c2` on origin/main). Method, per the rework
brief: `bash scripts/stress.sh --runs 10 --load 2 <tests>` (10 reruns, not 20), in
the order engine, shell, dev, harness-claude, cli. dev, harness-claude and cli
were run file by file, because a whole-package dev run exceeded the 20-minute tool
limit and was discarded. Time ran out after those five packages. No code or test
is changed by this task. Machine: macOS, 10 CPUs. Other sessions' stress runs
(T-0091) were active on the same machine throughout, and harness-claude and cli
overlapped the end of the dev run, so the load was higher than `--load 2`. Real
failure rates are probably lower on a quiet machine.

## Results

| Package | Test runs | Failures | Failing tests (count) | Wall time |
|---|---|---|---|---|
| engine | 5640 | 18 | `isolation > in process, module state is shared: faster, not isolated` 9; `presentation views > reads sections, pages with next and grows a live section` 9 | 8m56s |
| shell | 290 | 0 | none | 1m29s |
| dev | 10 reruns of every test, per file | 30 | `dev/review hardening > a radian Result with a model_error makes the real harness report unavailable` 10; `dogfood-config` (2 tests) 20 | about 53m (`gate.test.ts` alone 30m50s); see the whole-package run below |
| harness-claude | 10 reruns of every test, per file | 1 | `harness-claude/agent > silence without an open tool call is a stall` 1 | about 4m |
| cli | 10 reruns of every test, per file | 21 | `operad command > init creates the home and prints each plugin check` 10; `init reports a missing radian and leaves a complete config` 10; `a serve restart while a check runs > the check's command is not signalled and finishes with its exit code` 1 | about 3m |

The whole-package dev run that I called discarded did finish (log
`stress.uvoPM8`, `--runs 10 --load 2 packages/dev/test`): 7520 tests across 22
files, 22 failures, 5015 s. Its failures are 20 `dogfood-config` (claude worker)
failures plus one each of these two, which the per-file runs above did not repeat:

| Test | Count | Where it failed |
|---|---|---|
| `dev per-repository ids > two repositories may both hold T-0001-work under different keys` | 1 (run 8) | `packages/dev/test/service.test.ts:419`, `addRepository` threw `"<.radian/tmp/dev-test-*/one>" is not a git work tree` (`packages/dev/src/service.ts:385-387`) |
| `operad with the dev plugin > a qualified id whose repository was removed is refused though its object is stored` | 1 (run 4) | `packages/dev/test/cli.test.ts:710`, `repo add .` on a second repository returned 1, expected 0 |

Classification: **unclassified**. In both, the test's own `makeGitRepository`
(`packages/dev/test/support.ts:56-68`, whose `git` helper throws on a non-zero exit,
lines 44-53) had just succeeded, and then `git rev-parse --show-toplevel` in
`addRepository` failed or printed nothing. Scratch directories are under
`<cwd>/.radian/tmp` (`support.ts:19-25`), so a transient git failure under load or
a clash with another process using the same worktree are both possible; the product
`git()` call at `service.ts:385` drops stderr, so the reason is lost. Frequency 1 in
10 reruns each, in a run with other sessions' load. In that run the dogfood failures
had a different message (`Export named 'secretValuesOf' not found in
packages/access-match/src/index.ts`): the same stale-install environment issue as
below. A new proposed task (6) covers the two repository failures.

Not run (out of time): access-match, harness-pi, harness-process, harness-radian,
mcp, pool, review-grading, source-cron, tui. The full-suite "0 of 200" bar is not
established for any package; this survey used 10 reruns.

Tests named in the brief that did **not** fail in 10 reruns: harness-claude cancel
and wall-limit tests (consistent with T-0065), dev/review crash recovery (two
tests), dev/verify "a timeout is not rerun" and "a hanging command fails with a
timeout", dev:rework "rework racing merge in two processes", "switching to WAL
waits while another process holds the database", the serve loop "re-runs a safe
step after the run process is killed", shell/probe timeout and cancel. Rare races
need more than 10 reruns to show; absence here is weak evidence.

## Classification

### Environment: missing workspace module (30 + 20 failures, not flaky)

`gate.test.ts` "a radian Result with a model_error ..." (10 of 10), `dogfood-config`
(20 of 20) and cli `main.test.ts` "init ..." (20 of 20) failed every rerun, with
`Cannot find module '@operad-io/access-match' from packages/harness-radian/src/index.ts`
(seen in the gate and dogfood logs; the cli log was not read, same pattern). This
worktree's `node_modules/@operad-io` has no `access-match` link (only dev, engine,
harness-claude, harness-pi, harness-radian, pool, shell, source-cron), dated before
that package was needed. After `bun install --frozen-lockfile` ("no changes") the
three files passed when run alone, which I cannot explain; the link is still absent.
Classification: **environment / unexplained**, not a flaky test. `scripts/verify.sh`
installs first. Worth a look: a test run should not depend on a stale install.

### Test bug: not rerunnable in one process (18 failures, engine)

Fails on every rerun after the first (9 of 10); the value grows by a fixed step
(`[1,2]` then `[3,4]`, `[5,6]`; log lines `line 1..line 2k+1`). Load is irrelevant.
They break `--rerun-each`, which `scripts/stress.sh` relies on, so a stress run
cannot judge them.
- `packages/engine/test/testing/testing.test.ts:244-247`: the in-process test shares
  module state on purpose; reruns reuse the module, so the counter keeps climbing.
- `packages/engine/test/views/presentation.test.ts:198-217`: the `log` section grows
  per read, and its state outlives the test. I did not locate the exact counter in the
  fixture (my grep found none in `test/views`), so the cause is inferred from the
  growth pattern: unclassified beyond "state shared across reruns".

### Test bug, likely: instant liveness check after a kill (harness-claude, 1 failure; shell, 0 here)

`packages/harness-claude/test/plugin.test.ts:385`, "silence without an open tool call
is a stall": the result was already `failed`/`stall` (lines 383-384 passed), then
`expect(alive(pid)).toBe(false)` got `true` (1 of 10, 626 ms). `alive` is
`process.kill(pid, 0)` (`plugin.test.ts:75-82`) checked immediately. A killed process
is visible to `kill -0` until its parent reaps it; the pid's parent is the killed
worker, so reaping falls to launchd a moment later. The product may instead return
before its SIGKILL sweep lands (`packages/engine/src/platform/process-group.ts:341-401`
repeats SIGKILL for stragglers). I could not tell these apart: nobody captured
`ps -o stat` at failure time. Classification: **test bug (likely), product race not
excluded**.

The observation chased by the previous attempt, a process still alive after its run
ended, is the same assertion: `packages/shell/test/shell.test.ts` ~line 680,
`expect(alive(pid)).toBe(false)` after `endedStatus` is `failed`, with an identical
`alive` helper (`shell.test.ts:57-64`). It did **not** reproduce in 290 shell runs
here. The earlier diagnostic edit (poll `alive`, print `ps`) was reverted and its
finding was never recorded. Unclassified, same suspected cause.

### Unclassified: cli serve restart (1 failure)

`packages/cli/test/serve-restart.test.ts:131`: `operad serve stop` exited 3 instead
of 0 in run 7 of 10 (1.5 s), right after `waitForFile(started)`. Exit 3 is returned
for an action/not-available/unavailable view error or a `StateError`
(`packages/cli/src/main.ts:2271-2287`). The test does not print the stderr of the
stop, so the reason is unknown. I did not read the stop code path. Plausible: stop
raced a serve that was not yet fully registered or was already stopping. Product
race or test bug: unclassified.

## Proposed tasks

Each ends with: the stress command must reach 0 failures of 200 runs.

1. **Make stress-rerunnable the two engine tests** (area: tooling). The engine tests
   `testing.test.ts:244` and `presentation.test.ts:198` fail on every `--rerun-each`
   rerun after the first because state lives in the module. Reset or scope the state
   per test (fresh fixture, counter in the test), without changing what they assert.
   Check: run each file separately with `bash scripts/stress.sh --runs 200 --load 2 <file>` (`packages/engine/test/testing/testing.test.ts`, then `packages/engine/test/views/presentation.test.ts`); both must report 0 failures.
2. **Wait for the process to be gone, and find out why it lingers** (area: tooling /
   engine). Replace the instant `alive(pid)` assertions (`plugin.test.ts:385` and the
   other uses, `shell.test.ts:~680`) with a wait on the event "pid is gone" with a
   bounded timeout; on timeout record `ps -o stat,ppid` so a zombie is told from a
   live process. If a live process remains, that is a product race in the stop path
   (`process-group.ts`) and becomes its own bug. Check: `bash scripts/stress.sh --runs 200 --load 2 packages/harness-claude/test/plugin.test.ts` and `bash scripts/stress.sh --runs 200 --load 2 packages/shell/test/shell.test.ts` must each report 0 failures (whole files, so every test in them runs 200 times).
3. **Say why `serve stop` exited 3, then fix it** (area: cli). Make the serve-restart
   test print stop's stderr on failure, reproduce with
   `bash scripts/stress.sh --runs 20 --load 2 packages/cli/test/serve-restart.test.ts`
   (a first reproduction only), read the stop path, and classify before fixing.
   Check: `bash scripts/stress.sh --runs 200 --load 2 packages/cli/test/serve-restart.test.ts` reports 0 failures.
4. **Do not let tests depend on a stale install** (area: tooling). `harness-radian`
   imports `@operad-io/access-match`, and a worktree with an old install fails
   `dogfood-config`, `gate` and cli `main` tests with "Cannot find module". Either the
   stress script/tests fail fast with "run bun install", or the tests resolve the
   package in source. Check, on a fresh worktree after `bun install --frozen-lockfile`:
   `bash scripts/stress.sh --runs 200 --load 2 packages/dev/test/dogfood-config.test.ts`,
   the same for `packages/cli/test/main.test.ts` and `packages/dev/test/gate.test.ts`
   (gate is slow; run it as its own job), each 0 failures.
5. **Finish the survey** (area: tooling). Run the skipped packages (list above) at
   `--runs 10`, then every package at 20 runs on a quiet machine; run `gate.test.ts`
   in its own job, because 10 reruns under load took 31 minutes. Check: for every
   package, `bash scripts/stress.sh --runs 200 --load 2 packages/<pkg>/test/<file>`
   per file reports 0 failures, or each failure is classified in the report.
6. **Find why `addRepository` sees "not a git work tree" right after the test made one**
   (area: dev). See the two dev failures above (`service.test.ts:419`,
   `cli.test.ts:710`). Make the failing `rev-parse` report its stderr, reproduce, and
   classify (transient git failure under load, a shared scratch path, or a race with
   cleanup) before fixing. Check: `bash scripts/stress.sh --runs 200 --load 2 packages/dev/test/service.test.ts`
   and the same for `packages/dev/test/cli.test.ts` each report 0 failures.

## Follow-up (T-0109): why the tests passed with the link "absent"

The link that mattered was never the root one. `node_modules/@operad-io` at the
repository root links only what the root `package.json` depends on (dev, engine,
harness-claude, harness-pi, harness-radian, pool, shell, source-cron);
`@operad-io/access-match` is a dependency of harness-claude, harness-pi and
harness-radian, so bun links it under each of those packages
(`packages/harness-radian/node_modules/@operad-io/access-match`), and
`packages/harness-radian/src/index.ts` resolves it from there, never from the root.
So the root link was absent before and after `bun install --frozen-lockfile`, and
should be. The stale install was the per-package link: the old worktree lacked it,
and the install, though it printed "no changes" for the lockfile, created it
(`Checked ... installs`, links are made from the manifests). The tests resolve
modules normally; nothing resolves in source.

A check that compares the workspace packages with the root `node_modules/@operad-io`
would therefore always complain about access-match. `scripts/check-install.ts`
instead reads every `package.json` (root and `packages/*`) and requires the
`node_modules/<name>` link under that same directory for each `workspace:`
dependency. `scripts/stress.sh` runs it first, and the `bunfig.toml` test preload
runs it for every `bun test`; a stale install ends with one line, `stale install:
<links> missing; run bun install`.

## Completion (T-0111, 2026-11-09)

Method: `bash scripts/stress.sh --runs 10 --load 2 <file>`, one file at a time, for
the packages the first pass skipped; then 20 runs for every package; then
`packages/dev/test/gate.test.ts` alone. Machine: macOS, 10 CPUs, started 00:04 EST.
"Runs" is the number of test executions the script counted (tests in the file times
10). No code or test is changed. Logs are in the stress script's temp directory and
are not kept in the repository.

### Skipped packages at 10 reruns

| Package | File | Runs | Failures |
|---|---|---|---|
| access-match | match.test.ts | 470 | 0 |
| access-match | summary.test.ts | 300 | 0 |
| harness-pi | pi-install.test.ts | 140 | 0 |
| harness-pi | plugin.test.ts | 540 | 0 |
| harness-pi | spike.test.ts | 60 | 0 |
| harness-pi | worker.test.ts | 440 | 0 |
| harness-process | ask-note.test.ts | 50 | 0 |
| harness-process | descriptor-owner.test.ts | 10 | 0 |
| harness-process | grants.test.ts | 60 | 0 |
| harness-process | jsonl-log.test.ts | 30 | 0 |
| harness-process | limit.test.ts | 50 | 0 |
| harness-process | process.test.ts | 60 | 0 |
| harness-process | stdio-guard.test.ts | 20 | 0 |
| harness-process | tool-events.test.ts | 10 | 0 |
