# Mutation records — `harness-process`

Rows whose mutation broke code in `packages/harness/process/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

## TK0014 — the shared harness process helper

| id | file | mutation | failing test |
|---|---|---|---|
| TK0014-M1 | packages/harness/process/src/process.ts | ignored the `toolEvent` classifier, so no line counted as a tool call | `a pi tool call pauses the stall timer until its end line` |

| id | file | mutation | failing test |
|---|---|---|---|
| TK0009-M9 | packages/harness/process/src/process.ts | the harness drain used `globalThis.setTimeout` instead of the injected clock | `the harness process > a child that leaves the group cannot hold the run open` (timed out) |
| TK0009-M10 | packages/harness/process/src/process.ts | a finished harness run took the grace stop instead of a direct SIGKILL | `the harness process > a child that leaves the group cannot hold the run open` (sleeps 1) |
| T-0021-M9 | packages/harness/process/src/limit.ts | `modelLimit` keyed a model that is not in `concurrency` instead of leaving it unlimited | `harness-pi/agent step limit > a model not in the map, or no model, has no limit` (in `packages/harness/pi`) |
| T-0021-M12 | packages/harness/process/src/limit.ts | `flagValue` kept the first value of a repeated flag | `flagValue > takes the last occurrence of a repeated flag` |
| T-0021-M13 | packages/harness/process/src/limit.ts | `CONCURRENCY_SETTING` dropped `minimum: 1` from its counts | `the concurrency setting > zero, a string, a fraction or a non-object refuse the plugin at load, naming the field` |
| TK0009-M14 | `packages/harness/process/src/process.ts` | the sentinel did not watch its host while the harness ran | `the harness process > a harness still running when its host dies is stopped with its sentinel` |
| T-0025-M7 | `packages/harness/process/src/ask-note.ts` | the paragraph's fixed text changed | `the paragraph is fixed and names the question and the answer` |
| T-0025-M15 | `packages/harness/process/src/ask-note.ts` | newlines in the prompt and the choice were kept | `newlines in the prompt and the choice cannot end the paragraph` |

## T-0040 — the host's side of a one-time permission

| id | file | mutation | failing test |
|---|---|---|---|
| T-0040-M13 | packages/harness/process/src/grants.ts | the `grant_ack` always said `used: true` | `answerGrant > replies used false when the host did not use it` |
| T-0040-M14 | packages/harness/process/src/grants.ts | a host that throws counted as a grant used | `answerGrant > replies used false when the host throws` |
| T-0040-M15 | packages/harness/process/src/grants.ts | `hasGrants` was true for an empty grants list | `hasGrants > is true only for a profile with at least one grant` |
| T-0040-M16 | packages/harness/process/src/grants.ts | a `grant_use` line without a `waitId` was accepted | `grantUse > reads a grant_use line and nothing else` |

## T-0099 — a message to a running agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M1 | packages/harness/process/src/process.ts | a message was written to stdin as bare text, not a `message` line | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |
| T-0099-M2 | packages/harness/process/src/process.ts | the inbox listener was not dropped when the run ended | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |

## T-0099 — rework 1: the run reports its wall time

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M3 | packages/harness/process/src/process.ts | the run did not tell the inbox its wall time when it began | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |
| T-0187-M3 | packages/harness/process/src/ask-call.ts | a timeout rejection was read as an allow | `createCallAsker > reject_once and a timeout rejection answer deny` |
| T-0187-M4 | packages/harness/process/src/ask-call.ts | questions were asked at once instead of one at a time | `createCallAsker > questions are asked one at a time` |
| T-0187-M6 | packages/harness/process/src/ask-call.ts | the question carried no grant under `resume` | `harness-claude: a call that must ask a person > answered later: the session resumes with the one-time permission, and any other call asks again` |
| T-0187-M11 | packages/harness/process/src/ask-call.ts | the degraded question did not reject once after the grace | `harness-radian: a question is reject_once > a grace that passes is a refusal: the step goes on with rejected true and never ends waiting` |

## T-0205 — the sentinel's host check works under dash

| id | file | mutation | failing test |
|---|---|---|---|
| T-0205-M1 | packages/harness/process/src/process.ts | the sentinel killed its group with `kill -KILL -- "-$$"`, which dash rejects, so a harness whose host died stayed running | `the harness process > a harness still running when its host dies is stopped with its sentinel` (Linux) |
| T-0188-M15 | packages/harness/process/src/ask-call.ts | a read-only profile did not open the question channel | `canAsk > is true only for a profile with an askCommands rule` |

## T-0297 — follow-ups from the flaky-test work

| id | file | mutation | failing test |
|---|---|---|---|
| T-0297-M1 | packages/harness/process/test/support.ts | `pidValue` accepted 0 and 1 as pids | `test support > a pid must be a finite integer above 1` |
| T-0335-M2 | packages/harness/process/src/ask-call.ts | a refusal's note was dropped, so the program got the generic reason | `createCallAsker > a refusal's note is the reason the program gets` |
