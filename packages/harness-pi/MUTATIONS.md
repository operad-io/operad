# Mutation records — `harness-pi`

Rows whose mutation broke code in `packages/harness-pi/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0013-M1 | packages/harness-pi/spike/fake-provider.ts | dropped the tool call from the fake assistant message | `a tool call to read runs` |
| TK0013-M2 | packages/harness-pi/spike/pi-session.ts | `createSpikeSession` ignored the supplied session manager and used an in-memory one | `a session file reopens and a second prompt sees the first message` |
| TK0013-M3 | packages/harness-pi/spike/fake-provider.ts | set `usage.totalTokens` to 0 in the fake assistant message | `a prompt ends with the fixed answer and message_end carries usage` |
| TK0013-M4 | packages/harness-pi/spike/auth-writer.ts | `hold` mode wrote its credential without taking the lock | `auth.json locking blocks a second writer until the lock is released` |
| TK0013-M5 | packages/harness-pi/spike/auth-writer.ts | `unlocked-read` read the file after the gate instead of snapshotting it before | `the same read-modify-write without the lock loses a credential` |
| pi-step-model-M1 | packages/harness-pi/src/index.ts | the setting won over the `--model` flag | `--model and --thinking in args reach the worker and win over the settings` |
| pi-step-model-M2 | packages/harness-pi/src/index.ts | removed the "given twice" check for `--model` | `a model given twice fails with invalid_args and the worker is not started` |
| pi-step-model-M3 | packages/harness-pi/src/index.ts | an unknown entry in `args` was skipped instead of rejected | `an unknown flag fails with invalid_args and the worker is not started` |
| T-0022-M7 | packages/harness-pi/src/index.ts | the usage left the model out (`model: null`) | `harness-pi/agent > the usage names the model setting when the step has no --model` |
| T-0022-M10 | packages/harness-pi/src/worker.ts | the worker's cost did not say `incomplete` when a message had no price | `a run where one message had no price reports the priced part as incomplete` |
| T-0022-M11 | packages/harness-pi/src/index.ts | an early failure recorded `model: null` | `harness-pi/agent > a step that fails before it starts still records the model it named` |
