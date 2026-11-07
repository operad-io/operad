# Mutation records — `harness-claude`

Rows whose mutation broke code in `packages/harness-claude/` or the install
setup it depends on, in the order they were recorded. The root
[MUTATIONS.md](../../MUTATIONS.md) explains the format and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0037-M1 | package.json | one platform override pointed at the real package instead of `empty-npm-package` | `the root overrides name all eight platform packages` |
| T-0037-M2 | bun.lock | one platform entry resolved to the real package | `bun.lock resolves every platform package to the empty package` |
| T-0037-M3 | node_modules/.bun | a 200 KB `claude` file placed in a platform package directory | `after an install no platform package holds more than a stub` |
| T-0037-M4 | packages/harness-claude/spike/probe.ts | `findClaude` returned `"claude"` instead of throwing when none is on PATH | `with no claude on PATH it fails with a message that says what to do` |
| T-0037-M5 | packages/harness-claude/package.json | SDK range `^0.3.319` made exact | `the SDK is a range, not an exact version` |

## T-0038 — the worker

| id | file | mutation | failing test |
|---|---|---|---|
| T-0038-M1 | packages/harness-claude/src/worker.ts | `cache_write` read `cache_read_input_tokens` | `a prompt that ends writes the lines in order and a Result with usage, cost, session and model` |
| T-0038-M2 | packages/harness-claude/src/worker.ts | cost quality always `exact` | `cost quality is estimated for a subscription login and exact for an API key` |
| T-0038-M3 | packages/harness-claude/src/worker.ts | `Math.round` of the micros became `Math.floor` | `a prompt that ends writes the lines in order and a Result with usage, cost, session and model` |
| T-0038-M4 | packages/harness-claude/src/worker.ts | any rate limit status but `allowed` made a `usage_limit` modelError | `a warning-only rate limit event is not a usage limit when the run fails for another reason` |
| T-0038-M5 | packages/harness-claude/src/worker.ts | `endCall` wrote an end line for a call that was not open | `a tool call ends once, and an end with no start writes nothing` |
| T-0038-M6 | packages/harness-claude/src/worker.ts | a cancelled run exited 1 instead of 143 | `SIGTERM mid-turn aborts claude, writes a cancelled Result and exits 143` |
| T-0038-M7 | packages/harness-claude/src/worker.ts | `permissionMode: "default"` left out | `claude runs without setting sources, with manual permissions and the isolation environment` |
| T-0038-M8 | packages/harness-claude/src/worker.ts | the isolation environment not passed | `claude runs without setting sources, with manual permissions and the isolation environment` |
| T-0038-M9 | packages/harness-claude/src/protocol.ts | the unknown-field check disabled | `an unknown input field such as args is refused with exit 2` |
| T-0038-M10 | packages/harness-claude/src/worker.ts | `resume` not passed to the SDK | `resume passes the session id to claude; an unknown one is failed session_missing` |
| T-0038-M11 | packages/harness-claude/src/worker.ts | "no conversation found" no longer mapped to `session_missing` | `resume passes the session id to claude; an unknown one is failed session_missing` |
| T-0038-M12 | packages/harness-claude/src/worker.ts | one `message_end` per content block instead of per message | `several content blocks of one assistant message write one message_end` |

## T-0039 — the agent step, the prompt flow and the check

| id | file | mutation | failing test |
|---|---|---|---|
| T-0039-M1 | packages/harness-claude/src/index.ts | a flag was accepted as the value of the flag before it | `a flag as the value fails with invalid_args and the worker is not started` |
| T-0039-M2 | packages/harness-claude/src/index.ts | the worker's `estimated` cost quality was dropped | `a done run has the facts of harness-pi/agent: session, final message, usage, log` |
| T-0039-M3 | packages/harness-claude/src/index.ts | the usage model ignored the model claude reports | `the usage names the model claude reports when the step named none` |
| T-0039-M4 | packages/harness-claude/src/index.ts | the worker's `modelError` was ignored (kind taken from the text) | `a rate limit the worker saw is a usage_limit modelError` |
| T-0039-M5 | packages/harness-claude/src/claude-install.ts | the floor itself was refused (`< 0` became `<= 0`) | `a current, logged-in claude reports its version and the login kind only` |
| T-0039-M6 | packages/harness-claude/src/claude-install.ts | `loggedIn: false` was not checked | `loggedIn false with exit 0 is still refused; loggedIn true with a failing exit too` |
| T-0039-M7 | packages/harness-claude/src/claude-install.ts | the exit code of `auth status` was ignored | `loggedIn false with exit 0 is still refused; loggedIn true with a failing exit too` |
| T-0039-M8 | packages/harness-claude/src/claude-install.ts | free text from `auth status` was printed as the login kind | `a free-text login field is not printed` |
| T-0039-M9 | packages/engine/src/config/config.ts | `harness-claude` left out of `OPTIONAL_PLUGINS` | `plugin enable adds a shipped plugin the default config leaves out` |
| T-0039-M10 | packages/harness-claude/src/index.ts | `effort` not sent to the worker | `--model and --effort in args reach the worker and win over the settings` |
| T-0039-M11 | packages/harness-claude/src/index.ts | `maxTurns` not sent to the worker | `the worker gets the prompt, the directory and the settings` |
| T-0039-M12 | packages/harness-claude/src/index.ts | `tool_execution_end` no longer closed a tool call | `classifies the worker's tool lines and nothing else` |
| T-0039-M13 | packages/harness-claude/src/claude-install.ts | the SDK version was not read | `the SDK version is a version and is only reported` |
| T-0039-M14 | packages/harness-claude/src/index.ts | `--effort` given twice was accepted | `an effort given twice fails with invalid_args and the worker is not started` |
