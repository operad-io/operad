# Mutation records — `harness-process`

Rows whose mutation broke code in `packages/harness-process/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0009-M9 | packages/harness-process/src/process.ts | the harness drain used `globalThis.setTimeout` instead of the injected clock | `the harness process > a child that leaves the group cannot hold the run open` (timed out) |
| TK0009-M10 | packages/harness-process/src/process.ts | a finished harness run took the grace stop instead of a direct SIGKILL | `the harness process > a child that leaves the group cannot hold the run open` (sleeps 1) |
Rows whose mutation broke code in `packages/harness-process/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0021-M9 | packages/harness-process/src/limit.ts | `modelLimit` keyed a model that is not in `concurrency` instead of leaving it unlimited | `harness-pi/agent step limit > a model not in the map, or no model, has no limit` (in `packages/harness-pi`) |
| T-0021-M12 | packages/harness-process/src/limit.ts | `flagValue` kept the first value of a repeated flag | `flagValue > takes the last occurrence of a repeated flag` |
| T-0021-M13 | packages/harness-process/src/limit.ts | `CONCURRENCY_SETTING` dropped `minimum: 1` from its counts | `the concurrency setting > zero, a string, a fraction or a non-object refuse the plugin at load, naming the field` |
| TK0009-M14 | `packages/harness-process/src/process.ts` | the sentinel did not watch its host while the harness ran | `the harness process > a harness still running when its host dies is stopped with its sentinel` |
| T-0025-M7 | `packages/harness-process/src/ask-note.ts` | the paragraph's fixed text changed | `the paragraph is fixed and names the question and the answer` |
| T-0025-M15 | `packages/harness-process/src/ask-note.ts` | newlines in the prompt and the choice were kept | `newlines in the prompt and the choice cannot end the paragraph` |

## T-0040 — the host's side of a one-time permission

| id | file | mutation | failing test |
|---|---|---|---|
| T-0040-M13 | packages/harness-process/src/grants.ts | the `grant_ack` always said `used: true` | `answerGrant > replies used false when the host did not use it` |
| T-0040-M14 | packages/harness-process/src/grants.ts | a host that throws counted as a grant used | `answerGrant > replies used false when the host throws` |
| T-0040-M15 | packages/harness-process/src/grants.ts | `hasGrants` was true for an empty grants list | `hasGrants > is true only for a profile with at least one grant` |
| T-0040-M16 | packages/harness-process/src/grants.ts | a `grant_use` line without a `waitId` was accepted | `grantUse > reads a grant_use line and nothing else` |

## T-0099 — a message to a running agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M1 | packages/harness-process/src/process.ts | a message was written to stdin as bare text, not a `message` line | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |
| T-0099-M2 | packages/harness-process/src/process.ts | the inbox listener was not dropped when the run ended | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |
