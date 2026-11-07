# @operad-io/harness-claude

The claude harness. `src/worker.ts` is the child program: it runs one prompt
through the Agent SDK, which starts your own `claude` command. It reads one
JSON object from stdin and writes one JSON object per line to stdout. The last
line is the `Result`. Decisions: `docs/backlog/operad-harness-claude.md` 2 to 8.

Run it as `bun packages/harness-claude/src/worker.ts`. stderr is free text for
humans and is never parsed.

operad bundles no Claude Code. The root `package.json` replaces the eight
platform packages of the SDK with empty ones (`SPIKE.md`), and the worker finds
`claude` on `PATH` (or at the `command` it is given) and resolves its real path.
The login is the one `claude` already has; the worker passes no credential. A
`CLAUDE_CODE_OAUTH_TOKEN` in the environment (from `claude setup-token`) reaches
`claude` unchanged, and nothing is logged from the environment.

`claude` runs with `settingSources: []`, `permissionMode: 'default'`,
`permissionPrompts: 'host'`, the `claude_code` system prompt preset with nothing
appended and the SDK's default tools. `canUseTool` is the only permission
surface. These names are set in its environment: `CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`
(all `1`). Auto compaction and tool search are left on: a long run needs
compaction.

## stdin

One JSON object, then EOF (the step may keep stdin open for `grant_ack` lines).
`test/protocol.test.ts` checks the program against this table. A field not in
the table is refused, not ignored.

| field | type | required | meaning |
|---|---|---|---|
| `prompt` | string, non-empty | yes | the text sent to the model |
| `cwd` | string, non-empty | yes | working directory of the agent |
| `command` | string, non-empty | no | the claude command, a name on PATH or a path; absent means `claude` |
| `resumeSession` | string, a UUID | no | a `sessionId` from an earlier `Result`; the prompt is sent into that session |
| `model` | string, non-empty | no | model name for claude (`--model`); absent means claude's own default |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max` | no | reasoning effort; absent means claude's default |
| `access` | object | no | the access profile; checked when it is read (the matching comes with the access task) |
| `maxTurns` | positive integer | no | SDK `maxTurns`; absent means no limit |
| `budgetUsd` | positive number | no | SDK `maxBudgetUsd`; absent means none |

An invalid object (not JSON, not an object, a required field missing or of the
wrong type, an unknown field) writes one `Result` line with `result: "failed"`,
`reason: "invalid_input"` and `message` naming the field, and exits 2.

## stdout

One JSON object per line, flushed per line, each with a `type`:

| type | other fields | meaning |
|---|---|---|
| `message_end` | `role` (`"assistant"`), `stopReason` (string or null), `usage` (`{input, output, cache_read, cache_write}`), `cost` (always `null`: claude prices a run, not a message) | an assistant message finished; written once per message |
| `tool_execution_start` | `toolCallId`, `toolName` | a tool call began (the `PreToolUse` hook) |
| `tool_execution_end` | `toolCallId`, `toolName`, `isError` | a tool call ended (`PostToolUse`, `PostToolUseFailure`, or a refusal) |
| `blocked` | `toolName`, `reason` | `canUseTool` refused a call; its `tool_execution_end` has `isError: true`; the run continues |
| `rate_limit` | `status`, `rateLimitType` (or null), `resetsAt` (or null) | claude reported its rate limit state |
| `grant_use` | `id`, `waitId` | asks the host to use up a one-time permission; answered on stdin by `{"type":"grant_ack","id":n,"used":true\|false}` |
| `result` | see below | always the last line |

### Result

| field | type | meaning |
|---|---|---|
| `type` | `"result"` | |
| `result` | `"done"`, `"failed"` or `"cancelled"` | how the run ended |
| `sessionId` | string or null | claude's `session_id`; its file is in `~/.claude/projects/`, and `claude --resume <id>` continues it |
| `usage` | `{input, output, cache_read, cache_write}` | the result's four counters (`cache_creation_input_tokens` is `cache_write`); `{}` when there was no result |
| `cost` | `{micros, quality}` or null | `round(total_cost_usd × 1e6)`; `quality` is `estimated` with a subscription login (an API-price figure, not a charge) and `exact` otherwise |
| `finalMessage` | string or null | the result's `result` text |
| `model` | string or null | the first key of the result's `modelUsage` |
| `reason` | string | on `failed`: `invalid_input`, `session_missing` (claude has no such session) or `model_error` (also: claude is not installed, or it ended with no result) |
| `message` | string | on `failed`: human text |
| `modelError` | `{kind: "usage_limit", message, rateLimitType, resetsAt}` | on `failed`, when claude reported a rejected rate limit |

A result with `is_error`, or any subtype but `success` (`error_max_turns`,
`error_max_budget_usd`, ...), is `failed` with reason `model_error`.

## Exit codes

| code | when |
|---|---|
| 0 | `done` |
| 1 | `failed` after the input was valid |
| 2 | invalid input |
| 143 | SIGTERM: the program aborts the SDK query, writes a `cancelled` Result and exits |

## Tests

`test/fake-claude.ts` is a fake `claude` process handed to the SDK through
`spawnClaudeCodeProcess`: it answers the SDK's control requests and replays fixed
stream-json from a script, so no test runs the real `claude` or sends a model
request. `test/fake-worker.ts` runs the same `main` with that fake; the script
comes from `FAKE_SCRIPT` and what the fake saw goes to `FAKE_RECORD`.
