# Mutation records — `harness-process`

Rows whose mutation broke code in `packages/harness/process/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

## TK0014 — the shared harness process helper

| id | file | mutation | failing test |
|---|---|---|---|
| TK0014-M1 | packages/harness/process/src/process.ts | ignored the `toolEvent` classifier, so no line counted as a tool call | `a pi tool call pauses the stall timer until its end line` |

| id | file | mutation | failing test |
|---|---|---|---|
| TK0009-M9 | packages/harness/process/src/process.ts | the harness drain used `globalThis.setTimeout` instead of the injected clock | `the harness process > a child that leaves the group cannot hold the run open` (timed out) |
| TK0009-M10 | packages/harness/process/src/process.ts | a finished harness run took the grace stop instead of a direct SIGKILL | `the harness process > a child that leaves the group cannot hold the run open` (sleeps 1) |
| T-0021-M9 | packages/harness/process/src/limit.ts | `modelLimit` keyed a model that is not in `concurrency` instead of leaving it unlimited | `harness-pi/agent step limit > a model not in the map, or no model, has no limit` (in `packages/harness/pi`) |
| T-0021-M12 | packages/harness/process/src/limit.ts | `flagValue` kept the first value of a repeated flag | `flagValue > takes the last occurrence of a repeated flag` |
| T-0021-M13 | packages/harness/process/src/limit.ts | `CONCURRENCY_SETTING` dropped `minimum: 1` from its counts | `the concurrency setting > zero, a string, a fraction or a non-object refuse the plugin at load, naming the field` |
| TK0009-M14 | `packages/harness/process/src/process.ts` | the sentinel did not watch its host while the harness ran | `the harness process > a harness still running when its host dies is stopped with its sentinel` |
| T-0025-M7 | `packages/harness/process/src/ask-note.ts` | the paragraph's fixed text changed | `the paragraph is fixed and names the question and the answer` |
| T-0025-M15 | `packages/harness/process/src/ask-note.ts` | newlines in the prompt and the choice were kept | `newlines in the prompt and the choice cannot end the paragraph` |

## T-0040 — the host's side of a one-time permission

| id | file | mutation | failing test |
|---|---|---|---|
| T-0040-M13 | packages/harness/process/src/grants.ts | the `grant_ack` always said `used: true` | `answerGrant > replies used false when the host did not use it` |
| T-0040-M14 | packages/harness/process/src/grants.ts | a host that throws counted as a grant used | `answerGrant > replies used false when the host throws` |
| T-0040-M15 | packages/harness/process/src/grants.ts | `hasGrants` was true for an empty grants list | `hasGrants > is true only for a profile with at least one grant` |
| T-0040-M16 | packages/harness/process/src/grants.ts | a `grant_use` line without a `waitId` was accepted | `grantUse > reads a grant_use line and nothing else` |

## T-0099 — a message to a running agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M1 | packages/harness/process/src/process.ts | a message was written to stdin as bare text, not a `message` line | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |
| T-0099-M2 | packages/harness/process/src/process.ts | the inbox listener was not dropped when the run ended | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |

## T-0099 — rework 1: the run reports its wall time

| id | file | mutation | failing test |
|---|---|---|---|
| T-0099-M3 | packages/harness/process/src/process.ts | the run did not tell the inbox its wall time when it began | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |
| T-0187-M3 | packages/harness/process/src/ask-call.ts | a timeout rejection was read as an allow | `createCallAsker > reject_once and a timeout rejection answer deny` |
| T-0187-M4 | packages/harness/process/src/ask-call.ts | questions were asked at once instead of one at a time | `createCallAsker > questions are asked one at a time` |
| T-0187-M6 | packages/harness/process/src/ask-call.ts | the question carried no grant under `resume` | `harness-claude: a call that must ask a person > answered later: the session resumes with the one-time permission, and any other call asks again` |
| T-0187-M11 | packages/harness/process/src/ask-call.ts | the degraded question did not reject once after the grace | `harness-radian: a question is reject_once > a grace that passes is a refusal: the step goes on with rejected true and never ends waiting` |

## T-0205 — the sentinel's host check works under dash

| id | file | mutation | failing test |
|---|---|---|---|
| T-0205-M1 | packages/harness/process/src/process.ts | the sentinel killed its group with `kill -KILL -- "-$$"`, which dash rejects, so a harness whose host died stayed running | `the harness process > a harness still running when its host dies is stopped with its sentinel` (Linux) |
| T-0188-M15 | packages/harness/process/src/ask-call.ts | a read-only profile did not open the question channel | `canAsk > is true only for a profile with an askCommands rule` |

## T-0297 — follow-ups from the flaky-test work

| id | file | mutation | failing test |
|---|---|---|---|
| T-0297-M1 | packages/harness/process/test/support.ts | `pidValue` accepted 0 and 1 as pids | `test support > a pid must be a finite integer above 1` |
| T-0335-M2 | packages/harness/process/src/ask-call.ts | a refusal's note was dropped, so the program got the generic reason | `createCallAsker > a refusal's note is the reason the program gets` |
| T-0327-M10 | packages/harness/process/src/ask-call.ts | `canAsk` ignored `allowMcp`, so a bot's unlisted MCP tool could not ask a person | `canAsk > is true for a profile that puts MCP tools under it, even with none listed` |
| T-0339-M20 | packages/harness/process/src/images.ts | `parseImageInputs` took any media type | `parseInput refuses an image that is not a path with an image media type` (claude) |

## T-0358 — agent lines, the fold and the receiver

| id | file | mutation | failing test |
|---|---|---|---|
| T-0358-M1 | packages/harness/process/src/jsonl-log.ts | the flush timer waited twice FLUSH_MS | `jsonl log flush timing > a line is written when its 250 ms are up, without more lines` |
| T-0358-M2 | packages/harness/process/src/jsonl-log.ts | a flush did not cancel the pending timer | `jsonl log flush timing > a full buffer and end cancel the timer` |
| T-0358-M3 | packages/harness/process/src/fold-lines.ts | a call with a `blocked` line settled as `failed` | `foldLines > a blocked call is blocked, with the reason as its error` |
| T-0358-M4 | packages/harness/process/src/fold-lines.ts | a text increment replaced the text so far instead of adding to it | `foldLines > increments add up to the finished text, and a finished message wins over the increments` |
| T-0358-M5 | packages/harness/process/src/fold-lines.ts | `message_end` text was added even when the message's text had come as lines | `foldLines > today's message_end text is an entry only when no text came before it` |
| T-0358-M6 | packages/harness/process/src/fold-lines.ts | a call that ended stayed in the unfinished calls | `foldLines > a tool call with an end is an entry with its facts` |
| T-0358-M7 | packages/harness/process/src/lines.ts | `capToolOutput` never cut | `capToolOutput > keeps short text and cuts long text at the cap without splitting a character` |
| T-0358-M8 | packages/harness/process/src/lines.ts | a receiver that threw stopped the step | `claude/agent > a receiver that throws does not stop the step` |
| T-0358-M13 | packages/harness/process/src/lines.ts | `capToolOutput` dropped a trailing U+FFFD even when it was a real character | `capToolOutput at the cap > a valid U+FFFD that ends exactly at the cap is kept` |
| T-0358-M14 | packages/harness/process/src/lines.ts | `deliverLine` handed the line over without masking secrets | `maskSecrets > masks a value as written, and as JSON text writes it` (unit) and the three `a receiver gets a line ... masked` step tests |

## T-0366 — allow_always and its user layer

| id | file | mutation | failing test |
|---|---|---|---|
| T-0366-M2 | packages/harness/process/src/ask-call.ts | a question that offered `allow_always` did not let either approving answer give the late permission | `askRequest > allowAlways offers allow_always and lets either approving answer give the late permission` |
| T-0366-M3 | packages/harness/process/src/ask-call.ts | `allow_always` allowed the call but did not write the user layer | `createCallAsker > allow_always answers allow and writes the exact call to the user layer` |
| T-0366-M4 | packages/harness/process/src/always-allow.ts | an invalid user layer was read as empty without its readable problem | `readAlwaysAllow > an invalid file is empty with a readable message naming the file` |
| T-0366-M5 | packages/harness/process/src/always-allow.ts | `personStarted` took every trigger for a person's message, so a background run consulted the user layer | `pi: a call that must ask a person > a background run ignores the user layer and is not offered allow_always` |
| T-0366-M10 | packages/harness/process/src/ask-call.ts | a later identical call ignored the entry `allow_always` had just written and asked again | `createCallAsker > a later identical call after allow_always is let through without asking again` |

## T-0362 — a long tool output in lines that join back whole

| id | file | mutation | failing test |
|---|---|---|---|
| T-0362-M15 | packages/harness/process/src/lines.ts | `toolOutputLines` cut a long output to its first line instead of splitting it | `toolOutputLines > a long output is split at the cap, joins back whole and masks secrets first` |
| T-0378-M5 | packages/harness/process/src/acp.ts | the updates `session/load` replays were handed over as the prompt's | `codex/agent: resume > a resumed run loads the session instead of opening one, and what it replays is not this run's` |
| T-0378-M8 | packages/harness/process/src/acp.ts | an allowed call was answered with the `allow_always` option | `codex/agent: permissions > without a rule the call is allowed once, never always` |
| T-0378-M15 | packages/harness/process/src/acp.ts | a new session's id was read only on a resume | `AcpClient > initialize, session/new, the settings, then the prompt, in that order` |

## T-0497 — skills the step gives

| id | file | mutation | failing test |
|---|---|---|---|
| T-0497-M2 | packages/harness/process/src/skills.ts | a SKILL.md with no name was given a fallback name instead of being skipped | `readGivenSkills > skips an unreadable SKILL.md, a missing name and an unsafe name, with a reason each` |

## T-0486 — the time of each log line and the step's durations

| id | file | mutation | failing test |
|---|---|---|---|
| T-0486-M1 | packages/harness/process/src/jsonl-log.ts | `stamp` returned the line unchanged, so no log line carried the host's receipt time | `jsonl log > every JSON line carries the time the host received it` |
| T-0486-M2 | packages/harness/process/src/timings.ts | the `session` line was read but did not mark the ready time | `StepTimings > it measures the step to the session line, from there to the first increment, and in all` |
## T-0498 — skills in the prompt for a harness that cannot load them

| id | file | mutation | failing test |
|---|---|---|---|
| T-0498-M1 | packages/harness/process/src/skills.ts | `promptWithSkills` ignored `loadsSkills` and gave a capable harness the list | `promptWithSkills > a harness that loads skills itself gets no list` |
| T-0498-M2 | packages/harness/process/src/skills.ts | the skill list was not cut at `MAX_PROMPT_SKILLS` | `promptWithSkills > the list stops at the skill cap and says how many are left out` |
| T-0498-M3 | packages/harness/process/src/skills.ts | a long description was listed whole instead of cut at `MAX_PROMPT_DESCRIPTION_CHARS` | `promptWithSkills > a long description is cut at the description cap` |

## T-0504 — the first increment rule

| id | file | mutation | failing test |
|---|---|---|---|
| T-0504-M1 | packages/harness/process/src/timings.ts | `INCREMENT_LINES` omitted `text_end`, so it could not be the first increment | `StepTimings first increment > each kind of increment can be the first one` |
| T-0504-M2 | packages/harness/process/src/timings.ts | a `message_end` with no text counted as the first increment | `StepTimings first increment > a message_end with no text is not an increment, and a later one is` |
| T-0504-M3 | packages/harness/process/src/timings.ts | a first increment before the session gave a negative wait instead of null | `StepTimings first increment > an increment before the session leaves the wait to the first increment absent` |

## T-0505 — skills follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0505-M2 | packages/harness/process/src/skills.ts | a quoted description was cut at a ` #` inside the quotes, like a comment | `skillDescription > a quoted description keeps a # inside it, and an unquoted one ends at a comment` |
| T-0505-M3 | packages/harness/process/src/skills.ts | a literal block scalar folded its lines like a folded one | `skillDescription > reads literal and folded block scalars, chomping and a comment after the indicator` |

## T-0506 — an inbox listener says whether it took the message

| id | file | mutation | failing test |
|---|---|---|---|
| T-0506-M1 | packages/harness/process/src/process.ts | the inbox listener wrote a message but reported no result, so the host could not tell it was taken | `runAgent with an inbox > a message sent while the command runs is written to its stdin as a message line, and the listener is dropped at the end` |

## T-0515 — a chat's worker is kept between replies

| id | file | mutation | failing test |
|---|---|---|---|
| T-0515-M1 | packages/harness/process/src/process.ts | a kept worker that matched was never tried, so every reply started a new process | `a second message is answered by the same kept process` |
| T-0515-M3 | packages/harness/process/src/process.ts | the fourth kept worker was allowed, because the cap check only ended one above the limit | `the fourth worker ends the one that has been idle longest` |

## T-0516 — a chat's claude worker is kept

| id | file | mutation | failing test |
|---|---|---|---|
| T-0516-M1 | packages/harness/process/src/keep.ts | the kept worker's idle timer no longer ended the process | `the kept worker ends itself after the kept time` |
| T-0516-M2 | packages/harness/process/src/keep.ts | the adapter was not closed when the kept worker ended, so the skill plugin stayed | `the skill plugin lives as long as the kept worker and is removed when it ends` |
| T-0516-M4 | packages/harness/process/src/keep.ts | a kept worker whose session ended was not told to leave, so it stayed after its `claude` was killed | `a kept bun worker and its claude end together, whichever is killed` |
| T-0516-M8 | packages/harness/process/src/process.ts | the cap counted only workers of the same harness, so pi and claude could keep four in one home | `the limit of three is shared by pi and claude workers in one home` |
| T-0516-M9 | packages/harness/process/src/keep.ts | `useGrant` was passed unbound, so the host's `useGrant` threw and every granted call was refused | `a kept worker receives this reply's grant, not the previous reply's` |

## T-0520 — a kept record is readable before its reply returns

| id | file | mutation | failing test |
|---|---|---|---|
| T-0520-M1 | packages/harness/process/src/process.ts | `keptRecordAppears` waited for the record path to exist instead of for the path to read as a record | `a kept record that is still empty is not ready, so the reply waits for the whole record` |
## T-0521 — a leading slash in a message is text

| id | file | mutation | failing test |
|---|---|---|---|
| T-0521-M1 | packages/harness/process/src/step.ts | a done result dropped the reason the worker gave for answering with nothing | `resultFor > a done result keeps the reason the worker gave for answering with nothing` |

## T-0525 — chat access levels

| id | file | mutation | failing test |
|---|---|---|---|
| T-0525-M10 | packages/harness/process/src/ask-call.ts | an access level below `full` no longer made the run able to ask | `canAsk > is true for an access level below full, and false for full` |

## T-0529 — a chat shows how full the context is

| id | file | mutation | failing test |
|---|---|---|---|
| T-0529-M11 | packages/harness/process/src/step.ts | an agent step's data dropped the context the worker reported | `codex/agent: a prompt run > the usage has the token counts and an unknown cost, never 0` |

## T-0533 — outward questions
| id | file | mutation | failing test |
|---|---|---|---|
| T-0533-M4 | packages/harness/process/src/ask-call.ts | an outward ask_call was turned into the ordinary run-this-command question | `askRequest > an outward question offers send once and reject, and a late answer sends once` |

## T-0534 — the target grant on a harness outward question

| id | file | mutation | failing test |
|---|---|---|---|
| T-0534-M1 | packages/harness/process/src/ask-call.ts | an outward question with a flow did not offer the target grant | `askRequest > an outward question with a flow offers the target grant, and either approving answer sends once` |
| T-0534-M2 | packages/harness/process/src/ask-call.ts | a late target answer did not write its grant | `createCallAsker > a late target answer records the grant with the person who answered` |

## T-0565 — a text entry keeps the time its log line carried

| id | file | mutation | failing test |
|---|---|---|---|
| T-0565-M1 | packages/harness/process/src/fold-lines.ts | `receivedAtOf` ignored the log line's received time, so a finished text entry carried none | `foldLines > a line's receivedAt gives a finished text its time, and old logs still read` |

## T-0569 — a form line between a program and its host

| id | file | mutation | failing test |
|---|---|---|---|
| T-0569-M5 | packages/harness/process/src/question-form.ts | `answerText` dropped the person's own words, so only a picked label reached the harness | `the answer to one question is its labels and free text` |
| T-0569-M6 | packages/harness/process/src/ask-note.ts | `askNote` grew no form paragraph, so a late answer reached the agent as one text | `a form's paragraph names each question and its answer, and marks a skipped one` |
| T-0569-M12 | packages/harness/process/src/question-form.ts | `askQuestions` kept a harness's long question text, which the kernel refuses, so one long description would end the reply instead of being cut | `a harness's long text is cut to the kernel's bounds, not refused` |

## T-0573 — a plan review's note and a kept worker's form

| id | file | mutation | failing test |
|---|---|---|---|
| T-0573-M1 | packages/harness/process/src/ask-call.ts | the form answer's `note` was left out of `ask_form_ack`, so the person's reason for changes was lost | `a form's note > the person's note for the whole form goes back in the form's answer` |
| T-0573-M2 | packages/harness/process/src/keep.ts | `Capture` did not pass `askForm` to the kept reply, so a plan review after the first reply never reached the person | `a plan review in a kept worker's second reply still reaches the person` |
## T-0574 — a retry is a live transcript item

| id | file | mutation | failing test |
|---|---|---|---|
| T-0574-M1 | packages/harness/process/src/fold-lines.ts | `retry_start` was folded without keeping the retry | `foldLines > a retry carries its attempt, delay and reason until it ends` |
| T-0574-M2 | packages/harness/process/src/fold-lines.ts | `retry_end` left the retry in the live state | `foldLines > a retry carries its attempt, delay and reason until it ends` |
| T-0574-M3 | packages/harness/process/src/fold-lines.ts | a successful `message_end` left the retry in the live state | `foldLines > a successful message clears the retry even before its end line` |

## T-0632 — an increment holds back an escaped secret prefix

| id | file | mutation | failing test |
|---|---|---|---|
| T-0632-M1 | packages/harness/process/src/lines.ts | `splitSecretPrefix` checked only the raw secret value, not its JSON-escaped spelling | `a JSON-escaped secret split across grouped increments is not exposed by joining the deltas` |
| T-0632-M3 | packages/harness/process/src/lines.ts | `Increments` ignored `firstImmediately`, so claude wrote its first increment at once instead of grouping it | `increments are grouped to one line per 100 ms for text and for thinking` |
## T-0620 — a cached, shared probe

| id | file | mutation | failing test |
|---|---|---|---|
| T-0620-M1 | packages/harness/process/src/probe-cache.ts | the in-flight probe was not shared, so concurrent callers each started one | `a cached probe > concurrent callers of one key share one probe` |
| T-0620-M2 | packages/harness/process/src/probe-cache.ts | a fresh answer was not reused, so every caller ran its probe again | `a cached probe > keeps an answer for its time, and asks again after it` |

## T-0642 — process tests for the shared lines helpers

| id | file | mutation | failing test |
|---|---|---|---|
| T-0642-M1 | packages/harness/process/src/lines.ts | `splitSecretPrefix` checked only the raw secret value, not its JSON-escaped spelling | `lines > splitSecretPrefix holds back an escaped secret split across grouped increments` |
| T-0642-M2 | packages/harness/process/src/lines.ts | `Increments` ignored `firstImmediately`, so claude wrote its first increment at once instead of grouping it | `lines > Increments groups its first text and thinking when firstImmediately is false` |

## T-0627 — the shared step of the harness plugins

| id | file | mutation | failing test |
|---|---|---|---|
| T-0627-M1 | packages/harness/process/src/process.ts | `watchRun` never started the wall timer, so a kept run outlived its wall time | `watchRun > the wall timer stops the run once` |
| T-0627-M2 | packages/harness/process/src/process.ts | `trimKept` always trimmed above the cap, so the pre-start path left one worker too many | `trimKept > before a worker starts the cap trims at it, oldest first` |
| T-0627-M3 | packages/harness/process/src/refusal.ts | the early refusal dropped the harness's extra data, so codex's `imageGenCalls` was missing | `the early refusal > names the reason and the field, with the data every harness writes` |
| T-0627-M4 | packages/harness/process/src/version.ts | the strict comparison returned 0 instead of ordering the semver parts, so a prerelease equalled its release | `compareVersions > the strict form orders prereleases and refuses a version it cannot read` |

## T-0654 — a worker's retry-after reaches the step result

| id | file | mutation | failing test |
|---|---|---|---|
| T-0654-M1 | packages/harness/process/src/step.ts | a worker's `modelError.retry_after_secs` was always written as `null` | `resultFor > a model error keeps the retry after the worker reported` |

## T-0656 — a model's message carries its wait and report time

| id | file | mutation | failing test |
|---|---|---|---|
| T-0656-M1 | packages/harness/process/src/step.ts | `modelErrorOf` threw away the retry-after or reset wait the message named | `modelErrorOf > a retry-after or reset the text names is the wait` |
| T-0656-M2 | packages/harness/process/src/step.ts | `resultFor` dropped the worker's `reported_at` from a model error that carries a wait | `resultFor > a model error keeps the retry after the worker reported` |
## T-0655 — follow-ups the scan reviews found

| id | file | mutation | failing test |
|---|---|---|---|
| T-0655-M3 | packages/harness/process/src/worker-entry.ts | `runWorkerMain` left a closed stdout unhandled, so the worker wrote an EPIPE to stderr after its host closed the pipe | `a worker entry survives a host that closes stdout` |

## T-0670 — full access asks nothing

| id | file | mutation | failing test |
|---|---|---|---|
| T-0670-M6 | packages/harness/process/src/ask-call.ts | `canAsk` still reported an ask at `full` | `canAsk > is true for an access level below full, and false for full` |

## T-0709 — an over-long line is skipped, not a failure

| id | file | mutation | failing test |
|---|---|---|---|
| T-0709-M1 | packages/harness/process/src/process.ts | a complete line past the limit was handed to `onLine` instead of dropped | `an over-long output line > is dropped, reported with its length, and the lines around it are read` |
| T-0709-M2 | packages/harness/process/src/process.ts | the length reported for a dropped line left out the part read in earlier chunks | `an over-long output line > is dropped, reported with its length, and the lines around it are read` |
| T-0709-M3 | packages/harness/process/src/process.ts | a line that never ends was never stopped (no cap while skipping) | `an over-long output line > that never ends stops the run as a line too long` (timed out) |

## T-0766 — pi compacts a long chat

| id | file | mutation | failing test |
|---|---|---|---|
| T-0766-M7 | packages/harness/process/src/keep.ts | the kept-worker key included `compact`, so a `/compact` run missed the chat's kept worker | `what a reply asks for in compact does not change which kept worker serves it` |
| T-0766-M14 | packages/harness/process/src/step.ts | the result data dropped the worker's compaction note | `a worker's compaction becomes the result's compacted flag and compaction note` |
