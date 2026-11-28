# Mutation records — `harness-pi`

Rows whose mutation broke code in `packages/harness/pi/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

## TK0015 — pi worker

| id | file | mutation | failing test |
|---|---|---|---|
| TK0015-M1 | packages/harness/pi/src/worker.ts | a message with no cost object counted as price 0 instead of unpriced | `a model with no price has cost.micros null` |
| TK0015-M2 | packages/harness/pi/src/worker.ts | `cache_read` taken from `cacheWrite` | `a prompt that ends writes the lines in order and a Result with usage, cost and sessionId` |
| TK0015-M3 | packages/harness/pi/src/worker.ts | the `agent_settled` line not written | `a prompt that ends writes the lines in order and a Result with usage, cost and sessionId` |
| TK0015-M4 | packages/harness/pi/src/worker.ts | cancelled run returned exit code 0 instead of 143 | `SIGTERM during a slow fake stream writes a cancelled Result and exits 143` |
| TK0015-M5 | packages/harness/pi/src/worker.ts | resource loader discovery on, `agentDir` set to `$HOME/.pi/agent` | `nothing under the fake HOME .pi is read or created` |
| TK0015-M6 | packages/harness/pi/src/worker.ts | `resumeSession` ignored (always a new session) | `resume: the second run sees the first answer in the context the fake model receives` |
| TK0017-M3 | packages/harness/pi/src/worker.ts | the `tool_call` hook returns `undefined` instead of `{ block: true, reason }` | `a denied bash call is blocked, a blocked line is written, the model gets the reason and the run ends done` |

## TK0016 — harness-pi agent step

| id | file | mutation | failing test |
|---|---|---|---|
| TK0016-M1 | packages/harness/pi/src/index.ts | `piToolEvent` returned `undefined` for `tool_execution_start`, so no tool call opened | `harness-pi/agent > silence with an open tool call is not a stall` |
| TK0016-M2 | packages/harness/pi/src/index.ts | a missing Result line after a signal was `failed` instead of `interrupted` | `harness-pi/agent > a worker killed with SIGKILL ends interrupted and leaves the test alive` |
| TK0016-M3 | packages/harness/pi/src/index.ts | `resumeSession` was left out of the worker's stdin | `harness-pi/agent > resumeSession is passed through to the worker's stdin` |
| TK0016-M4 | packages/harness/pi/src/index.ts | a usage-limit error text was never `usage_limit` | `harness-pi/agent > a model_error failure about a usage limit is usage_limit` |
| TK0016-M5 | packages/harness/pi/src/index.ts | the step stopped declaring `denyCommands` in `enforces` | `harness-pi/agent > the step declares the deny fields it enforces and a timeout above its wall time` |

## TK0018 — pi dogfood

| id | file | mutation | failing test |
|---|---|---|---|
| TK0018-M1 | packages/harness/pi/src/index.ts | the step's declared results named `cancelled` instead of `interrupted`, so they differed from radian's | `this repository's dev.json with the pi worker > worker.use harness-pi/agent validates and the dev flow resolves it` |

| id | file | mutation | failing test |
|---|---|---|---|
| TK0013-M1 | packages/harness/pi/spike/fake-provider.ts | dropped the tool call from the fake assistant message | `a tool call to read runs` (removed) |
| TK0013-M2 | packages/harness/pi/spike/pi-session.ts | `createSpikeSession` ignored the supplied session manager and used an in-memory one | `a session file reopens and a second prompt sees the first message` |
| TK0013-M3 | packages/harness/pi/spike/fake-provider.ts | set `usage.totalTokens` to 0 in the fake assistant message | `a prompt ends with the fixed answer and message_end carries usage` (removed) |
| TK0013-M4 | packages/harness/pi/spike/auth-writer.ts | `hold` mode wrote its credential without taking the lock | `auth.json locking blocks a second writer until the lock is released` |
| TK0013-M5 | packages/harness/pi/spike/auth-writer.ts | `unlocked-read` read the file after the gate instead of snapshotting it before | `the same read-modify-write without the lock loses a credential` |
| pi-step-model-M1 | packages/harness/pi/src/index.ts | the setting won over the `--model` flag | `--model and --thinking in args reach the worker and win over the settings` |
| pi-step-model-M2 | packages/harness/pi/src/index.ts | removed the "given twice" check for `--model` | `a model given twice fails with invalid_args and the worker is not started` |
| pi-step-model-M3 | packages/harness/pi/src/index.ts | an unknown entry in `args` was skipped instead of rejected | `an unknown flag fails with invalid_args and the worker is not started` |
| T-0022-M7 | packages/harness/pi/src/index.ts | the usage left the model out (`model: null`) | `harness-pi/agent > the usage names the model setting when the step has no --model` |
| T-0022-M10 | packages/harness/pi/src/worker.ts | the worker's cost did not say `incomplete` when a message had no price | `a run where one message had no price reports the priced part as incomplete` |
| T-0022-M11 | packages/harness/pi/src/index.ts | an early failure recorded `model: null` | `harness-pi/agent > a step that fails before it starts still records the model it named` |
| T-0025-M5 | `packages/harness/pi/src/worker.ts` | a call that matched a grant ran whether or not the host used the grant up | `a granted call runs once after the host used the grant; the same call again and another call are blocked` |
| T-0025-M6 | `packages/harness/pi/src/index.ts` | the step answered `used: true` without asking the engine to use the grant | `harness-pi/agent > a grant in the profile is used through the host before the program goes on` |
| T-0036-M1 | packages/harness/pi/src/pi-install.ts | the walk up accepted a `package.json` of any name | `findPi > a package.json with another name all the way up is refused (and the wrapper test)` |
| T-0036-M2 | packages/harness/pi/src/pi-install.ts | the version floor was not enforced | `findPi > a version below the floor is refused naming both versions` |
| T-0036-M3 | packages/harness/pi/src/pi-install.ts | a prerelease compared equal to its release | `findPi > a prerelease of the floor is below it; a prerelease above it is accepted` |
| T-0036-M4 | packages/harness/pi/src/pi-install.ts | `exports["."]` conditions were not read (only `types`) (also T-0036-M6) | `findPi > finds a bun global install and an npm global install` |
| T-0036-M5 | packages/harness/pi/src/pi-install.ts | the command was not resolved to its real path (symlinks not followed) | `findPi > finds a bun global install and an npm global install` |
| T-0036-M7 | packages/harness/pi/src/worker.ts | the worker did not log the pi version it loaded | `the worker logs the pi version it loaded and where from` |
| T-0036-M8 | packages/harness/pi/src/worker.ts | the worker ignored `piCommand` and always looked up `pi` | `without a pi the worker fails with the model_error reason and says what is missing` |
| T-0036-M9 | packages/harness/pi/src/index.ts | the `command` setting was not passed to the worker | `harness-pi:prompt > the command setting reaches the worker as piCommand; unset it is pi` |
| T-0036-M10 | packages/harness/pi/src/index.ts | `check` did not look for pi | `harness-pi check > refuses when there is no pi on PATH` |
| T-0036-M11 | packages/harness/pi/src/pi-install.ts | an `exports` entry that is missing or outside the package was accepted | `findPi > an exports entry that is not a file in the package is refused` |
| T-0045-M1 | packages/harness/pi/src/worker.ts | a bash call without a `timeout` got none instead of the limit | `a bash call that blocks on a FIFO is stopped by bashTimeoutSecs, the model gets an error and the run ends done` |
| T-0045-M2 | packages/harness/pi/src/worker.ts | the worker kept `BASH_ENV` in its environment | `the agent's shell does not read BASH_ENV, where a user's aliases and functions could come from` |
| T-0045-M3 | packages/harness/pi/src/index.ts | the `bashTimeoutSecs` setting was not passed to the worker | `harness-pi/agent > bashTimeoutSecs reaches the worker; unset it is 1800` |
| T-0045-M4 | packages/harness/pi/src/protocol.ts | `parseInput` accepted a `bashTimeoutSecs` of 0 | `parseInput refuses a bashTimeoutSecs that is 0, negative, fractional or not a number, and names the field` |
| T-0063-M1 | packages/harness/pi/src/worker.ts | `tool_execution_end` wrote `durationMs: 0` | `a bash call logs its command, its start time and its duration, and no output` |
| T-0063-M30 | packages/harness/pi/src/worker.ts | the blocked line and the call end logged the real refusal reason | `a read of a denied path is blocked; an allowed read runs` |
| T-0063-M31 | packages/harness/pi/src/worker.ts | the summary ignored `secretValues` | `a secret of the operad store sent as secretValues is masked in the logged command` |

## T-0099 — a message to a running agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M1 | packages/harness/pi/src/worker.ts | a `message` line was not steered into the session | `a message line from the host steers the agent: the model's next call sees it` |
| T-0099-M2 | packages/harness/pi/src/index.ts | the step did not pass the inbox to the process | `harness-pi/agent > a message the host sends through the inbox reaches the program as a message line` |
| T-0187-M8 | packages/harness/pi/src/worker.ts | an `allow` answer did not let the call through | `a command askCommands matches asks a person: allowed, it runs once; the same command again asks again` |
| T-0187-M9 | packages/harness/pi/src/worker.ts | a command holding a secret value was asked about | `a command that holds a secret value is refused and never asked about` |
| T-0187-M10 | packages/harness/pi/src/index.ts | the step did not throw the unanswered question, so no `waiting` result | `harness-pi: a call that must ask a person > not answered in time: the step ends waiting, the process exits, the one item stays` |
| T-0188-M14 | packages/harness/pi/src/worker.ts | pi was not given operad's tools | `operadTools registers operad's tools with pi: the model calls one and it runs against the home` |

## T-0240 — rework: multi-line log commands and code spans

| id | file | mutation | failing test |
|---|---|---|---|
| T-0240-M9 | packages/harness/pi/src/worker.ts | the logged bash command no longer kept its line breaks (`keepLines` removed) | `a multi-line bash command keeps its lines in the log` |


## T-0342 — a chat's effort

| id | file | mutation | failing test |
|---|---|---|---|
| T-0342-M7 | packages/harness/pi/src/index.ts | the plugin stopped declaring its efforts | `the efforts pi declares > its thinking levels under the same setting, a default, and the thinking flag` |
| T-0342-M8 | packages/harness/pi/src/index.ts | the step ignored the `effort` param a chat passes | `pi/agent > an effort from a chat reaches the worker as pi's thinking level` |
| T-0339-M19 | packages/harness/pi/src/worker.ts | pi's prompt went without its images | `images are given to pi with the prompt: the model's context holds the image` |
| T-0358-M10 | packages/harness/pi/src/index.ts | the step did not hand its lines to the receiver | `pi/agent > a receiver gets each line the step writes to its log; without one the log is the same` |

## T-0366 — allow_always

| id | file | mutation | failing test |
|---|---|---|---|
| T-0366-M6 | packages/harness/pi/src/index.ts | the step did not merge the user layer into the profile it passed to the worker | `pi: a call that must ask a person > answered allow_always writes the user layer, and the next identical call does not ask` |
| T-0366-M11 | packages/harness/pi/src/index.ts | a late `allow_always` did not write the user layer before the resumed step ran | `pi: a call that must ask a person > a late allow_always writes the user layer and the resumed call does not ask` |
## T-0365 — pi's models come from pi

| id | file | mutation | failing test |
|---|---|---|---|
| T-0365-M1 | packages/harness/pi/src/index.ts | a catalogue row was read as provider and a fixed id, not provider/id | `the models pi declares > the list is pi's catalogue` |
| T-0365-M2 | packages/harness/pi/src/index.ts | the `models` setting was ignored and the whole catalogue offered | `the models pi declares > the models setting narrows the list` |
| T-0365-M3 | packages/harness/pi/src/index.ts | the default ignored the `model` setting | `the models pi declares > the default is the model setting, else pi's own default, else none` |
| T-0365-M4 | packages/harness/pi/src/index.ts | a non-zero exit of pi still gave its output as the list | `the models pi declares > a pi that exits non-zero gives an empty list` |
| T-0365-M5 | packages/harness/pi/src/index.ts | asking pi had no timeout | `the models pi declares > a pi that does not answer in time gives an empty list` |
| T-0365-M6 | packages/harness/pi/src/index.ts | the catalogue was not kept: pi was asked at every read | `the models pi declares > pi is not asked at load, and the answer is kept until it is old` |
| T-0365-M7 | packages/harness/pi/src/index.ts | the step did not report a configured model pi does not list | `pi/agent with a configured model pi does not list > the step reports it once in its log; a listed model reports nothing` |
| T-0365-M9 | packages/harness/pi/src/index.ts | rows were read before any header row, so pi's no-model sentence became a model | `the models pi declares > pi's no-model sentence is not a model` |
## T-0360 — assistant text, thinking and tool output lines

| id | file | mutation | failing test |
|---|---|---|---|
| T-0360-M1 | packages/harness/pi/src/worker.ts | every text delta wrote its own line; the 100 ms grouping was gone | `increments are grouped to one line per stream per 100 ms, with an injected clock` |
| T-0360-M2 | packages/harness/pi/src/worker.ts | thinking deltas were not written | `increments are grouped to one line per stream per 100 ms, with an injected clock` |
| T-0360-M3 | packages/harness/pi/src/worker.ts | the full text of a finished message was not written (`text_end`) | `a prompt that ends writes the lines in order and a Result with usage, cost and sessionId` |
| T-0360-M4 | packages/harness/pi/src/worker.ts | the full text of a finished thinking block was not written (`thinking_end`) | `thinking streams as increments and ends with the full block, which message_end leaves out` |
| T-0360-M5 | packages/harness/pi/src/worker.ts | a tool call's output was never written | `a tool call's output is written with its call id, and a refused call writes none` |
| T-0360-M6 | packages/harness/pi/src/worker.ts | `toolOutputOf` left the output uncut instead of capping it | `tool output is cut to the shared cap and marked truncated` |
| T-0360-M7 | packages/harness/pi/src/worker.ts | `text_end` did not mask a secret value | `secret values are masked in the new text, thinking and tool output lines` |
| T-0360-M8 | packages/harness/pi/src/worker.ts | `toolOutputOf` did not mask a secret value | `secret values are masked in the new text, thinking and tool output lines` |
| T-0360-M9 | packages/harness/pi/src/worker.ts | a refused call's result was written as `tool_output` | `a tool call's output is written with its call id, and a refused call writes none` |
| T-0360-M10 | packages/harness/pi/src/worker.ts | text still buffered when a message stopped was dropped | `a run stopped mid-message writes the text it had not grouped yet` |
| T-0360-M12 | packages/harness/pi/src/worker.ts | an increment batch was emitted without holding back a partial secret, so each piece of a split secret went out | `a secret split across increment lines is held back, so no line carries a piece of it` |
| T-0360-M13 | packages/harness/pi/src/worker.ts | a run's Result was written without releasing the held prefix, so a stopped reply lost it | `a cancelled stream releases text held back as a possible secret` |
| T-0360-M14 | packages/harness/pi/src/worker.ts | the holdback checked only the raw secret, so a split JSON-escaped secret went out in pieces | `a JSON-escaped secret split across increment lines is held back too` |

## T-0362 — a long tool output in lines that join back whole

| id | file | mutation | failing test |
|---|---|---|---|
| T-0362-M17 | packages/harness/pi/src/worker.ts | a long tool output was written as its first line only, so the chunks past the cap were dropped | `a tool output longer than the cap reaches the receiver in chunks past the cap` |

## T-0465 — a harness reports whether its agent is signed in

| id | file | mutation | failing test |
|---|---|---|---|
| T-0465-M4 | packages/harness/pi/src/index.ts | `hasCredential` counted a credential for any provider, not the provider pi will use | `pi's signedIn answer > is false when the credential is for another provider`, `pi's signedIn answer > falls back to pi's default provider` |
| T-0465-M12 | packages/harness/pi/src/index.ts | a missing auth file answered absent instead of false | `pi's signedIn answer > is absent when the file cannot be read, and false when it is missing` |
| T-0465-M13 | packages/harness/pi/src/index.ts | a malformed auth file answered false instead of absent | `pi's signedIn answer > is absent when the file cannot be read, and false when it is missing` |

## T-0472 — pi reads the auth file's shape

| id | file | mutation | failing test |
|---|---|---|---|
| T-0472-M9 | packages/harness/pi/src/auth-file.ts | the streaming redactor kept value strings, so a credential secret survived into the text | `reading an auth file's shape > keeps keys and structure, and never keeps a value string` |

## T-0497 — only the skills the step gives are loaded

| id | file | mutation | failing test |
|---|---|---|---|
| T-0497-M3 | packages/harness/pi/src/worker.ts | the given skill directories were not passed to pi's resource loader | `only the skill directories given are loaded, and the session log names them` |
| T-0497-M4 | packages/harness/pi/src/worker.ts | the session log no longer named the skills it loaded | `only the skill directories given are loaded, and the session log names them` |

## T-0486 — the session line and the step's durations

| id | file | mutation | failing test |
|---|---|---|---|
| T-0486-M3 | packages/harness/pi/src/worker.ts | the worker wrote no `session` line before the prompt | `a prompt that ends writes the lines in order and a Result with usage, cost and sessionId` |
| T-0486-M8 | packages/harness/pi/src/index.ts | the step result was returned without its `timings` | `pi/agent > a scripted worker gives the time to its session line, to the first increment, and the whole step` |

## T-0511 — pi's model list never blocks a load

| id | file | mutation | failing test |
|---|---|---|---|
| T-0511-M1 | packages/harness/pi/src/model-list.ts | a first use with no kept list returned an empty list instead of waiting for one refresh | `the models pi declares > first use with no kept file waits for one refresh` |
| T-0511-M2 | packages/harness/pi/src/model-list.ts | concurrent readers no longer shared one in-flight refresh | `the models pi declares > two readers at once start one refresh` |
| T-0511-M3 | packages/harness/pi/src/model-list.ts | a failed refresh wrote an empty list over the previous one | `the models pi declares > a failed refresh keeps the old list and is logged once` |
| T-0511-M4 | packages/harness/pi/src/model-list.ts | a stale kept list no longer started a background refresh | `the models pi declares > a stale file starts one background refresh and later reads see the new list` |
| T-0511-M5 | packages/harness/pi/src/model-list.ts | the kept file was ignored, so a load had no list to read | `the models pi declares > loading the plugins does not start pi, and the kept file gives the list` |
| T-0511-M9 | packages/harness/pi/src/model-list.ts | a stale kept list made `modelsReady` wait for the background refresh instead of answering from the kept rows | `the models pi declares > a stale file starts one background refresh and later reads see the new list` |
| T-0511-M10 | packages/harness/pi/src/model-list.ts | the kept file was refused unless it also named the command, so a fresh list was ignored and pi was asked | `the models pi declares > loading the plugins does not start pi, and the kept file gives the list` |

## T-0515 — a chat's worker is kept between replies

| id | file | mutation | failing test |
|---|---|---|---|
| T-0515-M2 | packages/harness/pi/src/index.ts | the keep key was a constant, so a worker started with another model, effort, directory, profile or skills was reused | `each change of what the worker was started with ends it` |
| T-0515-M4 | packages/harness/pi/src/worker.ts | the kept worker's idle timer no longer ended the process | `a kept worker ends itself when the kept time runs out` |
| T-0515-M6 | packages/harness/pi/src/worker.ts | a failed reply was kept as if it had ended done | `a failed reply does not keep its worker` |

## T-0518 — a pi bot may use the owner's own settings

| id | file | mutation | failing test |
|---|---|---|---|
| T-0518-M1 | packages/harness/pi/src/worker.ts | the own-settings switch off also used pi's own agent directory, so the loader options were not today's | `the own-settings switch off gives today's loader options exactly` |
| T-0518-M2 | packages/harness/pi/src/worker.ts | the own-settings switch on kept operad's `agentDir` for the resource loader, so the owner's context files, skills and extensions did not load | `the own-settings switch on loads a context file, a skill and an extension from the owner's pi directory` |
| T-0518-M3 | packages/harness/pi/src/worker.ts | a tool name the profile did not know was allowed instead of refused, so an extension's tool ran a denied command | `an extension's tool cannot run a refused command or write a refused path` |
| T-0518-M4 | packages/harness/pi/src/worker.ts | the bot's skills were not put before the owner's, so the owner's skill won a name clash | `a skill name both the bot and the owner's pi define is the bot's` |
| T-0518-M5 | packages/harness/pi/src/index.ts | the step did not pass the own-settings switch to the worker | `pi/agent > the own-settings switch reaches the worker only when it is on` |
| T-0518-M6 | packages/harness/pi/src/protocol.ts | `parseInput` accepted `useOwnSettings` but did not return it, so the worker ignored it | `the own-settings switch on loads a context file, a skill and an extension from the owner's pi directory` |
| T-0518-M7 | packages/harness/pi/src/worker.ts | operad's compaction and retry overrides were not applied after the owner's settings loaded, so the owner's settings turned them on | `the own-settings switch on loads a context file, a skill and an extension from the owner's pi directory` |

## T-0521 — a leading slash in a message is text

| id | file | mutation | failing test |
|---|---|---|---|
| T-0521-M1 | packages/harness/pi/src/worker.ts | the prompt expanded prompt templates, so `/clear` ran the owner's template | `a prompt that starts with a slash reaches the model as text, not as a prompt template` |

## T-0525 — chat access levels

| id | file | mutation | failing test |
|---|---|---|---|
| T-0525-M12 | packages/harness/pi/src/worker.ts | a level below `full` no longer made an owner extension's unchecked tool a refusal | `an extension's tool is refused at an access level below full when own settings are on` |

## T-0529 — a chat shows how full the context is

| id | file | mutation | failing test |
|---|---|---|---|
| T-0529-M1 | packages/harness/pi/src/worker.ts | the reply's context used the summed usage of every call instead of the last call's prompt | `usage and cost are summed over every message_end, with a tool call between` |
| T-0529-M4 | packages/harness/pi/src/model-list.ts | a model row's context column ignored its K/M unit | `the models pi declares > each row's context column becomes its context window` |

## T-0530 — a harness describes each model it lists

| id | file | mutation | failing test |
|---|---|---|---|
| T-0530-M2 | packages/harness/pi/src/model-list.ts | the registry's display `name` was dropped from a model's description | `the models pi declares > pi's registry fills a model's name, provider, vision and reasoning` |

## T-0532 — the built-in default access profile

| id | file | mutation | failing test |
|---|---|---|---|
| T-0532-M6 | packages/harness/pi/src/index.ts | a step with no access profile passed none to the worker instead of the built-in default | `pi/agent > the worker gets the prompt, the directories, the settings and no discovery` |

## T-0536 — pi's default effort from its own settings

| id | file | mutation | failing test |
|---|---|---|---|
| T-0536-M1 | packages/harness/pi/src/index.ts | pi's default effort ignored its own `defaultThinkingLevel` | `the efforts pi declares > the default is pi's own defaultThinkingLevel when pi names one` |
| T-0536-M2 | packages/harness/pi/src/index.ts | operad's `thinkingLevel` was ignored for the default effort | `the efforts pi declares > operad's thinkingLevel setting wins over pi's own default` |
## T-0533 — background profile
| id | file | mutation | failing test |
|---|---|---|---|
| T-0533-M5 | packages/harness/pi/src/index.ts | a background run passed no `background` marker to its worker | `pi: a call that must ask a person > a background run ignores the user layer and is not offered allow_always` |

## T-0534 — target grants on pi's outward question

| id | file | mutation | failing test |
|---|---|---|---|
| T-0534-M1 | packages/harness/pi/src/index.ts | the harness asker got no target-grant context, so a background outward call could neither record nor use a grant | `pi: a call that must ask a person > always for this flow and target records a grant and the next scheduled run does not ask` |

## T-0556 — a question shows the command it asks about

| id | file | mutation | failing test |
|---|---|---|---|
| T-0556-M1 | packages/harness/pi/src/worker.ts | the ask line's `shown` was summarized as a log, so an unreadable command was hidden from the question | `a question about a command the log cannot read shows the command itself` |

## T-0558 — the pi worker reads the live level for each call

| id | file | mutation | failing test |
|---|---|---|---|
| T-0558-M5 | packages/harness/pi/src/worker.ts | `currentProfile` returned the startup profile, so a lowered level did not reach the next call | `a real worker reads the live level again for each call, so lowering to ask applies` |

## T-0574 — pi retries a chat's failed model request

| id | file | mutation | failing test |
|---|---|---|---|
| T-0574-M1 | packages/harness/pi/src/index.ts | the step did not pass `retry` to the worker | `pi/agent > a chat's retry reaches the worker only when it asks for it` |
| T-0574-M2 | packages/harness/pi/src/worker.ts | the settings override kept pi's retry off even when the step asked | `a chat turns pi's retry on, with pi's attempts and backoff, and reports the wait` |
| T-0574-M3 | packages/harness/pi/src/worker.ts | a task's worker turned pi's retry on | `a task keeps pi's retry off, and a chat whose retries run out fails as before` |
| T-0574-M4 | packages/harness/pi/src/worker.ts | the worker wrote no `retry_start` line for the chat's live view | `a chat turns pi's retry on, with pi's attempts and backoff, and reports the wait` |
| T-0574-M5 | packages/harness/pi/src/worker.ts | a successful message did not clear the earlier failed attempt's error | `a chat turns pi's retry on, with pi's attempts and backoff, and reports the wait` |

## T-0620 — one read of the model files

| id | file | mutation | failing test |
|---|---|---|---|
| T-0620-M1 | packages/harness/pi/src/index.ts | `piModels` computed windows and info without the kept list it had just read, so each read the file again | `the models pi declares > one models read reads each pi file once and leaves an unchanged registry unread` |
| T-0620-M2 | packages/harness/pi/src/model-list.ts | the registry parse was reused even after the file's mtime or size changed | `the models pi declares > a changed registry file is read again and its new description is seen` |

## T-0674 — the user's pi default model

| id | file | mutation | failing test |
|---|---|---|---|
| T-0674-M1 | packages/harness/pi/src/index.ts | the user's pi default model was not resolved and sent, so a run with no `model` setting gave the child no model | `pi/agent > pi's default model from its settings reaches the worker when neither the step nor the settings names one` |

## T-0677 — the pi operad installs in the home

| id | file | mutation | failing test |
|---|---|---|---|
| T-0677-M3 | packages/harness/pi/src/pi-install.ts | `findPi` did not fall back to the home's package, so a home with operad's pi looked like no pi at all | `findPi > with no pi on PATH, the pi operad installed in the home is used` |
| T-0677-M7 | packages/harness/pi/src/index.ts | `check` called `findPi` without the home, so `operad plugin check` failed on the pi operad installed | `pi check > passes with the pi operad installed in the home when PATH has none` |

## T-0687 — the stall test read a marker before its pid was written

| id | file | mutation | failing test |
|---|---|---|---|
| T-0687-M1 | packages/harness/pi/test/heavy/plugin.test.ts | the stall test took the marker with `Number(readFileSync(...))` instead of `waitForPid`, so a read between the file's creation and its write took pid 0, which `kill -0` always finds; a fake worker that created the marker empty and filled it 500 ms later made the race deterministic | `pi/agent > silence without an open tool call is a stall` (the run ended as a stall, then the wait for the group to stop saw pid 0 present for 10 s) |

## T-0678 — the login question and the pi login step

| id | file | mutation | failing test |
|---|---|---|---|
| T-0678-M5 | packages/harness/pi/src/login-protocol.ts | `codexAuthUrl` accepted any https address, so another host could reach the login question | `a login address > another host or path is not the ChatGPT login, whatever its scheme` |

## T-0703 — the ChatGPT login is pi's own command

| id | file | mutation | failing test |
|---|---|---|---|
| T-0703-M1 | packages/harness/pi/src/login.ts | `openai-codex` offered as a route again | `pi/login > the first question offers API-key routes only and tells where a ChatGPT plan logs in` |
| T-0703-M2 | packages/harness/pi/src/login.ts | no provider's API-key route offered | `pi/login > the first question offers API-key routes only and tells where a ChatGPT plan logs in` |
| T-0703-M3 | packages/harness/pi/src/pi-install.ts | the command printed `pi` even when only operad's own pi exists | `the ChatGPT login command > is the full command of operad's own pi when pi is not on PATH` |
| T-0703-M4 | packages/harness/pi/src/login.ts | the command line left out of the first question | `pi/login > the first question offers API-key routes only and tells where a ChatGPT plan logs in` |
| T-0703-M5 | packages/harness/pi/src/index.ts | `signedIn` remembered its first answer | `a login pi made elsewhere > is seen by the next signedIn check, with no restart` |

## T-0766 — pi compacts a long chat

| id | file | mutation | failing test |
|---|---|---|---|
| T-0766-M1 | packages/harness/pi/src/worker.ts | the compaction ran whatever the context size | `a context under the share is not compacted and runs no flush turn` |
| T-0766-M2 | packages/harness/pi/src/worker.ts | the flush turn's message text was shown as a reply increment | `a context over the share runs one silent flush turn and then compacts; the reply stays the first turn's` |
| T-0766-M3 | packages/harness/pi/src/worker.ts | the reply text was not held back, so the flush turn's word became the final message | `a context over the share runs one silent flush turn and then compacts; the reply stays the first turn's` |
| T-0766-M4 | packages/harness/pi/src/worker.ts | a failed flush turn left its error set, so the whole reply failed | `a failed flush turn does not stop the compaction or fail the reply` |
| T-0766-M5 | packages/harness/pi/src/worker.ts | the context after a compaction was not reported, so the chat saw the old size | `a context over the share runs one silent flush turn and then compacts; the reply stays the first turn's` |
| T-0766-M6 | packages/harness/pi/src/worker.ts | a compact-only run still sent the prompt to the model | `compact.only compacts a resumed session without a prompt and without a reply` |

## T-0766 — pi compacts a long chat

| id | file | mutation | failing test |
|---|---|---|---|
| T-0766-M1 | packages/harness/pi/src/worker.ts | the compaction ran whatever the context size | `a context under the share is not compacted and runs no flush turn` |
| T-0766-M2 | packages/harness/pi/src/worker.ts | the flush turn's message text was shown as a reply increment | `a context over the share runs one silent flush turn and then compacts; the reply stays the first turn's` |
| T-0766-M3 | packages/harness/pi/src/worker.ts | the reply text was not held back, so the flush turn's word became the final message | `a context over the share runs one silent flush turn and then compacts; the reply stays the first turn's` |
| T-0766-M4 | packages/harness/pi/src/worker.ts | a failed flush turn left its error set, so the whole reply failed | `a failed flush turn does not stop the compaction or fail the reply` |
| T-0766-M5 | packages/harness/pi/src/worker.ts | the context after a compaction was not reported, so the chat saw the old size | `a context over the share runs one silent flush turn and then compacts; the reply stays the first turn's` |
| T-0766-M6 | packages/harness/pi/src/worker.ts | a compact-only run still sent the prompt to the model | `compact.only compacts a resumed session without a prompt and without a reply` |

## T-0767 — pi prunes old tool results

| id | file | mutation | failing test |
|---|---|---|---|
| T-0767-M1 | packages/harness/pi/src/prune.ts | the cache lifetime check removed, so a live cache was pruned | `before the cache lifetime ends nothing is pruned` |
| T-0767-M2 | packages/harness/pi/src/prune.ts | the minimum savings check removed | `below the minimum savings nothing is pruned even after expiry` |
| T-0767-M3 | packages/harness/pi/src/prune.ts | the kept turns off by one (`>` for `>=`) | `after it, old results become a placeholder naming the tool and recent ones stay` |
| T-0767-M4 | packages/harness/pi/src/prune.ts | the placeholder did not name the tool | `after it, old results become a placeholder naming the tool and recent ones stay` |
| T-0767-M5 | packages/harness/pi/src/worker.ts | the `context` hook returned `undefined` instead of the pruned messages | `after the cache lifetime, old tool results reach the model as a placeholder and the session keeps them` |
| T-0767-M6 | packages/harness/pi/src/worker.ts | a new process ignored the session's last assistant message time | `a resumed session is pruned by the time of its last message, not by a fresh process` |
| T-0790-M1 | packages/harness/pi/src/index.ts | the step accepted a compaction share above 1 (`compactOf` checked only `> 0`) | `pi/agent > a chat's compaction input reaches the worker, and a bad share fails the step by name` |

The rows above reused ids that other packages hold for T-0790 (T-0790-M1); they are renumbered below as T-0790-M5 (the lines above stay, rows are append-only).

| T-0790-M5 | packages/harness/pi/src/index.ts | the step accepted a compaction share above 1 (`compactOf` checked only `> 0`) | `pi/agent > a chat's compaction input reaches the worker, and a bad share fails the step by name` |

_The second "## T-0766" section above repeats the rows of the first; the rows of the first stand._

## T-0814 — a question carries a command for the person to run

| id | file | mutation | failing test |
|---|---|---|---|
| T-0814-M1 | packages/harness/pi/src/login.ts | the provider question carried no command | `pi/login > the first question names the bundled pi when pi is not on PATH` |
| T-0814-M2 | packages/harness/pi/src/login.ts | the sentence did not say that logging in here takes an API key | `pi/login > the first question offers API-key routes only and tells where a ChatGPT plan logs in` |

## T-0817 — what the reviews of the terminal tasks found

| id | file | mutation | failing test |
|---|---|---|---|
| T-0817-M32 | packages/harness/pi/src/index.ts | a person's command ignored the pi operad installed | `pi's command for a person > is the pi operad installed when PATH has none, the setting's otherwise, and none for a pi on PATH` |

## T-0820 — the login question says its command once

| id | file | mutation | failing test |
|---|---|---|---|
| T-0820-M1 | packages/harness/pi/src/login.ts | the prompt said the command inline again | `pi/login > the first question offers API-key routes only and tells where a ChatGPT plan logs in` |
| T-0820-M2 | packages/harness/pi/src/login.ts | the provider question carried no command | `pi/login > the first question offers API-key routes only and tells where a ChatGPT plan logs in` |

| id | file | mutation | failing test |
|---|---|---|---|
| T-0822-M13 | packages/harness/pi/src/login.ts | the model choice read the list kept from before the login | `pi/login > the model choice asks pi again, not the list kept from before the login` |

| id | file | mutation | failing test |
|---|---|---|---|
| T-0824-M2 | packages/harness/pi/src/model-list.ts | `pi --list-models` was not given the configured credentials file, as before the fix | `pi/login > with its own credentials file, the list after the login has the new provider`; `the models pi declares > a configured credentials file is read with pi's other files, and none of them is changed` |

| id | file | mutation | failing test |
|---|---|---|---|
| T-0825-M3 | packages/harness/pi/src/model-list.ts | a name taken between the removal and the link failed the relink | `the models pi declares > a link another process made first does not fail the relink` |
| T-0825-M4 | packages/harness/pi/src/model-list.ts | links to entries that left pi's folder were kept | `the models pi declares > the list folder drops links to entries that left pi's folder, and links no lock` |
| T-0825-M5 | packages/harness/pi/src/model-list.ts | pi's lock entries were linked | `the models pi declares > the list folder drops links to entries that left pi's folder, and links no lock` |
| T-0825-M6 | packages/harness/pi/src/model-list.ts | a configured file that did not exist yet was not linked, as before the fix | `the models pi declares > a configured file pi creates appears at its configured place and stays` |
| T-0825-M7 | packages/harness/pi/src/index.ts | a models file of its own was not given to `pi --list-models` | `the models pi declares > a models file of its own is given to pi, beside pi's own credentials file` |
| T-0825-M8 | packages/harness/pi/src/index.ts | the default credentials file left pi to find its folder, whatever that folder was, as before the fix | `the models pi declares > default files outside the folder pi was told to use are still the ones it lists from` |

## T-0816 — every shipped plugin on in a new home

| id | file | mutation | failing test |
|---|---|---|---|
| T-0816-M17 | packages/harness/pi/src/index.ts | pi never said its agent was missing, so a claude home asked for a pi login | `serve on a new home with nothing set up > with only a signed-in claude, nothing waits: the pi that is not there asks for no login` |
| T-0816-M18 | packages/harness/pi/src/pi-install.ts | the pi installed in the home did not count | `whether pi's agent is on this machine > the pi operad installed in the home counts` |
| T-0816-M27 | packages/harness/pi/src/index.ts | pi declared no setup guide | ``a harness's setup guide > a harness whose agent is missing shows a guide and the missing item `agent` `` |
| T-0816-M28 | packages/harness/pi/skills/setup/SKILL.md | pi's guide lost its step for `agent` | `a harness's setup guide > each guide has a step for every item and its package ships it` |
| T-0816-M29 | packages/harness/pi/package.json | pi's package did not ship the guide | `a harness's setup guide > each guide has a step for every item and its package ships it` |

## T-0816 — a replaced login worker

| id | file | mutation | failing test |
|---|---|---|---|
| T-0816-M45 | packages/harness/pi/src/index.ts | a replaced login worker did not count, so on a machine with no pi it was not offered as an agent | `the pi login over HTTP saves the key and ends logged in`, `whether pi's agent is on this machine > a replaced login program needs no pi on PATH` |

## T-0826 — an agent signed out or too old is not set up

| id | file | mutation | failing test |
|---|---|---|---|
| T-0826-M7 | packages/harness/pi/src/pi-install.ts | a pi below the floor was a failed check again | `pi check > a pi below the floor is not set up, with both versions, and no failure` |

## T-0831 — review findings of the offered shipped plugins

| id | file | mutation | failing test |
|---|---|---|---|
| T-0831-M13 | packages/harness/pi/skills/setup/SKILL.md | the guide named bare `pi auth login` | `the setup guide names no bare pi command for the ChatGPT login, which operad's own pi is not` |
