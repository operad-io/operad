# @operad-io/harness-codex

The `codex` plugin: one `agent` step that starts the user's own
`codex app-server` and speaks its JSON-RPC over stdio, and the `codex:prompt`
flow that runs one prompt. Decisions: ADR 0022 D3, D4, D6, D7 and D8.

The client is `AppServerClient` in `src/app-server.ts`, written by hand in this
package. It is not `AcpClient`: `codex` no longer goes through ACP. `AcpClient`
stays in `@operad-io/harness-process` for `radian` and other ACP entries.

## The protocol it was built against

The protocol is Codex's own, not memory: codex-cli **0.166.0** on the owner's
machine prints it with

```sh
codex app-server generate-ts --out ./codex-ts
codex app-server generate-json-schema --out ./codex-schema
```

`codex app-server` is marked experimental, so the command is a version floor:
`operad plugin check` refuses a Codex older than `0.166.0` and one whose
`app-server --help` does not run. A newer Codex that changes an experimental
shape may need this client updated. The client uses the stable surface plus
`experimentalApi: true` in `initialize`; it does not rely on any generated
package.

`runAgent` owns the process, the wall time and the stall limit; the client is
only the protocol.

## The conversation

`initialize`, then the `initialized` notification, then `thread/start` with
`cwd` set to the task's worktree (`thread/resume` for `resumeSession`; a thread
that cannot be resumed fails the step with `session_missing`), then
`turn/start` with the prompt as `UserInput` text. A turn ends with
`turn/completed` and its status `completed`, `interrupted` or `failed`. The
prompt is text to the model, so a person's text that starts with `/` is never
one of the app-server's own commands. The session id a step stores is the
thread id `thread/start` returns.

- The model goes to `thread/start`/`thread/resume`; the reasoning effort goes to
  `turn/start` as `effort`.
- Operad's tools and mounted MCP servers are passed as Codex's own
  `mcp_servers` config in `thread/start`. Operad's server keeps its name,
  `operad`, and gets `OPERAD_HOME`.
- `turn/interrupt` is sent when the step is cancelled; a server that does not
  answer with `turn/completed` within `CANCEL_GRACE_MS` (10 s) is ended.
- A message from the host's inbox is sent mid-run with `turn/steer` and the
  active turn id. Nothing is replayed from `thread/resume` into this run's log.

Each item notification becomes the shared `harness-process` log lines:
`text_delta` and `thinking_delta` while it streams, `message_end` at the end,
and `tool_execution_start`, `tool_output` and `tool_execution_end` for
`commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`,
`imageGeneration`, `webSearch` and `imageView`. The shapes are in
`fold-lines.ts`, so chat and dev read them as they read every harness's log.

## Credentials

None from operad. Codex uses the user's local Codex (ChatGPT) login as it is. A
thread that needs a login fails with `not_logged_in`; run `codex login`.

## Settings

The `codex` section of `config.json`.

| setting | type | default | meaning |
|---|---|---|---|
| `model` | string | Codex's own | the model; the step's `--model` wins |
| `effort` | `minimal`, `low`, `medium`, `high`, `xhigh` | Codex's own | the reasoning effort; the step's `--effort` wins |
| `command` | array of strings | the `bun` of PATH on the real path of the `codex` of PATH, then `app-server` | the program and arguments that start the app-server |
| `wallTimeSecs` | number | `3600` | the longest one run may take (at most 28500) |
| `stallSecs` | number | `600` | how long a run may be silent while no tool call is open |
| `concurrency` | object, model to positive integer | `{}` | how many runs of one model may go at once; a model not listed has no limit |

`command` is a list because the default is several words. Codex's script has a
`#!/usr/bin/env node` shebang, which finds node only in a shell that set one up
(fnm), so the default runs the real path of `codex` with the `bun` of PATH (or
this bun) and adds `app-server`. On the owner's machine that is
`["/opt/homebrew/bin/bun", "/Users/hai/.bun/bin/codex", "app-server"]`.

## `operad plugin check codex`

It runs the configured command with `--help`, which proves the installed Codex
has an app-server, then `codex --version` and `codex login status`. It reports
the Codex version, the command and the login kind. It refuses, saying what to
do, when the command cannot start, Codex is older than `0.166.0` (the protocol
this client was read from), or Codex is not logged in. A Codex it cannot find on
PATH is refused by the default command; a Codex it cannot ask is reported as
unknown, not refused.

## Model choices and signed-in

- `models` asks the app-server's `model/list` in a short-lived child in the
  background and keeps the answer for 30 s; an empty answer is retried after
  2 s. The synchronous listing read only returns the cache, so a slow Codex does
  not hold up `serve`, and the list is read once when the plugins load so the
  first client that asks after the start already has it. The default is the
  model Codex marks `isDefault`. The same answer carries each model's display
  name, provider, context window and the capabilities its fields report
  (`input` with `image` is vision; `reasoning`, `tools` and web search are
  passed only when the app-server says so). A chat may pick any of them; a
  worker step still gets its `--model` or the setting.
- `signedIn` still uses `codex login status` (kept for 30 s). It is already
  cheap and does not start an app-server; `account/read` over a fresh app-server
  took about twice as long on the owner's machine. Only the yes/no is exposed.

## Step args

`--model <name>` and `--effort <level>` only; any other entry fails the step
with `invalid_args`, as for `pi` and `claude`. A model the app-server's model
list refuses is a `model_error` of kind `unavailable`; an effort the model does
not take is `invalid_args`.

## Sandbox and approvals

Codex's own sandbox stays on. A thread runs with sandbox `workspace-write`
(`SANDBOX_MODE`): write access to the worktree and nothing outside it. The
sandbox cannot write `.git`, so a flow that needs a commit uses the work stage's
`commit` (ADR 0020 D9).

Codex is set to ask instead of deciding: `approvalPolicy: "on-request"` and
`approvalsReviewer: "user"` (`APPROVAL_POLICY`). `never` would let Codex
decide, and `auto_review` would put Codex's reviewer in the access profile's
place. A command that needs the network, or anything else that leaves the
sandbox, arrives as `item/commandExecution/requestApproval`; extra write access
arrives as `item/fileChange/requestApproval`.

`decideAccess` (`src/access.ts`) answers both with the same rules the other
harnesses apply through `access-match`: a deny wins; a one-time permission
covers one exact refused call and is used through the host (`ctx.useGrant`,
the same `grant_use` and `grant_ack` the worker protocol carries) before the
call is let through; a call the profile says must ask goes to a person through
`ctx.ask`. An allowed call gets `accept`, never `acceptForSession`. The older
`execCommandApproval` and `applyPatchApproval` requests are answered the same
way.

Codex asks only about what leaves its sandbox. A command that runs inside the
sandbox is not asked about, so a profile's deny rules do not see it: Codex's
sandbox is the bound there, not the profile.

Codex's own question is `item/tool/requestUserInput`: the app-server sends
`questions: [{ id, header, question, options: [{ label, description }],
isOther, isSecret }]` and reads `{ answers: { <id>: { answers: [<text>] } } }`.
It is not a permission; it becomes one form for a person through `ctx.ask`
(ADR 0026 D6), `isOther` becomes free text, and codex has no multiple choice.
A question whose `isSecret` is true is answered empty and never asked, so a
secret answer never reaches the pending item or the fact log. `isBlocking` and
`autoResolutionMs` do not skip the other questions: every one waits for the
person with the kernel's usual grace. An app-server that sends the
method when no question is expected gets the method-not-found error, as before.

## Usage, images, time

- Tokens come from `thread/tokenUsage/updated`, its `last` turn counts. The
  reply's `context.used` is those counts' input plus cached read and cache write,
  and `context.window` is the `modelContextWindow` the app-server reports with
  them when it reports one. The cost is unknown for a subscription login:
  `costMicros` and `costQuality` are `null`, never `0`, and nothing in `dev` or
  `pool` stops or blocks on it.
- Each `imageGeneration` item is counted per attempt in `imageGenCalls` of the
  step result and of the closing `result` line of the log.
- Every line of the step log carries `receivedAt` (epoch milliseconds). A
  `session` line is written once the app-server thread is open and before the
  turn is asked for.
- Every tool item is in the step log as `tool_execution_start`, `tool_output`
  (the head, cut at 64 KB) and `tool_execution_end`; an assistant message is
  `text_delta` lines and a closing `message_end`; a refused call is a `blocked`
  line. A rework reads these.
- There is no stall detection of its own. The stall limit pauses while a tool
  item or a permission question is open, so an image generation that prints
  nothing for minutes is never a stall; the wall limit still applies.
- `usageLimitExceeded`, `rateLimitExceeded`, `contextWindowExceeded` and
  `sessionBudgetExceeded` are a `model_error` of kind `usage_limit`;
  `serverOverloaded`, `modelNotFound`, `flexUnavailable` and
  `policyCapacityUnavailable` are `unavailable`; `unauthorized` is
  `not_logged_in`. With no fallback configured the task waits (ADR 0021 D9).

## Not done

- The app-server also gives account facts (email, plan, workspace), rate-limit
  windows and reset credits, and an account token-usage summary. The harness
  interface has no field for them, so `codex` exposes none of them and invents
  no new field.
- `item/permissions/requestApproval` (the agent asking for extra sandbox
  permissions), forking, review mode and image output are not mapped.
