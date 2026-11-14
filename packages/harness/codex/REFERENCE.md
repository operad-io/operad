# @operad-io/harness-codex

The `codex` plugin: one `agent` step that starts the user's `codex-acp` and
talks ACP to it, and the `codex:prompt` flow that runs one prompt. Decisions:
ADR 0022 D2, D4, D6, D7 and D8.

The ACP client is `AcpClient` in `@operad-io/harness-process` (`src/acp.ts`), so
another harness that speaks ACP reuses it. `runAgent` owns the process, the
wall time and the stall limit; `AcpClient` is only the protocol.

## The conversation

`initialize`, then `session/new` with `cwd` set to the task's worktree (or
`session/load` for `resumeSession`; an agent without `loadSession` fails the
step with `session_missing`), then `session/set_config_option` for the session
mode, the model and the reasoning effort, then `session/prompt`. Each
`session/update` is turned into log lines. `session/cancel` is sent when the
step is cancelled; codex-acp answers the prompt with the stop reason
`cancelled`, and an agent that does not answer within `CANCEL_GRACE_MS` (10 s)
is ended. What `session/load` replays of the earlier conversation is neither
logged nor counted.

## Credentials

None from operad. codex-acp uses the user's local Codex (ChatGPT) login as it
is. A session that needs a login fails with `not_logged_in`; run `codex login`.

## Settings

The `codex` section of `config.json`.

| setting | type | default | meaning |
|---|---|---|---|
| `model` | string | Codex's own | the model; the step's `--model` wins |
| `effort` | `minimal`, `low`, `medium`, `high`, `xhigh` | Codex's own | the reasoning effort; the step's `--effort` wins |
| `command` | array of strings | the `bun` of PATH on the real path of the `codex-acp` of PATH | the program and arguments that start codex-acp |
| `wallTimeSecs` | number | `3600` | the longest one run may take (at most 28500) |
| `stallSecs` | number | `600` | how long a run may be silent while no tool call is open |
| `concurrency` | object, model to positive integer | `{}` | how many runs of one model may go at once; a model not listed has no limit |

`command` is a list because the default is two words. codex-acp's shebang is
`#!/usr/bin/env node`, which finds a node only in a shell that set one up (fnm),
so the default runs the real path of `codex-acp` with `bun`. On the owner's
machine that is `["/opt/homebrew/bin/bun", "/Users/hai/.bun/bin/codex-acp"]`.

`operad plugin check codex` runs `codex-acp --version`, `codex --version` and
`codex login status`, and reports the two versions and the login kind. It
refuses, saying what to do, when codex-acp cannot start or Codex is not logged
in; a Codex it cannot find on PATH is reported as unknown, not refused.

## Step args

`--model <name>` and `--effort <level>` only; any other entry fails the step
with `invalid_args`, as for `pi` and `claude`. A model codex-acp does not offer
is a `model_error` of kind `unavailable`; an effort the model does not take is
`invalid_args`.

## The sandbox

Codex's own sandbox stays on. The session mode is `workspace-write` (`SESSION_MODE`):
write access to the worktree and nothing outside it. The sandbox cannot write
`.git`, so a flow that needs a commit uses the work stage's `commit`
(ADR 0020 D9). The sandbox has no network; a command that
needs it comes to the client as a permission request, and the access profile
answers it (a network request is allowed once, since the task needs it).

## Permissions

`session/request_permission` is answered by `decideAccess` (`src/access.ts`),
the same rules the other harnesses apply through `access-match`: a deny wins; a
one-time permission covers one exact refused call and is used through the host
(`ctx.useGrant`, the same `grant_use` and `grant_ack` the worker protocol
carries) before the call is let through; a call the profile says must ask goes
to a person through `ctx.ask`. An allowed call gets the `allow_once` option,
never `allow_always`. The request is read by its ACP tool `kind`: `execute`
with a command is a `bash` call; `edit`, `delete` and `move` judge each path in
`locations` as an `edit`; `read` and `search` judge their path; `fetch`, `think`
and a request of operad's own MCP server are inert; any other call is allowed
only when the profile has no `denyPaths` and `denyCommands`.

Codex asks only about what leaves its sandbox. A command that runs inside the
sandbox is not asked about, so a profile's deny rules do not see it: Codex's
sandbox is the bound there, not the profile.

## Usage, images, time

- Tokens come from the prompt's `usage`. The cost is unknown for a subscription
  login: `costMicros` and `costQuality` are `null`, never `0`, and nothing in
  `dev` or `pool` stops or blocks on it.
- Each image generation (a tool call titled `Image generation`) is counted per
  attempt in `imageGenCalls` of the step result and of the closing `result`
  line of the log.
- Every tool call is in the step log as `tool_execution_start`, `tool_output`
  (the head, cut at 64 KB) and `tool_execution_end`; an assistant message is
  `text_delta` lines and a closing `message_end`; a refused call is a `blocked`
  line. A rework reads these.
- There is no stall detection of its own. The stall limit pauses while a tool
  call or a permission question is open, so an image generation that prints
  nothing for minutes is never a stall; the wall limit still applies.
- `usageLimitExceeded` and `rateLimitExceeded` of Codex are a `model_error` of
  kind `usage_limit`; `serverOverloaded` is `unavailable`. With no fallback
  configured the task waits (ADR 0021 D9).

## Not done

Messages sent to a run while it works (the inbox) are not passed on. The chat
does not offer `codex`: it declares no models and no efforts.
