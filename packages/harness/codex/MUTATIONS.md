# Mutation records — `harness-codex`

Rows whose mutation broke code in `packages/harness/codex/`, in the order they were
recorded. The root [MUTATIONS.md](../../../MUTATIONS.md) explains the format and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0378-M1 | packages/harness/codex/src/index.ts | the closing result gave the run a cost of `{ micros: 0 }` instead of null | `codex/agent: a prompt run > the usage has the token counts and an unknown cost, never 0` |
| T-0378-M2 | packages/harness/codex/src/log.ts | an image generation was no longer counted | `codex/agent: image generations > each image_gen call of the attempt is counted in the step result and its log` |
| T-0378-M3 | packages/harness/codex/src/access.ts | a one-time grant was never used through the host | `codex/agent: permissions > a one-time grant lets the refused call through once, through the host` |
| T-0378-M4 | packages/harness/codex/src/index.ts | `usageLimitExceeded` was no longer mapped to `usage_limit` | `codex/agent: model errors > an exhausted ChatGPT quota is a usage_limit model error` |
| T-0378-M6 | packages/harness/codex/src/log.ts | an opening tool call no longer paused the stall timer | `codex/agent: image generations > silence while an image generation is open is not a stall` |
| T-0378-M7 | packages/harness/codex/src/index.ts | a cancel ended the process without sending `session/cancel` | `codex/agent: cancel > a cancel sends session/cancel and the step is interrupted when codex-acp answers` |
| T-0378-M9 | packages/harness/codex/src/index.ts | the session mode was `agent-full-access`, which turns Codex's sandbox off | `codex/agent: a prompt run > a prompt runs to the end over ACP and the tool calls are in the log` |
| T-0378-M10 | packages/harness/codex/src/install.ts | the default command used the `codex-acp` of PATH without resolving its real path | `the command that starts codex-acp > by default the bun of PATH runs the real path of the codex-acp of PATH` |
| T-0378-M11 | packages/harness/codex/src/index.ts | a refused model setting was not an `unavailable` model error | `codex/agent: model errors > a model codex-acp does not offer is an unavailable model error` |
| T-0378-M12 | packages/harness/codex/src/log.ts | text said before a tool call stayed in the closing message | `codex/agent: a prompt run > a prompt runs to the end over ACP and the tool calls are in the log` |
| T-0378-M13 | packages/harness/codex/src/index.ts | a refused call was not logged as blocked | `codex/agent: permissions > a command the profile denies is rejected and logged as blocked` |
| T-0378-M14 | packages/harness/codex/src/access.ts | a network request with no command was refused while a command rule is set | `codex/agent: permissions > a network request with no command is allowed once even where a command rule is set` |
| T-0378-M16 | packages/harness/codex/src/access.ts | a request with a command and a url was judged as a network request, so a deny rule never saw the command | `codex/agent: permissions > a network request that carries a command is judged as that command` |

## T-0465 — a harness reports whether its agent is signed in

| id | file | mutation | failing test |
|---|---|---|---|
| T-0465-M6 | packages/harness/codex/src/install.ts | `codexSignedIn` answered true on any exit instead of only a zero one | `codex's signedIn answer > is false when codex login status exits non-zero` |
| T-0465-M10 | packages/harness/codex/src/install.ts | a codex that could not start answered false instead of absent | `codex's signedIn answer > is absent when codex cannot be started` |
| T-0465-M11 | packages/harness/codex/src/index.ts | removed the cache check, so `codex login status` ran on every read | `codex's signedIn answer > asks codex once per short cache period` |

## T-0490 — the codex harness speaks Codex's app-server

| id | file | mutation | failing test |
|---|---|---|---|
| T-0490-M1 | packages/harness/codex/src/app-server.ts | the client asked for `turn/startX`, which the app-server does not know, instead of `turn/start` | `codex/agent: a prompt run > a prompt runs to the end over app-server and the tool calls are in the log` |
| T-0490-M2 | packages/harness/codex/src/index.ts | an `interrupted` turn was not mapped to the step result `interrupted` | `codex/agent: cancel > a cancel sends turn/interrupt and the step is interrupted when the server answers` |
| T-0490-M3 | packages/harness/codex/src/log.ts | an image-generation item was no longer counted | `codex/agent: image generations > each image_gen call of the attempt is counted in the step result and its log` |
| T-0490-M4 | packages/harness/codex/src/log.ts | the tool-event classifier returned nothing, so an open image generation no longer paused the stall timer | `codex/agent: image generations > silence while an image generation is open is not a stall` |
| T-0490-M5 | packages/harness/codex/src/access.ts | a command approval was treated as inert instead of a `bash` call | `codex/agent: permissions > a command the profile denies is rejected and logged as blocked` |
| T-0490-M6 | packages/harness/codex/src/access.ts | a file-change approval was treated as inert instead of one `edit` per path | `codex/agent: permissions > a path the profile denies is rejected for a file change` |
| T-0490-M7 | packages/harness/codex/src/app-server.ts | an allowed call answered `acceptForSession` instead of `accept` | `codex/agent: permissions > without a rule the call is allowed once, never for the session` |
| T-0490-M8 | packages/harness/codex/src/index.ts | a cancel ended the process without sending `turn/interrupt` | `codex/agent: cancel > a cancel sends turn/interrupt and the step is interrupted when the server answers` |
| T-0490-M9 | packages/harness/codex/src/app-server.ts | `steer` returned false without sending `turn/steer` | `codex/agent: a message from the host > a message sent mid-run steers the turn` |
| T-0490-M10 | packages/harness/codex/src/app-server.ts | a resumed run sent `thread/start` instead of `thread/resume` | `codex/agent: resume > a resumed run resumes the thread, and what it replays is not this run's` |
| T-0490-M11 | packages/harness/codex/src/install.ts | the check skipped `command --help`, so a Codex without an app-server passed | `codex check > refuses a Codex with no app-server` |
| T-0490-M12 | packages/harness/codex/src/install.ts | the check skipped the version floor | `codex check > refuses an installed Codex that is too old` |
| T-0490-M13 | packages/harness/codex/src/install.ts | the model list ignored the app-server's `isDefault` | `what a chat may pick > the model list comes from the app-server` |
| T-0490-M14 | packages/harness/codex/src/install.ts | the default command omitted `app-server` | `the command that starts codex app-server > by default the bun of PATH runs the real path of the codex of PATH with app-server` |
| T-0490-M15 | packages/harness/codex/src/app-server.ts | the MCP servers were dropped from the thread's config | `codex/agent: a prompt run > operad's tools and mounted servers reach Codex as mcp_servers config` |
| T-0490-M16 | packages/harness/codex/src/install.ts | the synchronous models read no longer started a background refresh, so the list stayed empty | `what a chat may pick > the model list comes from the app-server without blocking the listing read` |
| T-0490-M17 | packages/harness/codex/src/install.ts | an empty model list was kept for the full 30 s cache instead of the short retry | `what a chat may pick > an empty answer is tried again after the short retry, not kept for 30s` |

## T-0498 — skills in the prompt for a harness that cannot load them

| id | file | mutation | failing test |
|---|---|---|---|
| T-0498-M5 | packages/harness/codex/src/index.ts | the `skills` param was read but the prompt kept only the step's text | `codex/agent: a prompt run > given skills are listed in the prompt with their description and path, never their body` |
