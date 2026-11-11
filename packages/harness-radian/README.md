# @operad-io/harness-radian

The `harness-radian` plugin: one `agent` step that runs `radian exec` in a
directory and reads its closing result, and the `harness-radian:prompt` flow
that runs one prompt.

## Asking and resuming

The step is `resumable: true`: its params may carry `resumeSession` (passed as
`--resume`) and `askAnswer`, which adds `You asked: <prompt>. The answer is:
<answer>. Continue.` to the prompt.

radian has no hook that sees its tool calls, so this harness cannot let one call
through and no other. The step says `grants: false`, so `ctx.ask` refuses a
question that offers a one-time permission before anyone is asked. A run whose
access profile has one anyway is refused by the step with the reason
`grant_unsupported`, naming radian; use `harness-pi` for flows that grant.

radian is the degraded harness for questions (`operad-contract.md` decision 6):
its step declares no `enforces`, so a profile with `askCommands` is refused at
start with the field named, and a question the step asks is `reject_once` with no
grant (`degradedAskRequest` in `@operad-io/harness-process`): once the grace
passes it is refused, because a late `allow_once` could not be carried out.
`harness-claude` and `harness-pi` do the full loop.

With `resumeSession`, the `Result` must name that same session; another id fails
the step with `session_missing`, because radian started afresh.

## Settings

The `harness-radian` section of `config.json`.

| setting | type | default | meaning |
|---|---|---|---|
| `command` | string | `radian` | the radian executable to run |
| `wallTimeSecs` | number | `300` | the longest one run may take |
| `stallSecs` | number | `600` | how long a run may print nothing |
| `concurrency` | object, model to positive integer | `{}` | how many runs of one model may go at once, such as `{ "opencode-go/deepseek-v4.1-flash": 2 }`; a model not listed has no limit |

How `concurrency` limits runs, what the key is and how a queued step shows
are in [the manual](../../docs/manual.md#limiting-runs-of-one-model).

## The log's tool lines

The step rewrites radian's `ToolExecutionStarted` and `ToolExecutionSettled`
journal lines as `tool_execution_start` and `tool_execution_end`, the lines
`harness-claude` and `harness-pi` write. The start carries `at` and `input`
(the command, first 500 characters, or the path or main argument; environment
assignment values and secret values are masked); the end carries `durationMs` and, for an
error, its first line as `error`. The tool name, call id and arguments are
read from `toolName`, `toolCallId` and `input` (also `tool`, `args` and
`id`), at the top of the line or under `data`. A call the run's
access profile denies is written as `<tool> denied by the access profile`.
Tool output is never written. The dev task's Log section renders these lines
like the other harnesses'.
