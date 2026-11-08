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

(none else yet)

## Proposed tasks

(none yet)
