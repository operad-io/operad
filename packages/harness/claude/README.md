# @operad-io/harness-claude

The claude harness. `src/worker.ts` is the child program: it runs one prompt
through the Agent SDK, which starts your own `claude` command. It reads one
JSON object from stdin and writes one JSON object per line to stdout. The last
line is the `Result`. Decisions: `docs/backlog/operad-harness-claude.md` 2 to 8.

Run it as `bun packages/harness/claude/src/worker.ts`. stderr is free text for
humans and is never parsed.

operad bundles no claude. The root `package.json` replaces the eight
platform packages of the SDK with empty ones
(`docs/backlog/operad-harness-claude.md` decision 2), and the worker finds
`claude` on `PATH` (or at the `command` it is given) and resolves its real path.
The login is the one `claude` already has; the worker passes no credential. A
`CLAUDE_CODE_OAUTH_TOKEN` in the environment (from `claude setup-token`) reaches
`claude` unchanged, and nothing is logged from the environment.

`claude` runs with `settingSources: []`, `permissionMode: 'default'`,
`permissionPrompts: 'host'`, the `claude_code` system prompt preset with nothing
appended and the SDK's default tools. `canUseTool` is the only permission
surface. These names are set in its environment: `CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`
(all `1`), and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so no command moves to the
background. A run is one foreground turn: the tools that only schedule or wait for
work outside the turn (`Monitor`, `ScheduleWakeup`, `CronCreate`, `CronDelete`,
`CronList`, `TaskStop`) are in `disallowedTools`, and `BASH_DEFAULT_TIMEOUT_MS` and
`BASH_MAX_TIMEOUT_MS` are set from `bashTimeoutSecs` so a gate (a full test run)
finishes in the foreground instead of after claude's default 120 s. claude's Bash tool sources a snapshot of the user's `~/.zshrc` or `~/.bashrc`, so the user's aliases apply; claude has no supported switch to turn that off, and operad does not work around it (see "The agent's shell and the user's aliases" in the manual). If claude
starts a second session after its result (a second `system/init`), the worker
stops, logs it and ends `failed` with reason `model_error` and a message that says
so; the first result's usage and session id are kept. Auto compaction and tool search are left on: a long run needs
compaction.

## stdin

One JSON object, then EOF (the step may keep stdin open for `grant_ack` lines).
`test/heavy/protocol.test.ts` checks the program against this table. A field not in
the table is refused, not ignored.

| field | type | required | meaning |
|---|---|---|---|
| `prompt` | string, non-empty | yes | the text sent to the model |
| `cwd` | string, non-empty | yes | working directory of the agent |
| `command` | string, non-empty | no | the claude command, a name on PATH or a path; absent means `claude` |
| `resumeSession` | string, a UUID | no | a `sessionId` from an earlier `Result`; the prompt is sent into that session |
| `model` | string, non-empty | no | model name for claude (`--model`); absent means claude's own default |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max` | no | reasoning effort; absent means claude's default |
| `bashTimeoutSecs` | positive integer | no | the longest one Bash call may run in the foreground, in seconds; absent means 1800. Sets claude's `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` |
| `operadTools` | object `{ home }` | no | operad's own tools: claude is given an MCP server (`@operad-io/mcp`'s `stdio.ts`, run by Bun with `--home`) named `operad`; its tools are not judged by the access profile, they run under the owner's MCP allow lists. Absent: claude gets no MCP server |
| `mcpServers` | object, name to `{ command, args }` | no | other MCP servers claude starts, by name (a bot's servers, each behind the bot plugin's guard, which holds their secrets). Their tools are judged by the profile's `allowMcp`: a tool not listed asks first. Absent: none |
| `secretValues` | array of strings | no | the values of the plugin's operad secrets; a log line shows `***` where one appears. Never written anywhere |
| `images` | array of `{ path, mediaType }` | no | image files (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) sent with the prompt as image blocks of the one user message. Absent: the prompt goes as text |
| `access` | object | no | the access profile; `denyPaths` and `denyCommands` are enforced in `canUseTool` by `@operad-io/access-match`, `grants` are one-time permissions, other fields are ignored; absent means nothing is denied |
| `maxTurns` | positive integer | no | SDK `maxTurns`; absent means no limit |
| `budgetUsd` | positive number | no | SDK `maxBudgetUsd`; absent means none |

An invalid object (not JSON, not an object, a required field missing or of the
wrong type, an unknown field) writes one `Result` line with `result: "failed"`,
`reason: "invalid_input"` and `message` naming the field, and exits 2.

## stdout

One JSON object per line, flushed per line, each with a `type`:

| type | other fields | meaning |
|---|---|---|
| `session` | `claudeVersion`, `apiKeySource`, `model` | claude started a session; written once, first. `apiKeySource` says which credential it uses: `none` for a subscription login, `ANTHROPIC_API_KEY` when that variable is set in the environment |
| `message_end` | `role` (`"assistant"`), `text` (optional: the first 300 characters of the message's text as one paragraph; thinking and tool calls left out), `stopReason` (string or null), `usage` (`{input, output, cache_read, cache_write}`), `cost` (always `null`: claude prices a run, not a message) | an assistant message finished; written once per message |
| `text_delta` | `text` | new assistant text only, not the text so far; increments are grouped into at most one line per 100 ms and the last part is written when the block or message ends |
| `thinking_delta` | `text` | new thinking only, not the thinking so far; grouped like `text_delta`. Claude gives only what its thinking display gives; when there is no thinking text, no line is written |
| `text_end` | `text` | the full text of a finished assistant message, after its `text_delta` lines |
| `thinking_end` | `text` | the full text of a finished thinking block, after its `thinking_delta` lines |
| `tool_execution_start` | `toolCallId`, `toolName`, `at`, `input` (optional) | a tool call began (the `PreToolUse` hook). `at` is the start time in epoch milliseconds. `input` says what ran: for `Bash` the command (one line, first 500 characters), for `Read`, `Edit` and `Write` the path, for another tool its main argument (path, pattern, query, URL or description) when it has one; absent otherwise. Never file contents or tool output. A command shows the values of leading environment assignments (`NAME=value`) as `NAME=***`, masks any value of the operad secret store or of a secret-named environment variable (`KEY`, `TOKEN`, `SECRET`, `PASS`, `PASSWORD`, `AUTH`, `CREDENTIAL`; 6 characters or more) as `***`, and shows `<command not shown: could not read it safely>` for a command it cannot read (an open quote, or a command or process substitution, heredoc or arithmetic in a leading assignment). A call the access profile denies shows `<tool> denied by the access profile`, never its arguments |
| `tool_execution_end` | `toolCallId`, `toolName`, `isError`, `durationMs`, `error` (optional) | a tool call ended (`PostToolUse`, `PostToolUseFailure`, or a refusal). `durationMs` is how long the call took, measured from its start line. `error` is the first line of the error (at most 300 characters) when `isError` is true; the rest of the error stays out of the log |
| `tool_output` | `toolCallId`, `text`, `truncated` (optional `true`) | what a successful tool call printed, written before its `tool_execution_end`: Bash's stdout and stderr, a Read file's content, or another tool's text result. `text` is cut to 64 KiB of UTF-8 and `truncated` says it was cut. A failed call writes no `tool_output`; its `error` is on the end line |
| `blocked` | `toolName`, `reason` | `canUseTool` refused a call; its `tool_execution_end` has `isError: true`; the run continues |
| `rate_limit` | `status`, `rateLimitType` (or null), `resetsAt` (or null) | claude reported its rate limit state |
| `grant_use` | `id`, `waitId` | asks the host to use up a one-time permission; answered on stdin by `{"type":"grant_ack","id":n,"used":true\|false}` |
| `ask_call` | `id`, `kind`, `value`, `tool` (path questions), `shown`, `session` | asks the host to ask a person whether one call may run (`askCommands`); answered on stdin by `{"type":"ask_ack","id":n,"decision":"allow"\|"deny"\|"stop"}` |
| `ask_resolved` | `id` | the question closed; the call goes on or is refused |
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

Every text of a new line (`text_delta`, `thinking_delta`, `text_end`,
`thinking_end`, `tool_output`) has each value of `secretValues` replaced with
`***`, as the existing command and error lines do.

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

## The plugin

`src/index.ts` is the hub side: the plugin `claude`, its step
`claude/agent` and its flow `claude:prompt`. It never imports the
SDK; it starts `bun src/worker.ts` through `runAgent` from
`@operad-io/harness-process`, writes the stdin object above, appends every stdout
line to the step's log with `JsonlLog`, and turns the last `result` line into the
facts. The params, the result names (`done`, `failed`, `interrupted`) and the
facts (`exitCode`, `signal`, `sessionId`, `finalMessage`, `usage`, `log`,
`durationMs`, `stderr`) are `pi`'s. `usage` is the standard one in
[the manual](../../../docs/manual.md#usage-and-end-results): `model` is the step's
`--model` or the `model` setting, else the model claude reports; `costMicros` is
the worker's `cost.micros`, and `costQuality` is `estimated` for a subscription
login and `exact` for an API key. `sessionId` is claude's session id; pass it back
as `resumeSession` to continue it (`claude --resume <id>` continues the same
session).

The plugin is not installed by `operad init`. Turn it on with:

```sh
operad plugin enable claude
```

A flow switches harness by changing `use` to `claude/agent`; `dev` does
it with `worker.use` in `.operad/dev.json`.

### Params: `args`

| flag | value | meaning |
|---|---|---|
| `--model` | a model name claude takes, such as `opus` | the model for this step |
| `--effort` | `low`, `medium`, `high`, `xhigh` or `max` | the reasoning effort for this step |

A flag in `args` wins over the setting of the same name. A chat passes its
effort as the step param `effort`, which also wins over the setting. Any other
entry fails the step at once, before the worker starts, with result `failed`,
reason `invalid_args` and a message that names the entry: an unknown flag, a
flag without its value, an effort outside the set, a flag given twice, the `=`
spelling.

### Settings

The `claude` section of `config.json`. A step param (`wallTimeSecs`,
`stallSecs`) overrides the setting of the same name.

| setting | type | default | meaning |
|---|---|---|---|
| `model` | string | unset | the model; unset uses claude's own default |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max` | unset | the reasoning effort; unset uses claude's default |
| `command` | string | `claude` | the claude command: a name on PATH or a path |
| `maxTurns` | integer, 1 or more | unset | the most turns one run may take |
| `budgetUsd` | number, 0.01 or more | unset | the most one run may spend, for API-key logins |
| `bashTimeoutSecs` | integer, 1 or more | `1800` | the longest one Bash call may run, in seconds; nothing runs in the background, so a long gate runs in the foreground within this time |
| `wallTimeSecs` | number | `3600` | the longest one run may take; at most 28500 |
| `stallSecs` | number | `600` | how long a run may print nothing while no tool call is open |
| `concurrency` | object, model to positive integer | `{}` | how many runs of one model may go at once; key `claude:<model>` |

### How the step ends

As `pi`'s table. A worker `failed` with reason `model_error` also sets
`data.modelError`: a rate limit the worker saw is `usage_limit`; otherwise the
kind is derived from the message text as in `pi` (`usage_limit`,
`unavailable` or `protocol`). `retry_after_secs` is `null`.

### `operad plugin check`

Runs `claude --version` and `claude auth status` on the claude the `command`
setting names, and reports the version, the Agent SDK version and the login
kind (for example `login claude.ai (max)`). It fails, saying what to do, when:

- there is no claude command;
- the version is below the floor, `2.1.319`, or `--version` prints nothing that
  starts with a version;
- claude is not logged in, or `auth status` prints nothing it can read.

The SDK version is only reported, never refused. Nothing from `auth status`
but the login kind is read or printed: no e-mail, organisation or token.

### Access profile

The step declares `enforces: ["denyPaths", "denyCommands", "askCommands", "askPaths"]`
and passes the run's profile to the worker. A profile that sets `askCommands` is
accepted: a call it matches asks a person first (see "Asking about a call").

The worker judges every call in `canUseTool` (`src/access.ts`). `access-match`
knows lower-case tool names and the fields `command` and `path`, so one table
maps claude's tools to them:

| claude tool | judged as | field read | field required |
|---|---|---|---|
| `Bash` | `bash` | `command` | yes |
| `Read` | `read` | `file_path` | yes |
| `Write` | `write` | `file_path` | yes |
| `Edit` | `edit` | `file_path` | yes |
| `MultiEdit` | `edit` | `file_path` | yes |
| `NotebookEdit` | `edit` | `notebook_path` | yes |
| `Grep` | `grep` | `path` | no (the search starts in `cwd`) |
| `Glob` | `find` | `path` | no (the search starts in `cwd`) |

A call whose required field is missing or not a string is refused while a deny
rule is set: a call without its target cannot be judged.

A tool that is not in the table:

- `TodoWrite`, `WebFetch`, `WebSearch`, `ExitPlanMode`, `BashOutput`,
  `KillShell`, `Task` and `Agent` run no command and name no file, so they are
  allowed. A subagent's own tool calls come to `canUseTool` too and are judged
  like any other.
- Any other name (an MCP tool, a tool a later claude adds) is allowed only when
  the profile has no `denyPaths` and no `denyCommands`. With a rule set it is
  refused, because a rule that could match it cannot be checked.

A refused call is answered `{ behavior: "deny", message }`; the message is the
reason `access-match` gave, the model receives it as the tool's result and the
run goes on. The worker writes a `blocked` line and closes the call with a
`tool_execution_end` that has `isError: true`.

A one-time permission arrives in the profile as `grants: [{ waitId, kind, value,
tool? }]`. When it is present the step keeps the worker's stdin open after the
input line. A call the profile refuses and that equals a grant exactly (`Bash`
command text, or the path for the one tool the grant names) makes the worker
write `{"type":"grant_use","id":n,"waitId":"..."}` and wait for one stdin line
`{"type":"grant_ack","id":n,"used":true|false}`. The host records `grant_used`
before it answers `used: true`; only then does the call run. `used: false`, a
host that is gone (stdin closed) and a host that fails all leave the call
refused. A second identical call finds the grant used and is judged as usual.
The host's half (`hasGrants`, `grantUse`, `answerGrant`) is in
`@operad-io/harness-process`, shared with `pi`.

### Asking about a call

A call the profile's `askCommands` matches (and that no deny rule matched: deny
wins over ask) asks a person instead of running. The step keeps the worker's
stdin open. The worker writes `{"type":"ask_call","id":n,"kind":"command","value":"<the whole command>","shown":"...","session":"<session>"|null}`
and holds the call; the host asks with `ctx.ask` (choices `allow_once` and
`reject_once`, the grace period of the kernel: 10 minutes by default, set by
`ask.graceSecs`, `askGraceSecs` of the step or the question) and answers on
stdin `{"type":"ask_ack","id":n,"decision":"allow"|"deny"|"stop","reason"?}`,
after which the worker writes `{"type":"ask_resolved","id":n}`. Questions go
one at a time. A command that holds a value of the operad secret store is
refused and never asked about, so no fact holds a secret.

- Answered within the grace period (`allow`): the same step goes on and this one
  call runs; nothing is kept for another call. `reject_once` is `deny`.
- Not answered in time (`stop`): the worker holds the call, the host ends the
  program, and the step ends `waiting` (the result is declared). The one pending
  item stays, with the run's object. The flow's `waiting` route goes to a wait
  for a person and back to the step.
- Answered later: the step runs again with `resumeSession`, `askAnswer` and
  `grants: [{ waitId, kind, value }]` for `allow_once`. The worker uses the grant
  for the one call it covers (`grant_use`, above); any other call asks again.
  After `reject_once` no grant arrives and the model is told so in the prompt.

The host's half (`createCallAsker`, `askCall`, `askRequest`) is in
`@operad-io/harness-process`. `askCommands` is in the step's `enforces`.

