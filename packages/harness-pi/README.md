# @operad-io/harness-pi

The pi harness. `src/worker.ts` is the child program: it imports pi's library,
reads one JSON object from stdin, runs one prompt and writes one JSON object per
line to stdout. The last line is the `Result`. The hub-side step that spawns it
is a later task. Decisions: `docs/backlog/operad-harness-pi.md` 2, 3, 5, 6.

Run it as `bun packages/harness-pi/src/worker.ts`. stderr is free text for
humans and is never parsed.

pi does no discovery here: the only extension is operad's inline one, settings
are in memory, and every path pi uses comes from the input (`agentDir`,
`sessionDir`, `authPath`, `modelsPath`). Nothing under the user's `~/.pi` is
read unless the input names it.

## stdin

One JSON object, then EOF. `test/protocol.test.ts` checks the program against
this table.

| field | type | required | meaning |
|---|---|---|---|
| `prompt` | string, non-empty | yes | the text sent to the model |
| `cwd` | string, non-empty | yes | working directory of the agent |
| `authPath` | string, non-empty | yes | pi's credentials file |
| `modelsPath` | string, non-empty | yes | pi's custom models file |
| `agentDir` | string, non-empty | yes | pi's agent directory (empty of user config) |
| `sessionDir` | string, non-empty | yes | directory for session files |
| `resumeSession` | string, non-empty | no | session file path from an earlier `Result.sessionId`; the prompt is sent into it |
| `model` | string `provider/id` | no | model to use; absent means pi's own default |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` | no | reasoning level; absent means pi's default |
| `access` | object | no | the access profile; this version accepts and ignores it (the `tool_call` handler only logs) |

An invalid object (not JSON, not an object, a required field missing or of the
wrong type, an optional field of the wrong type) writes one `Result` line with
`result: "failed"` and `message` naming the field, and exits 2.

## stdout

One JSON object per line, flushed per line, each with a `type`. Only these
types appear, in the order the run produces them:

| type | other fields | meaning |
|---|---|---|
| `message_end` | `role` (`"assistant"`), `stopReason` (string), `usage` (`{input, output, cache_read, cache_write}`, numbers), `cost` (`{total}` in USD, or `null` when pi gave no price) | an assistant message finished; only assistant messages are written |
| `tool_execution_start` | `toolCallId`, `toolName` | a tool call began |
| `tool_execution_end` | `toolCallId`, `toolName`, `isError` (boolean) | a tool call ended |
| `blocked` | `toolName`, `reason` | reserved for the access matcher; never written yet |
| `agent_settled` | `aborted` (boolean) | pi has stopped for good (not `agent_end`, after which pi may continue) |
| `result` | see below | always the last line |

### Result

| field | type | required | meaning |
|---|---|---|---|
| `type` | `"result"` | yes | |
| `result` | `"done"`, `"failed"` or `"cancelled"` | yes | how the run ended |
| `sessionId` | string or null | yes | the session file path; null when no session was opened |
| `usage` | `{input?, output?, cache_read?, cache_write?}` | yes | sums over every `message_end` (`cacheRead` becomes `cache_read`, `cacheWrite` becomes `cache_write`) |
| `cost` | `{micros}` or null | yes | `round(sum of cost.total × 1e6)`; null when any `message_end` had no price, or there was none |
| `finalMessage` | string or null | yes | `getLastAssistantText()` |
| `reason` | string | on `failed` | a short condition name: `invalid_input`, `session_missing`, `model_missing`, `model_error` (also used for an unexpected error) |
| `message` | string | on `failed` | human text; names the field or path at fault |

## Exit codes

| code | when |
|---|---|
| 0 | `done` |
| 1 | `failed` after the input was valid |
| 2 | invalid input |
| 143 | SIGTERM: the program calls `abort()`, waits for idle, writes a `cancelled` Result and exits |

## Resume

With `resumeSession` the program opens that file with `SessionManager.open`
and sends the new prompt into it. A file that does not exist is `failed` with
the path in `message`. `sessionId` of the new Result is the same path.

## Tests

`test/fake-worker.ts` runs the same program with a fake model registered
(`test/fake-provider.ts`); the script comes from the `FAKE_SCRIPT` environment
variable. It exists because a model cannot travel over the stdin protocol.
