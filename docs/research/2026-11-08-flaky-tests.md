# Flaky-test survey after T-0065 (2026-11-08)

Status: in progress. T-0065 (cancel-hang) is merged (`d5c87c2` on origin/main).
Per the rework brief: `bash scripts/stress.sh --runs 10 --load 2 packages/<pkg>/test`
per package (not 20), order shell, dev, harness-claude, cli, then the rest
if time remains. Machine: macOS, 10 CPUs. No code or test is changed by this task.

## Results

| Package | Runs | Failures | Failing tests (count) | Wall time |
|---|---|---|---|---|
| engine | 5640 (564 tests x 10) | 18 | `isolation > in process, module state is shared: faster, not isolated` 9; `presentation views > reads sections, pages with next and grows a live section` 9 | 8m56s |
| shell | 290 | 0 | none | 1m29s |
| harness-claude | 10 x 10 files' tests (per file) | 1 | `harness-claude/agent > silence without an open tool call is a stall` 1 | about 4m (per file: 1-139 s) |
| dev (partial, per file; see below) | in progress | | | |

## Not yet run

shell, dev, harness-claude, cli, access-match, harness-pi, harness-process,
harness-radian, mcp, pool, review-grading, source-cron, tui

## Classification

### engine

Both failures are 9 of 10 reruns: every rerun after the first fails, with a value
that grows by a fixed step each time (counts `[1,2]` become `[3,4]`, `[5,6]`, ...;
the log section shows `line 1..line 2k+1`). Load plays no part. They are not flaky
under real runs; they are not rerunnable in one process, which is what
`bun test --rerun-each` (used by `scripts/stress.sh`) does.

- `packages/engine/test/testing/testing.test.ts:244-247`: classification **test bug
  (not rerunnable)**. The in-process test shares module state on purpose, and
  `--rerun-each` reuses the module, so the counter keeps climbing.
- `packages/engine/test/views/presentation.test.ts:198-217`: classification **test
  bug (not rerunnable)**. The "live section" fixture appends a line per read and
  its counter is module state; the second run starts from the first run's count.

### shell

0 of 290. The "process alive after the run ended" observation from the previous
attempt (`packages/shell/test/shell.test.ts` ~line 680, `expect(alive(pid)).toBe(false)`
after `endedStatus` is `failed`) did **not** reproduce here in 10 runs under load 2.
The earlier attempt saw it only in the gate run; its diagnostic edit was reverted
and nothing was recorded about what held the process. Status: **unclassified**; the
check is a single `kill -0` straight after the run ends, so it can miss a process
that is still being reaped (signal sent, not yet gone). Proposed task below.

### dev

Per-file runs (10 reruns, load 2); the whole-package run hit the 20-minute tool limit
and was discarded. Other sessions on this machine (a T-0091 stress run) add load
during every number here.

- `dogfood-config.test.ts`: 2 tests x 10 = 20 failures in 1 s. **Environment, not
  flaky**: `Cannot find module '@operad-io/access-match' from
  packages/harness-radian/src/index.ts`. This worktree had no `bun install`, so the
  workspace link was missing; `scripts/verify.sh` installs first. Not a test defect.

### harness-claude

The cancel and wall-limit tests named in the brief ("cancel stops the worker and
reports interrupted", "the wall limit still stops a run while a tool call is open")
did not fail in 10 reruns: consistent with T-0065 having fixed them. Run in
parallel with the dev run, so load was higher than `--load 2` alone.

- `packages/harness-claude/test/plugin.test.ts:385` "silence without an open tool
  call is a stall": `expect(alive(pid)).toBe(false)` received `true`, 1 of 10, at
  626 ms. The run had already reported `failed`/`stall` (lines 383-384 passed).
  `alive` (`plugin.test.ts:75-82`) is `process.kill(pid, 0)` straight after the
  result. A killed process stays visible to `kill -0` until its parent reaps it
  (zombie), and this pid's parent is the killed worker, so launchd reaps it a
  moment later. Classification: **test bug, likely** (an instant liveness check
  with no wait for the event "pid is gone"); not proven, since the product might
  also return before its SIGKILL sweep has taken effect (`engine/src/platform/process-group.ts:341-401`
  repeats SIGKILL for stragglers after the stop returns). Needs the process state
  (`ps -o stat`) at failure time to separate the two; nobody captured it.
- This is the same assertion shape as `packages/shell/test/shell.test.ts:~680`
  (`expect(alive(pid)).toBe(false)` after the run ended) which the previous attempt
  chased: same cause class, same unresolved question. Both use the identical
  `alive` helper.
- Also in the log: `plugin "harness-claude": args.settings.concurrency.sonnet:
  must be at least 1` printed on runs 1-9 (not a failure; a deliberate
  validation-error test writing to stderr).

(none else yet)

## Proposed tasks

(none yet)
