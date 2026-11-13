# ADR 0024: The `claude` Harness

Status: accepted

## Background

`claude` follows the shape that `pi` set: a hub-side `agent` step starts a child process whose stdin is one JSON, stdout is one event per line and the last line is a Result; the access profile is judged before a tool call by `access-match`; a one-time grant uses `grant_use` and `grant_ack`. The difference is that the child carries the Agent SDK client, which starts a Claude Code process in turn.

Facts the decisions rest on: the SDK package is client code, while the Claude Code binary comes through eight per-platform optional dependencies, which are not needed when `pathToClaudeCodeExecutable` points at the user's own `claude`. The user's login lives in the macOS Keychain (Linux `~/.claude/.credentials.json`) and the process the SDK starts reads the same one, so a subscription works directly. `CLAUDE_CONFIG_DIR` splits the Keychain entry by directory, so it cannot isolate session files while keeping the login. Anthropic does not allow third parties to offer claude.ai login or its rate limits in their products; the brand may be "Claude Agent" or "Claude" but not "Claude Code". With `permissionMode` unset the default is `auto`, a classifier that approves calls itself; a person can answer only with an explicit `'default'` and `canUseTool`.

## Decisions

### D1: `claude` is an `sdk` harness with the same parameters as `pi`

The package is `@operad-io/harness-claude`, the step `claude/agent`, the flow `claude:prompt`. Parameters, result names and fact shapes are the same as `pi`'s; `args` reads `--model <name>` and `--effort <low|medium|high|xhigh|max>`, and other entries are refused by the rule `pi` uses. The interface and the documentation say `claude`, never "Claude Code".

### D2: Two child processes; the binary is the user's

The hub starts `bun worker.ts`; `worker.ts` imports the SDK, and the SDK starts the `claude` on `PATH` through `pathToClaudeCodeExecutable` (the setting `command` changes it). operad does not carry Claude Code: the `overrides` in `package.json` replace the eight `@anthropic-ai/claude-agent-sdk-<platform>` packages with `empty-npm-package`, and the SDK client is a range, not an exact version. `operad plugin check` runs `claude --version` and `claude auth status` and reports the Claude Code version, the SDK version and the login method; it refuses, saying so, when Claude Code is below the floor the worker was written for or there is no login, and only reports the SDK version.

### D3: The credential is the user's own claude login

operad passes nothing. A subscription login sits in the Keychain, which the process the SDK starts reads itself. On a machine without a browser the user puts the result of `claude setup-token` in the environment variable `CLAUDE_CODE_OAUTH_TOKEN`, and the worker passes it through unchanged. A user runs their own subscription for their own tools; when operad is given to others as a product it does not do a claude.ai login for the user and uses only an API key.

### D4: The Claude in the child does no discovery

`settingSources: []`, so no user or project settings and no instruction files are read; `permissionMode: 'default'` given explicitly (the default `auto` classifier is not accepted); `permissionPrompts: 'host'`; `canUseTool` is the only permission surface. The system prompt is the SDK's `claude_code` preset without additions. The environment the worker gives `claude` turns off auto memory, instruction files, telemetry, error reporting and background tasks. The only hooks are those the worker passes in code (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, which write the log); no hook files are loaded.

The tool set is the SDK's default tools minus a fixed disallowed list of tools that only schedule or wait for work outside the turn (`Monitor`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `TaskStop`), so a run is one foreground turn. It is extended by operad's own MCP server, started over stdio, when the step provides one, and by a bot's MCP servers, each started behind its guard, which holds their secrets.

### D5: Session files stay in the user's `~/.claude/projects/`

This follows from D3: changing `CLAUDE_CONFIG_DIR` loses the login. `sessionId` is the SDK's `session_id`, and resume passes it as `resume`; the user's own `claude --resume <id>` can continue the same session. Unlike `pi`, there is no separate session directory.

### D6: The access profile is judged in `canUseTool`

The tool name is mapped first (`Bash` to `bash`; `Read`, `Write`, `Edit`, `Glob`, `Grep` to lower case; `input.command` and `input.file_path` as the fields `access-match` knows), then the same `match()` is called. A refusal returns `{ behavior: 'deny', message }` and the log records a `blocked` line. One-time grants are the same as in `pi`: when `findGrant` matches, `grant_use` is written, `grant_ack` is awaited and the call goes only with `used: true`.

### D7: Where the facts come from

`usage` comes from the four counts of the result, with `cache_creation_input_tokens` as `cache_write`. `cost.micros` is `total_cost_usd` times one million rounded, quality `estimated` when the login is a subscription (`accountInfo().subscriptionType` has a value) and `exact` for an API key. `finalMessage` is the result's `result`. `model` is the step's `--model`, else the first key of `modelUsage`. Log lines are `tool_execution_start`, `tool_execution_end` and `tool_output` from the `PreToolUse` and `PostToolUse` hooks (the stall logic is unchanged), `text_delta` and `thinking_delta` from stream events, `text_end` and `thinking_end` from assistant messages, plus `message_end` (each assistant message), `blocked` and `result`. A `rate_limit_event` becomes a `modelError` of kind `usage_limit` with the `rateLimitType` in the message. A result with `is_error` true ends the step `failed` with reason `model_error`.

### D8: Cancel and limits

SIGTERM to the worker calls `abortController.abort()` and writes a `cancelled` Result with exit code 143. The settings `maxTurns` (default unlimited) and `budgetUsd` (default unset, for API-key users) become the SDK's `maxTurns` and `maxBudgetUsd`.

### D9: Asking a person happens in `canUseTool`

`canUseTool` is async and awaits `ctx.ask(...)` in the same way as `pi` (ADR 0023 D8).

### D10: Versions

The SDK client is not pinned: `package.json` holds a caret range, the lock file records the version last tested, `bun update` moves it forward, and `--frozen-lockfile` stays reproducible. The SDK's version number follows Claude Code's. Claude Code is the user's and updates itself, so the floor is on it; `operad plugin check` reports both versions and the worker records `initializationResult().claude_code_version` in the log. An SDK behind Claude Code is normal and is not refused; a Claude Code below the floor is.
