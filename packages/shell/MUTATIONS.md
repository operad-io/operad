# Mutation records — `shell`

Rows whose mutation broke code in `packages/shell/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

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
