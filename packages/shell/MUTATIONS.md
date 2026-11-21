# Mutation records — `shell`

Rows whose mutation broke code in `packages/shell/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

## T-0019-http-api — rework 2: the cancel test waits on no real timer

| id | file | mutation | failing test |
|---|---|---|---|
| T-0019-http-api-M9 | packages/shell/src/process.ts | the stop skipped its grace SIGKILL, so a line that ignores SIGTERM kept the group alive | `shell/command > cancel stops the process group and reports interrupted` (timed out after 5000ms) (removed) |

| id | file | mutation | failing test |
|---|---|---|---|
| TK0017-M1 | packages/shell/src/index.ts | reported a non-zero exit as a pass | `shell/command > a non-zero exit is a failure with its code and output path` |
| TK0017-M2 | packages/shell/src/index.ts | kept running check lines after the first failure | `shell/check > stops at the first failure and names the line` |
| TK0017-M3 | packages/shell/src/index.ts | never compared a probe's exit code with the previous probe | `shell/probe > becomes ready when the exit code differs from the previous probe` |
| TK0017-M4 | packages/shell/src/index.ts | reported a timeout as a signal failure | `shell/command > a timeout is a failure that says so` |
| TK0017-M5 | packages/shell/src/index.ts | skipped the working-directory check, so a missing cwd became a spawn failure | `shell/command > a cwd that does not exist fails with a clear reason` (and the same check test) |
| TK0017-M13 | packages/shell/src/index.ts | ignored the injected clock for `shell/command` | `shell/command > a timeout is a failure that says so` |
| TK0017-M14 | packages/shell/src/index.ts | passed no timeout to a `shell/check` line | `shell/check > a line that exceeds the timeout fails and names it` |
| TK0017-M18 | packages/shell/src/index.ts | stopped passing the step's `env` to the line runner | `shell/command > env is added to the command's environment` |
| TK0009-M6 | packages/shell/src/index.ts | the aborted-before-first-line branch named a log that was never written | `shell/check > an abort before the first line is interrupted and leaves a log` |
| T-0107-M2 | packages/shell/test/support.ts | `alive` always reported the pid present, so `waitForGone` never saw it go | `shell/command > cancel stops the process group and reports interrupted`, `shell/command > a child that outlives the line is in the group and is stopped`, `a flow through the runner > a run cancel stops the command's process group in a worker` |

## T-0402-check-stall-limit — a stopped command reports a stall

| id | file | mutation | failing test |
|---|---|---|---|
| T-0402-M1 | packages/shell/src/index.ts | `shell/check` ignored the runner's `stalled` outcome, so a stopped command reported a signal instead of `stall` | `shell/check > a check that writes nothing for stallSecs is stopped and names its last lines` (expected `stall`, received `signal`) |

## T-0533 — outward commands
| id | file | mutation | failing test |
|---|---|---|---|
| T-0533-M9 | packages/shell/src/index.ts | `shell/command` stopped checking its line for an outward write | `shell/command > a background run asks before an outward command and names its target` |
| T-0533-M11 | packages/shell/src/index.ts | `shell/probe` stopped checking its line for an outward write | `shell/command > shell/probe checks an outward line before it runs it` |

## T-0534 — shell outward writes use the flow's target grant

| id | file | mutation | failing test |
|---|---|---|---|
| T-0534-M1 | packages/shell/src/index.ts | the outward guard got no flow, so it could not use or record a target grant | `shell/command > always for this flow and target lifts the next run's outward question` |

## T-0636 — a check line gets the environment a plugin passes

| id | file | mutation | failing test |
|---|---|---|---|
| T-0636-M6 | packages/shell/src/index.ts | `shell/check` no longer passed `params.env` to each line | `shell/check > env is added to every line's environment` |
