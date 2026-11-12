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
| T-0327-M10 | packages/harness/process/src/ask-call.ts | `canAsk` ignored `allowMcp`, so a bot's unlisted MCP tool could not ask a person | `canAsk > is true for a profile that puts MCP tools under it, even with none listed` |
| T-0339-M20 | packages/harness/process/src/images.ts | `parseImageInputs` took any media type | `parseInput refuses an image that is not a path with an image media type` (claude) |

## T-0358 — agent lines, the fold and the receiver

| id | file | mutation | failing test |
|---|---|---|---|
| T-0358-M1 | packages/harness/process/src/jsonl-log.ts | the flush timer waited twice FLUSH_MS | `jsonl log flush timing > a line is written when its 250 ms are up, without more lines` |
| T-0358-M2 | packages/harness/process/src/jsonl-log.ts | a flush did not cancel the pending timer | `jsonl log flush timing > a full buffer and end cancel the timer` |
| T-0358-M3 | packages/harness/process/src/fold-lines.ts | a call with a `blocked` line settled as `failed` | `foldLines > a blocked call is blocked, with the reason as its error` |
| T-0358-M4 | packages/harness/process/src/fold-lines.ts | a text increment replaced the text so far instead of adding to it | `foldLines > increments add up to the finished text, and a finished message wins over the increments` |
| T-0358-M5 | packages/harness/process/src/fold-lines.ts | `message_end` text was added even when the message's text had come as lines | `foldLines > today's message_end text is an entry only when no text came before it` |
| T-0358-M6 | packages/harness/process/src/fold-lines.ts | a call that ended stayed in the unfinished calls | `foldLines > a tool call with an end is an entry with its facts` |
| T-0358-M7 | packages/harness/process/src/lines.ts | `capToolOutput` never cut | `capToolOutput > keeps short text and cuts long text at the cap without splitting a character` |
| T-0358-M8 | packages/harness/process/src/lines.ts | a receiver that threw stopped the step | `claude/agent > a receiver that throws does not stop the step` |
| T-0358-M13 | packages/harness/process/src/lines.ts | `capToolOutput` dropped a trailing U+FFFD even when it was a real character | `capToolOutput at the cap > a valid U+FFFD that ends exactly at the cap is kept` |
| T-0358-M14 | packages/harness/process/src/lines.ts | `deliverLine` handed the line over without masking secrets | `maskSecrets > masks a value as written, and as JSON text writes it` (unit) and the three `a receiver gets a line ... masked` step tests |

## T-0366 — allow_always and its user layer

| id | file | mutation | failing test |
|---|---|---|---|
| T-0366-M2 | packages/harness/process/src/ask-call.ts | a question that offered `allow_always` did not let either approving answer give the late permission | `askRequest > allowAlways offers allow_always and lets either approving answer give the late permission` |
| T-0366-M3 | packages/harness/process/src/ask-call.ts | `allow_always` allowed the call but did not write the user layer | `createCallAsker > allow_always answers allow and writes the exact call to the user layer` |
| T-0366-M4 | packages/harness/process/src/always-allow.ts | an invalid user layer was read as empty without its readable problem | `readAlwaysAllow > an invalid file is empty with a readable message naming the file` |
| T-0366-M5 | packages/harness/process/src/always-allow.ts | `personStarted` took every trigger for a person's message, so a background run consulted the user layer | `pi: a call that must ask a person > a background run ignores the user layer and is not offered allow_always` |
| T-0366-M10 | packages/harness/process/src/ask-call.ts | a later identical call ignored the entry `allow_always` had just written and asked again | `createCallAsker > a later identical call after allow_always is let through without asking again` |
