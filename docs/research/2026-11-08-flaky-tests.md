# Flaky-test survey after T-0065 (2026-11-08)

Status: in progress. T-0065 (cancel-hang) is merged (`d5c87c2` on origin/main).
Per the rework brief: `bash scripts/stress.sh --runs 10 --load 2 packages/<pkg>/test`
per package (not 20), order engine, shell, dev, harness-claude, cli, then the rest
if time remains. Machine: macOS, 10 CPUs. No code or test is changed by this task.

## Results

| Package | Runs | Failures | Failing tests (count) | Wall time |
|---|---|---|---|---|

## Not yet run

engine, shell, dev, harness-claude, cli, access-match, harness-pi, harness-process,
harness-radian, mcp, pool, review-grading, source-cron, tui

## Classification

(none yet)

## Proposed tasks

(none yet)
