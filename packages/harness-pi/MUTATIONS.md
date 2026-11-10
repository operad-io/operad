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
| T-0025-M5 | `packages/harness-pi/src/worker.ts` | a call that matched a grant ran whether or not the host used the grant up | `a granted call runs once after the host used the grant; the same call again and another call are blocked` |
| T-0025-M6 | `packages/harness-pi/src/index.ts` | the step answered `used: true` without asking the engine to use the grant | `harness-pi/agent > a grant in the profile is used through the host before the program goes on` |
| T-0036-M1 | packages/harness-pi/src/pi-install.ts | the walk up accepted a `package.json` of any name | `findPi > a package.json with another name all the way up is refused (and the wrapper test)` |
| T-0036-M2 | packages/harness-pi/src/pi-install.ts | the version floor was not enforced | `findPi > a version below the floor is refused naming both versions` |
| T-0036-M3 | packages/harness-pi/src/pi-install.ts | a prerelease compared equal to its release | `findPi > a prerelease of the floor is below it; a prerelease above it is accepted` |
| T-0036-M4 | packages/harness-pi/src/pi-install.ts | `exports["."]` conditions were not read (only `types`) | `findPi > finds a bun global install and an npm global install` |
| T-0036-M5 | packages/harness-pi/src/pi-install.ts | the command was not resolved to its real path (symlinks not followed) | `findPi > finds a bun global install and an npm global install` |
| T-0036-M6 | packages/harness-pi/src/pi-install.ts | `exports["."]` was not looked up | `findPi > finds a bun global install and an npm global install` |
| T-0036-M7 | packages/harness-pi/src/worker.ts | the worker did not log the pi version it loaded | `the worker logs the pi version it loaded and where from` |
| T-0036-M8 | packages/harness-pi/src/worker.ts | the worker ignored `piCommand` and always looked up `pi` | `without a pi the worker fails with the model_error reason and says what is missing` |
| T-0036-M9 | packages/harness-pi/src/index.ts | the `command` setting was not passed to the worker | `harness-pi:prompt > the command setting reaches the worker as piCommand; unset it is pi` |
| T-0036-M10 | packages/harness-pi/src/index.ts | `check` did not look for pi | `harness-pi check > refuses when there is no pi on PATH` |
| T-0036-M11 | packages/harness-pi/src/pi-install.ts | an `exports` entry that is missing or outside the package was accepted | `findPi > an exports entry that is not a file in the package is refused` |
| T-0045-M1 | packages/harness-pi/src/worker.ts | a bash call without a `timeout` got none instead of the limit | `a bash call that blocks on a FIFO is stopped by bashTimeoutSecs, the model gets an error and the run ends done` |
| T-0045-M2 | packages/harness-pi/src/worker.ts | the worker kept `BASH_ENV` in its environment | `the agent's shell does not read BASH_ENV, where a user's aliases and functions could come from` |
| T-0045-M3 | packages/harness-pi/src/index.ts | the `bashTimeoutSecs` setting was not passed to the worker | `harness-pi/agent > bashTimeoutSecs reaches the worker; unset it is 1800` |
| T-0045-M4 | packages/harness-pi/src/protocol.ts | `parseInput` accepted a `bashTimeoutSecs` of 0 | `parseInput refuses a bashTimeoutSecs that is 0, negative, fractional or not a number, and names the field` |
| T-0063-M1 | packages/harness-pi/src/worker.ts | `tool_execution_end` wrote `durationMs: 0` | `a bash call logs its command, its start time and its duration, and no output` |
| T-0063-M30 | packages/harness-pi/src/worker.ts | the blocked line and the call end logged the real refusal reason | `a read of a denied path is blocked; an allowed read runs` |
| T-0063-M31 | packages/harness-pi/src/worker.ts | the summary ignored `secretValues` | `a secret of the operad store sent as secretValues is masked in the logged command` |

## T-0099 — a message to a running agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M1 | packages/harness-pi/src/worker.ts | a `message` line was not steered into the session | `a message line from the host steers the agent: the model's next call sees it` |
| T-0099-M2 | packages/harness-pi/src/index.ts | the step did not pass the inbox to the process | `harness-pi/agent > a message the host sends through the inbox reaches the program as a message line` |
| T-0187-M8 | packages/harness-pi/src/worker.ts | an `allow` answer did not let the call through | `a command askCommands matches asks a person: allowed, it runs once; the same command again asks again` |
| T-0187-M9 | packages/harness-pi/src/worker.ts | a command holding a secret value was asked about | `a command that holds a secret value is refused and never asked about` |
| T-0187-M10 | packages/harness-pi/src/index.ts | the step did not throw the unanswered question, so no `waiting` result | `harness-pi: a call that must ask a person > not answered in time: the step ends waiting, the process exits, the one item stays` |
