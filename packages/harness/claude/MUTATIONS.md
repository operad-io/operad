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

