# ADR 0024: The `claude` Harness

Status: accepted

## Background

`claude` follows the shape that `pi` set: a hub-side `agent` step starts a child process whose stdin is one JSON, stdout is one event per line and the last line is a Result; the access profile is judged before a tool call by `access-match`; a one-time grant uses `grant_use` and `grant_ack`. The difference is that the child carries the Agent SDK client, which starts a Claude Code process in turn.

Facts the decisions rest on: the SDK package is client code, while the Claude Code binary comes through eight per-platform optional dependencies, which are not needed when `pathToClaudeCodeExecutable` points at the user's own `claude`. The user's login lives in the macOS Keychain (Linux `~/.claude/.credentials.json`) and the process the SDK starts reads the same one, so a subscription works directly. `CLAUDE_CONFIG_DIR` splits the Keychain entry by directory, so it cannot isolate session files while keeping the login. Anthropic does not allow third parties to offer claude.ai login or its rate limits in their products; the brand may be "Claude Agent" or "Claude" but not "Claude Code". With `permissionMode` unset the default is `auto`, a classifier that approves calls itself; a person can answer only with an explicit `'default'` and `canUseTool`.

## Decisions

### D1: `claude` is an `sdk` harness with the same parameters as `pi`

The package is `@operad-io/harness-claude`, the step `claude/agent`, the flow `claude:prompt`. Parameters, result names and fact shapes are the same as `pi`'s; `args` reads `--model <name>` and `--effort <low|medium|high|xhigh|max>`, and other entries are refused by the rule `pi` uses. The interface and the documentation say `claude`, never "Claude Code".

### D2: Two child processes; the binary is the user's

The hub starts `bun worker.ts`; `worker.ts` imports the SDK, and the SDK starts the `claude` on `PATH` through `pathToClaudeCodeExecutable` (the setting `command` changes it). A chat reply may keep both processes between replies (D11): the worker and the `claude` it started stay, and the prompts after it go through the same SDK query stream instead of starting another worker or another `claude`. operad does not carry Claude Code: the `overrides` in `package.json` replace the eight `@anthropic-ai/claude-agent-sdk-<platform>` packages with `empty-npm-package`, and the SDK client is a range, not an exact version. `operad plugin check` runs `claude --version` and `claude auth status` and reports the Claude Code version, the SDK version and the login method; Claude Code below the floor the worker was written for (`2.1.319`), or not logged in, is reported as not set up, and a version or login answer it cannot read fails the check (ADR 0022 D14). The SDK version is only reported.

### D3: The credential is the user's own claude login

operad passes nothing. A subscription login sits in the Keychain, which the process the SDK starts reads itself. On a machine without a browser the user puts the result of `claude setup-token` in the environment variable `CLAUDE_CODE_OAUTH_TOKEN`, and the worker passes it through unchanged. A user runs their own subscription for their own tools; when operad is given to others as a product it does not do a claude.ai login for the user and uses only an API key.

### D4: The Claude in the child does no discovery unless a bot asks for the owner's settings

By default `settingSources: []`, so no user or project settings and no instruction files are read; `permissionMode: 'default'` given explicitly (the default `auto` classifier is not accepted); `permissionPrompts: 'host'`; `canUseTool` is the only permission surface. The system prompt is the SDK's `claude_code` preset without additions. By default the environment the worker gives `claude` turns off auto memory, instruction files, telemetry, error reporting and background tasks. With the switch off, the only hooks are those the worker passes in code (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, which write the log); no hook files are loaded. With the switch off, user and project settings and skills do not load. The skill directories the step gives are mounted as one local plugin in a temporary directory under the system temporary directory, outside the repository and the skill directories; with the switch off the SDK's `skills` filter names only that plugin's skills. The temporary directory is removed when the step ends. With the switch off, no other plugin is loaded, and with no skills the worker passes no `plugins` option. The session log names the skills loaded.

The tool set is the SDK's default tools minus a fixed disallowed list of tools that only schedule or wait for work outside the turn (`Monitor`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `TaskStop`), so a run is one foreground turn. It is extended by operad's own MCP server, started over stdio, when the step provides one, and by a bot's MCP servers, each started behind its guard, which holds their secrets.

A bot may turn on `useOwnSettings` (ADR 0030 D9). Then, and only then, the worker passes `settingSources: ['user', 'project', 'local']` and leaves out the two variables that disable instruction files and auto memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`), so the owner's settings, instruction files, memory, skills, commands, subagents, plugins and MCP servers load. Telemetry, error reporting and background tasks stay off, and the disallowed tools stay disallowed: a reply is still one foreground turn. The bot's access profile is judged first, in the `PreToolUse` hook the worker already passes in code, for every call; a call it refuses is denied before any allow rule of the owner's settings can approve it, and the judgement uses the same matcher `canUseTool` uses. A call the profile does not refuse and the owner's settings allow runs without a question; a call neither settles still goes to `canUseTool`, which asks through operad or uses a one-time grant as before. operad's tools, the skills the bot lists, the MCP servers the bot lists and the log hooks stay; a skill or MCP server name that both sides define is operad's. With the switch off nothing in this decision changes.

### D5: Session files stay in the user's `~/.claude/projects/`

This follows from D3: changing `CLAUDE_CONFIG_DIR` loses the login. `sessionId` is the SDK's `session_id`, and resume passes it as `resume`; the user's own `claude --resume <id>` can continue the same session. Unlike `pi`, there is no separate session directory.

### D6: The access profile is judged in `canUseTool`

The tool name is mapped first (`Bash` to `bash`; `Read`, `Write`, `Edit`, `Glob`, `Grep` to lower case; `input.command` and `input.file_path` as the fields `access-match` knows), then the same `match()` is called. A refusal returns `{ behavior: 'deny', message }` and the log records a `blocked` line. One-time grants are the same as in `pi`: when `findGrant` matches, `grant_use` is written, `grant_ack` is awaited and the call goes only with `used: true`.

### D7: Where the facts come from

`usage` comes from the four counts of the result, with `cache_creation_input_tokens` as `cache_write`. The reply's `context.used` comes from the last assistant message alone, its input plus cache read and cache write, and `context.window` from the step's model in claude's model list when the list gives one. `cost.micros` is `total_cost_usd` times one million rounded, quality `estimated` when the login is a subscription (`accountInfo().subscriptionType` has a value) and `exact` for an API key. `finalMessage` is the result's `result`. `model` is the step's `--model`, else the first key of `modelUsage`. Log lines are `tool_execution_start`, `tool_execution_end` and `tool_output` from the `PreToolUse` and `PostToolUse` hooks (the stall logic is unchanged), `text_delta` and `thinking_delta` from stream events, `text_end` and `thinking_end` from assistant messages, plus `message_end` (each assistant message), `blocked` and `result`. A `rate_limit_event` becomes a `modelError` of kind `usage_limit` with the `rateLimitType` in the message. A result with `is_error` true ends the step `failed` with reason `model_error`.

### D8: Cancel and limits

SIGTERM to the worker calls `abortController.abort()` and writes a `cancelled` Result with exit code 143. The settings `maxTurns` (default unlimited) and `budgetUsd` (default unset, for API-key users) become the SDK's `maxTurns` and `maxBudgetUsd`.

### D9: Asking a person happens in `canUseTool`

`canUseTool` is async and awaits `ctx.ask(...)` in the same way as `pi` (ADR 0023 D8).

### D10: Versions

The SDK client is not pinned: `package.json` holds a caret range, the lock file records the version last tested, `bun update` moves it forward, and `--frozen-lockfile` stays reproducible. The SDK's version number follows Claude Code's (`0.3.319` to `2.1.319`); when it moves to `0.4`, the caret range on `0.x` is changed by hand. Claude Code is the user's and updates itself, so the floor is on it; `operad plugin check` reports both versions and the worker records `initializationResult().claude_code_version` in the log. An SDK behind Claude Code is normal and is not refused; a Claude Code below the floor is.

### D11: A chat reply may keep its `claude` worker and its session

A chat whose agent is `claude` passes `keepWorker` to the `agent` step. The rules are `pi`'s (ADR 0023 D10): after a done reply the worker stays for ten minutes and each done reply starts the time again; the time and the home's limit of three kept workers counted together with `pi`'s are constants, not settings, and a fourth ends the worker idle longest; a different model, effort, working directory, access profile, skills or MCP servers ends the kept worker before a new one starts; closing the chat, stopping its reply, `operad serve stop` and a serve that takes over new code end it; task workers and reviews never keep one.

The SDK can take another prompt in the same query stream, so the kept worker keeps its SDK session as well as the `claude` process. The first prompt is an async stream, and each reply after the first adds its user message to that stream; the `claude` process and the loaded SDK are not started again. The session line and the skill note are written into each reply's own log, so a reader sees the same ready line and timings on the second reply as on the first.

Both processes are kept together and end together. The worker ends the SDK session, which ends `claude`, when its timer runs out, when a stop ends it or when its reply fails or is stopped. A `claude` process that ends by itself makes the kept worker leave. A worker killed without a chance to clean up leaves no `claude` behind: the worker starts `claude` in a process group with a helper that watches the worker and kills that group when the worker is gone. A kept worker never outlives its `claude`, and no `claude` is left after the worker ends.

What Claude Code picks up by itself stays off (D4): `settingSources: []`, the isolation environment, no hook files and no user or project skills are fixed when the session starts and remain so between replies. What operad hands over is per reply: the prompt carries the repository's `AGENTS.md` and agent file paths a repository chat starts with (ADR 0028) and the skills the step gives. The temporary skill plugin is mounted for the life of the kept worker and is removed when it ends. Permission is judged for each reply with that reply's access profile, asker and one-time grants, never with the previous reply's. The socket, record, token, permissions, idle time and first-line time are the shared mechanism in `@operad-io/harness-process`; the process-wide rewrite borrows `pi`'s, and the per-reply profile is the only piece that differs.

### D12: `ExitPlanMode` is a plan review, not an inert tool

`ExitPlanMode` no longer passes without a check. Its `plan` argument becomes one question (ADR 0026 D6): the title is the plan's first Markdown heading, else its first line, else `Plan`; the body is the whole plan as written; the two choices are `Approve` and `Request changes`. The review goes through the same `io.askForm` and `ctx.ask` path as `AskUserQuestion`, with the same grace and waiting.

Approve returns `allow` with the input unchanged, so claude leaves plan mode itself as before. Request changes writes a `blocked` line, closes the call and returns `deny` with the person's note as its message and `interrupt: true`, so the reply ends and the person's next message says what to change; with no note the message says the person asked for changes. An empty plan is refused with a message to call again with the plan, never let through, and a plan holding a secret value is refused without asking. `ExitPlanMode` stays in `INERT_TOOLS`, because the profile does not judge it; the worker intercepts it before the profile is consulted, so it never passes unasked, also when the owner's settings are on.
