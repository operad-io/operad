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
