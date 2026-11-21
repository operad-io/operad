# Mutation records — `harness-claude`

Rows whose mutation broke code in `packages/harness/claude/` or the install
setup it depends on, in the order they were recorded. The root
[MUTATIONS.md](../../MUTATIONS.md) explains the format and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0037-M1 | package.json | one platform override pointed at the real package instead of `empty-npm-package` | `the root overrides name all eight platform packages` |
| T-0037-M2 | bun.lock | one platform entry resolved to the real package | `bun.lock resolves every platform package to the empty package` |
| T-0037-M3 | node_modules/.bun | a 200 KB `claude` file placed in a platform package directory | `after an install no platform package holds more than a stub` |
| T-0037-M4 | packages/harness/claude/spike/probe.ts | `findClaude` returned `"claude"` instead of throwing when none is on PATH | `with no claude on PATH it fails with a message that says what to do` |
| T-0037-M5 | packages/harness/claude/package.json | SDK range `^0.3.319` made exact | `the SDK is a range, not an exact version` |

## T-0038 — the worker

| id | file | mutation | failing test |
|---|---|---|---|
| T-0038-M1 | packages/harness/claude/src/worker.ts | `cache_write` read `cache_read_input_tokens` | `a prompt that ends writes the lines in order and a Result with usage, cost, session and model` |
| T-0038-M2 | packages/harness/claude/src/worker.ts | cost quality always `exact` | `cost quality is estimated for a subscription login and exact for an API key` |
| T-0038-M3 | packages/harness/claude/src/worker.ts | `Math.round` of the micros became `Math.floor` | `a prompt that ends writes the lines in order and a Result with usage, cost, session and model` |
| T-0038-M4 | packages/harness/claude/src/worker.ts | any rate limit status but `allowed` made a `usage_limit` modelError | `a warning-only rate limit event is not a usage limit when the run fails for another reason` |
| T-0038-M5 | packages/harness/claude/src/worker.ts | `endCall` wrote an end line for a call that was not open | `a tool call ends once, and an end with no start writes nothing` |
| T-0038-M6 | packages/harness/claude/src/worker.ts | a cancelled run exited 1 instead of 143 | `SIGTERM mid-turn aborts claude, writes a cancelled Result and exits 143` |
| T-0038-M7 | packages/harness/claude/src/worker.ts | `permissionMode: "default"` left out | `claude runs without setting sources, with manual permissions and the isolation environment` |
| T-0038-M8 | packages/harness/claude/src/worker.ts | the isolation environment not passed | `claude runs without setting sources, with manual permissions and the isolation environment` |
| T-0038-M9 | packages/harness/claude/src/protocol.ts | the unknown-field check disabled | `an unknown input field such as args is refused with exit 2` |
| T-0038-M10 | packages/harness/claude/src/worker.ts | `resume` not passed to the SDK | `resume passes the session id to claude; an unknown one is failed session_missing` |
| T-0038-M11 | packages/harness/claude/src/worker.ts | "no conversation found" no longer mapped to `session_missing` | `resume passes the session id to claude; an unknown one is failed session_missing` |
| T-0038-M12 | packages/harness/claude/src/worker.ts | one `message_end` per content block instead of per message | `several content blocks of one assistant message write one message_end` |

## T-0039 — the agent step, the prompt flow and the check

| id | file | mutation | failing test |
|---|---|---|---|
| T-0039-M1 | packages/harness/claude/src/index.ts | a flag was accepted as the value of the flag before it | `a flag as the value fails with invalid_args and the worker is not started` |
| T-0039-M2 | packages/harness/claude/src/index.ts | the worker's `estimated` cost quality was dropped | `a done run has the facts of harness-pi/agent: session, final message, usage, log` |
| T-0039-M3 | packages/harness/claude/src/index.ts | the usage model ignored the model claude reports | `the usage names the model claude reports when the step named none` |
| T-0039-M4 | packages/harness/claude/src/index.ts | the worker's `modelError` was ignored (kind taken from the text) | `a rate limit the worker saw is a usage_limit modelError` |
| T-0039-M5 | packages/harness/claude/src/claude-install.ts | the floor itself was refused (`< 0` became `<= 0`) | `a current, logged-in claude reports its version and the login kind only` |
| T-0039-M6 | packages/harness/claude/src/claude-install.ts | `loggedIn: false` was not checked | `loggedIn false with exit 0 is still refused; loggedIn true with a failing exit too` |
| T-0039-M7 | packages/harness/claude/src/claude-install.ts | the exit code of `auth status` was ignored | `loggedIn false with exit 0 is still refused; loggedIn true with a failing exit too` |
| T-0039-M8 | packages/harness/claude/src/claude-install.ts | free text from `auth status` was printed as the login kind | `a free-text login field is not printed` |
| T-0039-M9 | packages/engine/src/config/config.ts | `harness-claude` left out of `OPTIONAL_PLUGINS` | `plugin enable adds a shipped plugin the default config leaves out` |
| T-0039-M10 | packages/harness/claude/src/index.ts | `effort` not sent to the worker | `--model and --effort in args reach the worker and win over the settings` |
| T-0039-M11 | packages/harness/claude/src/index.ts | `maxTurns` not sent to the worker | `the worker gets the prompt, the directory and the settings` |
| T-0039-M12 | packages/harness/claude/src/index.ts | `tool_execution_end` no longer closed a tool call | `classifies the worker's tool lines and nothing else` |
| T-0039-M13 | packages/harness/claude/src/claude-install.ts | the SDK version was not read | `the SDK version is a version and is only reported` |
| T-0039-M14 | packages/harness/claude/src/index.ts | `--effort` given twice was accepted | `an effort given twice fails with invalid_args and the worker is not started` |

## T-0040 — the access profile and one-time grants

| id | file | mutation | failing test |
|---|---|---|---|
| T-0040-M1 | packages/harness/claude/src/access.ts | `Read` read its path from `path` instead of `file_path` | `the tool table > Read: mapped to read, refused by the profile, allowed elsewhere` |
| T-0040-M2 | packages/harness/claude/src/access.ts | `NotebookEdit` read `file_path` instead of `notebook_path` | `the tool table > NotebookEdit: mapped to edit, refused by the profile, allowed elsewhere` |
| T-0040-M3 | packages/harness/claude/src/access.ts | `Glob` was judged as `grep` | `the tool table > Glob: mapped to find, refused by the profile, allowed elsewhere` |
| T-0040-M4 | packages/harness/claude/src/access.ts | an unmapped tool was allowed even with a deny rule set | `tools outside the table > an unmapped tool is refused while denyPaths or denyCommands is set` |
| T-0040-M5 | packages/harness/claude/src/access.ts | a required field that is missing was allowed | `the tool table > a tool whose target is required but missing is refused while a rule is set` |
| T-0040-M6 | packages/harness/claude/src/access.ts | a grant the host did not use up let the call run | `one-time grants > a grant the host does not use up lets nothing through` |
| T-0040-M7 | packages/harness/claude/src/access.ts | grants were never looked up | `one-time grants > a command grant that matches exactly is used and lets the call run` |
| T-0040-M8 | packages/harness/claude/src/access.ts | `Task` and `Agent` dropped from the inert list | `tools outside the table > an inert tool is allowed under any profile` |
| T-0040-M9 | packages/harness/claude/src/worker.ts | a refused call stayed open (no `tool_execution_end`) | `a Bash command that denyCommands refuses is denied with the reason, logged, and the run goes on` |
| T-0040-M10 | packages/harness/claude/src/worker.ts | the `blocked` line was not written | `a Bash command that denyCommands refuses is denied with the reason, logged, and the run goes on` |
| T-0040-M11 | packages/harness/claude/src/worker.ts | `canUseTool` was not given the host's `useGrant` | `a grant that matches is asked for, and the call runs when the host says used` |
| T-0040-M12 | packages/harness/claude/src/index.ts | the step stopped declaring `enforces` | `harness-claude access > the step declares the deny fields it enforces` |

## T-0041 — the session line

| id | file | mutation | failing test |
|---|---|---|---|
| T-0041-M1 | packages/harness/claude/src/worker.ts | the `session` line always said `apiKeySource: "none"` | `the session line says which credential claude uses, and is written once, first` |
| T-0041-M2 | packages/harness/claude/src/worker.ts | the `session` line took `claudeVersion` from the model field | `the session line says which credential claude uses, and is written once, first` |
| T-0041-M3 | packages/harness/claude/src/worker.ts | the `session` line was not written | `the session line says which credential claude uses, and is written once, first` |

## T-0041 — lead review 1

| id | file | mutation | failing test |
|---|---|---|---|
| T-0041-M4 | packages/harness/claude/src/worker.ts | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` left out of the isolation environment | `claude runs in the foreground: background tasks off, waiting tools disallowed, Bash timeouts set` |
| T-0041-M5 | packages/harness/claude/src/worker.ts | `Monitor` left out of the disallowed tools | `claude runs in the foreground: background tasks off, waiting tools disallowed, Bash timeouts set` |
| T-0041-M6 | packages/harness/claude/src/worker.ts | `BASH_MAX_TIMEOUT_MS` ignored `bashTimeoutSecs` | `bashTimeoutSecs sets both Bash timeouts and must be a positive integer` |
| T-0041-M7 | packages/harness/claude/src/worker.ts | the loop went on after a second `system/init` that followed the result | `a second session after the result is not accepted as a second turn` |
| T-0041-M8 | packages/harness/claude/src/worker.ts | the failure message ignored the result's `errors` | `an unknown session as the real claude reports it: errors, no result text, no model` |
| T-0041-M9 | packages/harness/claude/src/worker.ts | a run with no model still wrote a cost | `a failed run that used no model has no cost, not an exact zero` |
| T-0041-M10 | packages/harness/claude/src/protocol.ts | `bashTimeoutSecs` was not validated | `bashTimeoutSecs sets both Bash timeouts and must be a positive integer` |
| T-0041-M11 | packages/harness/claude/src/index.ts | the `bashTimeoutSecs` setting was not sent to the worker | `the worker gets the prompt, the directory and the settings` |
| T-0063-M1 | packages/harness/claude/src/worker.ts | `tool_execution_end` wrote `durationMs: 0` | `a Bash call logs its command, its start time and its duration` |
| T-0063-M2 | packages/harness/claude/src/worker.ts | a message's thinking block was written into its `text` | `an assistant message logs its first 300 characters as one paragraph, without thinking` |
| T-0063-M30 | packages/harness/claude/src/worker.ts | the blocked line and the call end logged the real refusal reason | `a Read under denyPaths is denied, and Read elsewhere is allowed` |
| T-0063-M31 | packages/harness/claude/src/worker.ts | the summary ignored `secretValues` | `a secret of the operad store sent as secretValues is masked in the logged command` |
| T-0063-M32 | packages/harness/claude/src/worker.ts | the start summary judged the original tool name, not the access-match translation | `a denied NotebookEdit or MultiEdit start line shows no path` |
| T-0063-M33 | packages/harness/claude/src/worker.ts | the denial check skipped the translation for one mapped tool (Grep/Glob) | `every tool the translation maps shows only its denial when the profile denies it` |
| T-0063-M34 | packages/harness/claude/src/worker.ts | the denied-call summary dropped the matching rule's name | `a Bash command that denyCommands refuses is denied with the reason, logged, and the run goes on` |
| T-0107-M1 | packages/engine/test/plugin/support.ts | `alive` always reported the pid present, so `waitForGone` never saw it go | `harness-claude/agent > cancel stops the worker and reports interrupted` |

## T-0099 — a message to a running agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M1 | packages/harness/claude/src/worker.ts | a `message` line was not given to the SDK as a user turn | `a message line from the host reaches claude as a user turn while the run hangs` |
| T-0099-M2 | packages/harness/claude/src/index.ts | the step did not pass the inbox to the process | `harness-claude/agent > a message the host sends through the inbox reaches the program as a message line` |
| T-0187-M5 | packages/harness/claude/src/index.ts | the step did not throw the unanswered question, so no `waiting` result | `harness-claude: a call that must ask a person > not answered in time: the step ends waiting, the process exits, the one item stays` |
| T-0187-M7 | packages/harness/claude/src/worker.ts | a command holding a secret value was asked about | `a command that holds a secret value is refused and never asked about` |
| T-0188-M11 | packages/harness/claude/src/worker.ts | claude was given no MCP server for operad's tools | `operad's tools are given to claude as an MCP server that runs from the program, with the home` |
| T-0188-M12 | packages/harness/claude/src/access.ts | operad's tools were judged by the access profile and refused | `operad's own tools > are not judged by the profile, though other MCP tools are refused while a deny rule is set` |

## T-0240 — rework: multi-line log commands and code spans

| id | file | mutation | failing test |
|---|---|---|---|
| T-0240-M8 | packages/harness/claude/src/worker.ts | the logged Bash command no longer kept its line breaks (`keepLines` removed) | `a Bash call logs its command, its start time and its duration` |


## T-0342 — a chat's effort

| id | file | mutation | failing test |
|---|---|---|---|
| T-0342-M5 | packages/harness/claude/src/index.ts | the plugin stopped declaring its efforts | `the efforts claude declares > its effort levels, a default among them, and its own flag` |
| T-0342-M6 | packages/harness/claude/src/index.ts | the step ignored the `effort` param a chat passes | `claude/agent > an effort from a chat reaches the worker as claude's effort` |
| T-0327-M11 | packages/harness/claude/src/access.ts | claude did not judge another server's tool by server and tool | `operad's own tools > another server's tool is judged by server and tool when the profile has allowMcp: a listed one runs, any other asks` |
| T-0327-M14 | packages/harness/claude/src/worker.ts | claude was not given a bot's MCP servers | `a bot's servers are given to claude beside operad's, by name, as the commands the input names` |
| T-0339-M18 | packages/harness/claude/src/worker.ts | claude's prompt went as text only, dropping the images | `images are sent with the prompt as image blocks of the one user message` |
| T-0358-M9 | packages/harness/claude/src/index.ts | the step did not hand its lines to the receiver | `claude/agent > a receiver gets each line the step writes to its log; without one the log is the same` |

## T-0366 — allow_always

| id | file | mutation | failing test |
|---|---|---|---|
| T-0366-M7 | packages/harness/claude/src/index.ts | the step did not merge the user layer into the profile it passed to the worker | `claude: a call that must ask a person > answered allow_always writes the user layer, and the next identical call does not ask` |
## T-0359 — the live increment lines, full ends and tool output

| id | file | mutation | failing test |
|---|---|---|---|
| T-0359-M1 | packages/harness/claude/src/worker.ts | a streamed text delta was added to the block but no `text_delta` line was written | `assistant text and thinking stream as increments, and finished blocks write their full text` |
| T-0359-M2 | packages/harness/claude/src/worker.ts | a streamed thinking delta was added to the block but no `thinking_delta` line was written | `assistant text and thinking stream as increments, and finished blocks write their full text` |
| T-0359-M3 | packages/harness/claude/src/worker.ts | `text_end` carried only the first 300 characters instead of the full message | `an assistant message logs its first 300 characters as one paragraph, without thinking` |
| T-0359-M4 | packages/harness/claude/src/worker.ts | `thinking_end` carried only the first 3 characters instead of the full block | `assistant text and thinking stream as increments, and finished blocks write their full text` |
| T-0359-M5 | packages/harness/claude/src/worker.ts | the increment group interval was 0, so every token wrote a line | `increments are grouped to one line per 100 ms for text and for thinking` |
| T-0359-M6 | packages/harness/claude/src/worker.ts | a tool's output produced no `tool_output` line | `tool output is written with its call id, cut at the shared cap` |
| T-0359-M7 | packages/harness/claude/src/worker.ts | the tool output was not cut at the shared cap and never said `truncated` | `tool output is written with its call id, cut at the shared cap` |
| T-0359-M8 | packages/harness/claude/src/worker.ts | the new lines were written without masking `secretValues` | `a secret value is masked in every new line` |
| T-0359-M9 | packages/harness/claude/src/worker.ts | `includePartialMessages` was not set, so claude sent no increments | `claude asks for partial messages so the increments can be written` |
| T-0359-M11 | packages/harness/claude/src/worker.ts | an increment line no longer held back a suffix that is a prefix of a secret, so joining the grouped deltas exposed the secret | `a secret split across grouped increments is not exposed by joining the deltas` |
| T-0359-M12 | packages/harness/claude/src/worker.ts | `flushDelta(true)` dropped a held suffix that only resembled a secret prefix instead of writing it as the last increment | `a block ending in a secret prefix writes that held suffix as its last increment` |

## T-0367 — releasing held text on every end path

| id | file | mutation | failing test |
|---|---|---|---|
| T-0367-M1 | packages/harness/claude/src/worker.ts | `finish` wrote the Result without releasing the text held back as a possible secret prefix | `a cancelled stream releases text held back as a possible secret` |

## T-0362 — keep the whole tool output for the chat transcript

| id | file | mutation | failing test |
|---|---|---|---|
| T-0362-M16 | packages/harness/claude/src/worker.ts | a long tool output was written as its first line only, so the rest was lost | `tool output is written in lines cut at the shared cap, so none of it is lost` |

## T-0465 — a harness reports whether its agent is signed in

| id | file | mutation | failing test |
|---|---|---|---|
| T-0465-M3 | packages/harness/claude/src/claude-install.ts | `claudeSignedIn` returned true whenever `auth status` could be read instead of its `loggedIn` answer | `claude's signedIn answer > is false when claude auth status says loggedIn false` |
| T-0465-M7 | packages/harness/claude/src/index.ts | removed the cache check, so `claude auth status` ran on every read | `claude's signedIn answer > asks claude once per short cache period` |
| T-0465-M8 | packages/harness/claude/src/claude-install.ts | a missing claude answered false instead of absent | `claude's signedIn answer > is absent when claude is missing or the answer cannot be read` |
| T-0465-M9 | packages/harness/claude/src/claude-install.ts | an unreadable `claude auth status` answer became false instead of absent | `claude's signedIn answer > is absent when claude is missing or the answer cannot be read` |

## T-0472 — claude signedIn follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0472-M6 | packages/harness/claude/src/claude-install.ts | a failing exit with loggedIn true was returned as true instead of absent | `claude's signedIn answer > is absent when a failing exit contradicts loggedIn true` |
| T-0472-M7 | packages/harness/claude/src/index.ts | two clients asking at once each started a probe because the pending answer was not shared | `claude's signedIn answer > two clients asking at once share one probe` |
| T-0472-M8 | packages/harness/claude/src/claude-install.ts | the async lookup returned the symlink instead of the command's real path | `the claude command > the async lookup follows a symlink to the command's real path` |

## T-0497 — only the skills the step gives are loaded

| id | file | mutation | failing test |
|---|---|---|---|
| T-0497-M5 | packages/harness/claude/src/worker.ts | the temporary skill plugin was not passed to the SDK | `a given skill is mounted as a plugin, only that one is loaded, and the plugin is removed at the end` |
| T-0497-M6 | packages/harness/claude/src/worker.ts | the temporary skill plugin was left on disk when the run ended | `a given skill is mounted as a plugin, only that one is loaded, and the plugin is removed at the end` |

## T-0486 — the step's durations

| id | file | mutation | failing test |
|---|---|---|---|
| T-0486-M7 | packages/harness/claude/src/index.ts | the step result did not carry its `timings` | `claude/agent > a scripted worker gives the time to its session line, to the first increment, and the whole step` |

## T-0496 — claude takes messages mid-run

| id | file | mutation | failing test |
|---|---|---|---|
| T-0496-M5 | packages/harness/claude/src/index.ts | claude no longer declared `takesMessagesMidRun` | `claude/agent > the plugin declares that it loads skills itself` |

## T-0516 — a chat's claude worker is kept

| id | file | mutation | failing test |
|---|---|---|---|
| T-0516-M3 | packages/harness/claude/src/worker.ts | a kept worker closed its SDK session after the first reply instead of keeping it | `a second message is answered by the same worker and the same claude` |
| T-0516-M5 | packages/harness/claude/src/worker.ts | `canUseTool` judged every reply with no profile instead of the reply's own | `a kept worker receives this reply's grant, not the previous reply's` |
| T-0516-M7 | packages/harness/claude/src/index.ts | the keep key was a constant, so a worker started with another model, effort, directory, profile, skills or MCP servers was reused | `each change of what the worker was started with ends it` |

## T-0517 — a bot uses the owner's own agent settings

| id | file | mutation | failing test |
|---|---|---|---|
| T-0517-M1 | packages/harness/claude/src/worker.ts | the own-settings switch still passed `settingSources: []` | `the own-settings switch on loads every setting source and leaves the instruction isolation out` |
| T-0517-M2 | packages/harness/claude/src/worker.ts | the own-settings switch left the auto-memory and instruction-file isolation variables in the environment | `the own-settings switch on loads every setting source and leaves the instruction isolation out` |
| T-0517-M3 | packages/harness/claude/src/worker.ts | the `PreToolUse` hook no longer judged the access profile before a user allow rule | `with the own-settings switch on, the profile denies a call in PreToolUse before any user allow rule` |
| T-0517-M4 | packages/harness/claude/src/index.ts | the step did not pass the own-settings switch to the worker | `claude/agent > the own-settings switch reaches the worker only when it is on` |
| T-0517-M8 | packages/harness/claude/src/protocol.ts | `useOwnSettings` was no longer an input field, so the worker refused it as unknown | `the own-settings switch off is exactly today's options and environment` |
| T-0517-M9 | packages/harness/claude/src/worker.ts | the `PreToolUse` hook did not treat a read-only profile as a refusal | `with the own-settings switch on, a read-only profile denies a write in PreToolUse` |

## T-0521 — a leading slash in a message is text

| id | file | mutation | failing test |
|---|---|---|---|
| T-0521-M1 | packages/harness/claude/src/worker.ts | a prompt that starts with `/` was sent without `client_composed`, so claude parsed it as its own command | `a prompt that starts with a slash reaches the model as text, never as one of claude's commands` |
| T-0521-M2 | packages/harness/claude/src/worker.ts | an empty result with no usage carried no reason, so the chat could not say claude ran a local command | `an empty result with no usage reports claude's subtype and the local command it ran` |

## T-0525 — chat access levels

| id | file | mutation | failing test |
|---|---|---|---|
| T-0525-M11 | packages/harness/claude/src/access.ts | a level below `full` no longer made an unchecked tool a refusal | `a chat's access level > plan: one call reaches the level's decision` (and the ask and edits levels) |

## T-0527 — the kept worker test takes its pid from the worker's start

| id | file | mutation | failing test |
|---|---|---|---|
| T-0527-M1 | packages/harness/claude/test/fake-claude.ts | a spawn no longer recorded the worker's pid, so a reply that returned after the kept time left no pid to wait for | `the kept worker ends itself after the kept time` |

## T-0529 — a chat shows how full the context is

| id | file | mutation | failing test |
|---|---|---|---|
| T-0529-M2 | packages/harness/claude/src/worker.ts | the reply's context kept the first model call's usage instead of the last | `the context is the last model call's prompt, not the sum, with the model's window` |
| T-0529-M3 | packages/harness/claude/src/protocol.ts | the 1M variant declared a 200,000-token window | `the models claude declares > each model's context window is declared, including the 1M variants` |

## T-0530 — a harness describes each model it lists

| id | file | mutation | failing test |
|---|---|---|---|
| T-0530-M3 | packages/harness/claude/src/index.ts | a claude model declared only vision, not the reasoning and tools it knows | `the models claude declares > every model is anthropic, with vision, reasoning and tools` |

## T-0532 — the built-in default access profile

| id | file | mutation | failing test |
|---|---|---|---|
| T-0532-M5 | packages/harness/claude/src/index.ts | a step with no access profile passed none to the worker instead of the built-in default | `claude/agent > a step a flow generates with no profile gets the default` |

## T-0536 — claude's default effort from its configured effort

| id | file | mutation | failing test |
|---|---|---|---|
| T-0536-M1 | packages/harness/claude/src/index.ts | claude's efforts ignored the configured `effort`, so no default was declared | `the efforts claude declares > the configured effort is the default` |
## T-0533 — outward questions
| id | file | mutation | failing test |
|---|---|---|---|
| T-0533-M6 | packages/harness/claude/src/access.ts | the profile's outward write was left out of the question | `a background run asks about an outward command with its target` |

## T-0534 — target grants on claude's outward question

| id | file | mutation | failing test |
|---|---|---|---|
| T-0534-M1 | packages/harness/claude/src/index.ts | the harness asker got no target-grant context, so a background outward call could neither record nor use a grant | `claude: a call that must ask a person > always for this flow and target records a grant and the next scheduled run does not ask` |

## T-0549 — an empty claude probe answer is asked again

| id | file | mutation | failing test |
|---|---|---|---|
| T-0549-M1 | packages/harness/claude/src/claude-install.ts | an empty success from `claude --version` or `claude auth status` was believed instead of asked again | `an empty success from either probe is asked again` |

## T-0550 — an empty probe answer is asked only once more

| id | file | mutation | failing test |
|---|---|---|---|
| T-0550-M1 | packages/harness/claude/src/claude-install.ts | an empty success was retried five times instead of once more | `a probe that never answers is refused after a bounded number of asks` |

## T-0556 — a question shows the command it asks about

| id | file | mutation | failing test |
|---|---|---|---|
| T-0556-M1 | packages/harness/claude/src/worker.ts | the ask line's `shown` was summarized as a log, so an unreadable command was hidden from the question | `a question about a command the log cannot read shows the command itself` |

## T-0558 — the claude worker reads the live level for each call

| id | file | mutation | failing test |
|---|---|---|---|
| T-0558-M6 | packages/harness/claude/src/worker.ts | `canUseTool` judged with the turn's startup profile | `a running worker reads the live level again for each call, so lowering asks` |

## T-0560 — the live-level test runs the claude worker as a child

| id | file | mutation | failing test |
|---|---|---|---|
| T-0560-M1 | packages/harness/claude/src/worker.ts | `canUseTool` judged with the turn's startup profile | `a running worker reads the live level again for each call, so lowering asks` |

## T-0569 — AskUserQuestion is a form a person fills in

| id | file | mutation | failing test |
|---|---|---|---|
| T-0569-M7 | packages/harness/claude/src/worker.ts | the permission result dropped the person's `answers`, so the tool got no answer | `AskUserQuestion becomes one form, and the person's answer goes back as its answers` |
| T-0569-M8 | packages/harness/claude/src/access.ts | `AskUserQuestion` was not inert, so the profile refused the agent's own question | `tools outside the table > an inert tool is allowed under any profile` |

## T-0573 — ExitPlanMode is a plan review

| id | file | mutation | failing test |
|---|---|---|---|
| T-0573-M1 | packages/harness/claude/src/worker.ts | `canUseTool` no longer turned `ExitPlanMode` into a plan review, so the tool passed without a person seeing the plan | `ExitPlanMode becomes a plan review: the title, the Markdown and two answers` |
| T-0573-M2 | packages/harness/claude/src/worker.ts | a request for changes no longer set `interrupt: true`, so the reply went on instead of ending | `asking for changes refuses the call with the person's note and interrupts the reply` |
| T-0573-M3 | packages/harness/claude/src/worker.ts | `planReview` always titled the plan `Plan` instead of reading its first heading or line | `a plan's first heading is its title and its whole Markdown is its text` |
| T-0573-M4 | packages/harness/claude/src/worker.ts | the empty-plan check was removed, so the review threw instead of refusing with a message to call again | `an empty plan is refused without asking the person` |
| T-0573-M5 | packages/harness/claude/src/worker.ts | a plan holding a secret value was asked instead of refused | `a plan that holds a secret value is refused without asking the person` |
| T-0573-M6 | packages/harness/claude/src/worker.ts | a host without `askForm` was not refused before the call, so the plan was denied as a failed question instead of named as unaskable | `a host without forms refuses the plan instead of letting it through` |
| T-0573-M7 | packages/harness/claude/src/worker.ts | a rejected plan review fell through to request changes instead of saying nobody reviewed it | `a plan review the host rejected is refused and closed` |

## T-0576 — chat friction follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0576-M1 | packages/harness/claude/src/worker.ts | `askQuestion` keyed the answers by the form's trimmed id instead of claude's raw question text, so a spaced or duplicate-text question was not looked up | `the answers are keyed by claude's own question text, which the form trims` |
| T-0576-M2 | packages/harness/claude/src/worker.ts | claude's `api_retry` system message was ignored, so its retry never became a live item | `claude's own retry report becomes a retry line` |

## T-0588 — the background model declaration

| id | file | mutation | failing test |
|---|---|---|---|
| T-0588-M10 | packages/harness/claude/src/index.ts | claude stopped declaring `backgroundModel: "haiku"` | `claude/agent > the plugin declares that it loads skills itself` |

## T-0620 — the shared login probe

| id | file | mutation | failing test |
|---|---|---|---|
| T-0620-M1 | packages/harness/claude/src/index.ts | `claudeSignedInCached` ran its probe directly instead of through the shared cache, so two callers spawned two processes | `claude's signedIn answer > two clients asking at once share one probe` |
