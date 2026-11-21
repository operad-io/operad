# Mutation records — `chat`

Rows whose mutation broke code in `packages/chat/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0188-M1 | packages/chat/src/reply.ts | did not record the reply as a fact | `chat/reply > a rerun after the reply was recorded does not answer twice` |
| T-0188-M2 | packages/chat/src/reply.ts | never went round again when messages arrived meanwhile | `chat/reply > a message that arrives during a reply is answered in the next round, on the same session` |
| T-0188-M3 | packages/chat/src/index.ts | let the loop run five rounds past the cap | `the reply flow > maxVisits stops a loop that never catches up` |
| T-0188-M4 | packages/chat/src/index.ts | chat:send did not send the event | `chat:send > records the message as a fact and sends the event the rule answers` |
| T-0188-M5 | packages/chat/src/views.ts | the transcript gave no cursor for its next page | `the chat's views > the transcript pages over the message facts, in order` |
| T-0188-M6 | packages/chat/src/reply.ts | a yes to the worktree question let the write through as a one-time permission | `a read-only chat > a question about writing a file becomes the worktree question and never a one-time permission` |
| T-0188-M17 | packages/chat/src/reply.ts | a command with an output redirect was not taken for a write question, so allow_once could write in the main clone | `a read-only chat > a command that redirects output into a file is the worktree question too` |
| T-0188-M24 | packages/chat/src/reply.ts | a command question in a read-only chat was not turned into the worktree question | `a read-only chat > a command that redirects output into a file is the worktree question too` |
| T-0303-M2 | packages/chat/src/views.ts | the transcript did not use the chat plugin's `speaker` setting | `the chat's views > the chat plugin's speaker setting labels a repo chat` |
| T-0303-M3 | packages/chat/src/views.ts | the transcript did not use the speaker its chat's bot names | `the chat's views > a bot's own speaker labels its chats, and a changed name shows on old messages` |
| T-0303-M4 | packages/chat/src/views.ts | the transcript used the registry's startup speaker and the bot object stored by the first prepare, not the settings in force now | `the chat's views > the chat plugin's speaker setting is read again at every draw` |
| T-0312-M1 | packages/chat/src/index.ts | `chat:close` did not record the `chat.closed` fact | `chat:close > records a closed fact, makes the row closed, and keeps the transcript readable` |
| T-0334-M1 | packages/chat/src/index.ts | a message from a client the chat does not know fell back to cli again | `chat:send > a client this plugin does not know is recorded as it is, never as cli, and is still answered` |

## T-0329 — a chat created with a first message

| id | file | mutation | failing test |
|---|---|---|---|
| T-0329-M1 | packages/chat/src/index.ts | `sendMessage` no longer appended the message fact, so `dev:chat` with a first message created the chat and sent nothing | `dev:chat with a first message > creates the chat and sends the message, so the reply starts, and opens the chat` |
| T-0335-M1 | packages/chat/src/reply.ts | the worktree question left the call out and asked only about changing code | `a read-only chat > a command that redirects output into a file is named in the worktree question too` |
| T-0335-M3 | packages/chat/src/reply.ts | the worktree question dropped a no-session call's reject-on-timeout, so the live agent waited instead of going on | `a read-only chat > a call with no session to continue is named from its own words and still refuses once` |
| T-0339-M10 | packages/chat/src/index.ts | the message fact recorded no attachments | `chat:send with attachments > the message fact records each path with its name, type and size` |
| T-0339-M11 | packages/chat/src/views.ts | the transcript showed an image as a link | `chat:send with attachments > the transcript shows an image as an image and another file as a link, each with its name` |
| T-0339-M12 | packages/chat/src/reply.ts | the reply gave no image input to the harness | `chat/reply with attachments > an image reaches the claude harness as image input, and as a path in the prompt` |
| T-0339-M13 | packages/chat/src/reply.ts | the profile opened the parent of the chat's attachment directory too | `chat/reply with attachments > the access profile gains read access to the chat's attachment directory and nothing more` |
| T-0339-M14 | packages/chat/src/reply.ts | an image outside the chat's attachment directory was given as input | `chat/reply with attachments > a path outside the chat's attachment directory is never given as an image` |
| T-0339-M15 | packages/chat/src/model.ts | the prompt left the attached files' paths out | `chat/reply with attachments > a harness that takes no images gets the image as a path only` |
| T-0339-M16 | packages/chat/src/reply.ts | a harness that takes no image was given image input | `chat/reply with attachments > a harness that takes no images gets the image as a path only` |
| T-0339-M17 | packages/chat/src/index.ts | a message with neither text nor a file was accepted | `chat:send with attachments > a message may be only a file, but never nothing` |
| T-0339-M24 | packages/chat/src/model.ts | `attachmentOf` guessed the type from the extension, ignoring the upload's | `an upload's own type > a file with no extension keeps the type its upload gave, so it is an image to the agent` |
| T-0339-M25 | packages/chat/src/views.ts | the transcript linked the server-local path instead of the attachment address | `chat:send with attachments > the transcript shows an image as an image and another file as a link, each with its name` |
| T-0339-M27 | packages/chat/src/index.ts | the note kept `minLength: 1`, so an empty note beside an attachment was refused by the schema | `chat:send with attachments > an empty note beside an attachment is an attachment-only message; an empty note alone is refused` |

## T-0337 — the chat row says the agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0337-M1 | packages/chat/src/model.ts | the row note dropped the agent | `the chat row says the agent > a chat with no reply yet shows the agent alone` |

## T-0338 — a chat's model

| id | file | mutation | failing test |
|---|---|---|---|
| T-0338-M1 | packages/chat/src/reply.ts | the reply no longer passed the chat's model to the harness, so a model change was ignored by the next reply | `chat:model > the next reply uses the changed model, and the history says who changed it and to what` |
| T-0338-M2 | packages/chat/src/index.ts | `chat:model` dropped the enum of the agent's models from its argument | `chat:model > the argument is an enum of the agent's models` |


## T-0342 — a chat's effort

| id | file | mutation | failing test |
|---|---|---|---|
| T-0342-M10 | packages/chat/src/index.ts | `chat:effort` dropped the enum of the agent's efforts from its argument | `chat:effort > the argument is an enum of the agent's efforts` |
| T-0342-M11 | packages/chat/src/index.ts | `chat:effort` changed the object without appending its fact | `chat:effort > the next reply uses the changed effort, and the history says who changed it and to what` |
| T-0342-M12 | packages/chat/src/index.ts | `chat:effort` appended its fact but did not save the effort | `chat:effort > the next reply uses the changed effort, and the history says who changed it and to what` |
| T-0342-M13 | packages/chat/src/reply.ts | the reply stopped passing the chat's effort to the harness | `chat:effort > the next reply uses the changed effort, and the history says who changed it and to what` |
| T-0342-M14 | packages/chat/src/reply.ts | the reply no longer refused an effort its agent does not list | `the reply and the effort > a level the agent cannot take fails the reply naming it, and the agent is never called` |
| T-0342-M15 | packages/chat/src/index.ts | `chat:effort` was offered on a closed chat | `chat:effort > a closed chat does not offer it` |
| T-0342-M16 | packages/chat/src/model.ts | the row note left a chosen effort out | `chat:effort > the row leaves the default effort out and shows a choice` |
| T-0342-M17 | packages/chat/src/model.ts | `startingEffort` accepted a level the agent does not list | `startingEffort > asked, else preferred, else the default; an unlisted one is refused` |
| T-0342-M18 | packages/chat/src/model.ts | `createChat` dropped the effort it was given | `chat:effort > the next reply uses the changed effort, and the history says who changed it and to what` |

## T-0362 — what the agent did, in the transcript

| id | file | mutation | failing test |
|---|---|---|---|
| T-0362-M1 | packages/chat/src/reply.ts | the receiver folded no line, so the run recorded no entries | `chat entries > a run records its text, thinking and tool calls with its run id, and leaves the final reply as the message` |
| T-0362-M2 | packages/chat/src/reply.ts | text and thinking entries were written without the run id | `chat entries > a run records its text, thinking and tool calls with its run id, and leaves the final reply as the message` |
| T-0362-M3 | packages/chat/src/reply.ts | the output cap was 64 KB instead of 4 KB, so a 4 KB output stayed in the fact | `chat entries > tool output longer than 4 KB keeps its head in the fact and the whole output in a file under the chat` |
| T-0362-M4 | packages/chat/src/reply.ts | the chat's secret values were not read, so no text, output or file was masked | `chat entries > secret values are masked before a text, thinking, tool or file fact is written` |
| T-0362-M5 | packages/chat/src/reply.ts | an already recorded tool call id was recorded again on a rerun | `chat entries > a step that runs again does not record the same entries twice` |
| T-0362-M6 | packages/chat/src/reply.ts | an interrupted run returned without recording its half-written reply | `chat entries > a stopped run keeps its half-written reply` |
| T-0362-M7 | packages/chat/src/views.ts | the transcript skipped the entry facts | `chat entries > the transcript shows done, failed, blocked and denied tool calls, and thinking as an unlabeled quote` |
| T-0362-M8 | packages/chat/src/reply.ts | the final reply's text was also recorded as an intermediate text entry | `chat entries > a run records its text, thinking and tool calls with its run id, and leaves the final reply as the message` |
| T-0362-M9 | packages/chat/src/views.ts | every fact was its own page item, so a page split a turn's entries from its reply | `chat entries > a page counts messages and keeps a turn's entries with its reply` |
| T-0362-M10 | packages/chat/src/views.ts | a radian chat showed its text and thinking entries | `chat entries > a radian chat shows the tool lines only` |
| T-0362-M11 | packages/chat/src/views.ts | a tool line showed the call's output | `chat entries > the transcript shows done, failed, blocked and denied tool calls, and thinking as an unlabeled quote` |
| T-0362-M12 | packages/chat/src/views.ts | thinking was shown with a label in front of it | `chat entries > the transcript shows done, failed, blocked and denied tool calls, and thinking as an unlabeled quote` |
| T-0362-M13 | packages/chat/src/reply.ts | text and thinking increments with no end were stored as entries | `chat entries > increments with no end are not stored as entries` |
## T-0366 — allow_always

| id | file | mutation | failing test |
|---|---|---|---|
| T-0366-M9 | packages/chat/src/index.ts | the question wait no longer offered `allow_always` | `the reply flow > the question wait offers allow_always and sends either allow answer back to the reply` |
| T-0366-M13 | packages/chat/src/index.ts | the question wait stopped declaring `allow_always` as the late choice a person's question hands over | `the reply flow > the question wait offers allow_always and sends either allow answer back to the reply` |

## T-0362 — rework: the final text after masking

| id | file | mutation | failing test |
|---|---|---|---|
| T-0362-M14 | packages/chat/src/reply.ts | the final text was compared with the entry before masking it, so a secret-bearing reply stayed as an entry too | `chat entries > secret values are masked before a text, thinking, tool or file fact is written` |

## T-0363 — the transcript's after, mark and tail

| id | file | mutation | failing test |
|---|---|---|---|
| T-0363-M1 | packages/chat/src/views.ts | `after` was ignored, so every read gave the whole page | `chat transcript: after, mark and tail > a read with after returns only what was recorded later, and says so` |
| T-0363-M2 | packages/chat/src/views.ts | a read with `after` gave the mark back unchanged | `chat transcript: after, mark and tail > the mark moves with what was recorded and holds when nothing was` |
| T-0363-M3 | packages/chat/src/views.ts | the thinking being written was left out of the tail | `chat transcript: after, mark and tail > thinking being written is a block quote with no label` |
| T-0363-M4 | packages/chat/src/views.ts | the text being written was left out of the tail | `chat transcript: after, mark and tail > text being written is in the tail and not in the markdown` |
| T-0363-M5 | packages/chat/src/views.ts | the running tool calls were left out of the tail | `chat transcript: after, mark and tail > a tool call that started and did not end is one line with its start` |
| T-0363-M6 | packages/chat/src/views.ts | the tail was read whether or not the run still runs | `chat transcript: after, mark and tail > there is no tail when nothing runs, and none without a log` |
| T-0363-M7 | packages/chat/src/views.ts | text the facts already hold was repeated in the tail | `chat transcript: after, mark and tail > a finished entry is never in both the markdown and the tail` |
| T-0363-M8 | packages/chat/src/views.ts | a tool call the facts already hold as finished was repeated in the tail | `chat transcript: after, mark and tail > a finished entry is never in both the markdown and the tail` |
| T-0363-M9 | packages/chat/src/views.ts | a radian chat's tail showed text and thinking | `chat transcript: after, mark and tail > a radian chat's tail has the tool lines only` |
| T-0363-M10 | packages/chat/src/views.ts | the tail was not masked | `chat transcript: after, mark and tail > a secret is masked in the tail` |
| T-0363-M11 | packages/chat/src/tail.ts | the whole log was read, not its end | `chat transcript: after, mark and tail > reading the tail of a log of 50 000 lines reads a bounded number of bytes` |
| T-0363-M12 | packages/chat/src/reply.ts | the reply step did not record its run, so no log was found | `chat transcript: after, mark and tail > text being written is in the tail and not in the markdown` |
## T-0369 — the new-chat form narrows model and effort by agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0369-M1 | packages/chat/src/model.ts | a configured model was the default of every agent, not only the one that lists it | `bot:chat per-agent conditionals > one if/then per agent carries its lists and defaults; a bot's model is the default only of the agent that lists it` |
| T-0369-M2 | packages/chat/src/model.ts | an agent that lists nothing still got a `model`/`effort` in its `then` | `bot:chat per-agent conditionals > one if/then per agent carries its lists and defaults; a bot's model is the default only of the agent that lists it` |

## T-0363 — rework 1: a window that starts inside unfinished content

| id | file | mutation | failing test |
|---|---|---|---|
| T-0363-M13 | packages/chat/src/tail.ts | a window was never widened, so text or thinking that began before it lost its start | `chat transcript: after, mark and tail > a text, thinking or tool call that began before the window is still whole` |
| T-0363-M14 | packages/chat/src/tail.ts | output of a call with no start or end in the window did not widen it, so the running call was dropped | `chat transcript: after, mark and tail > a text, thinking or tool call that began before the window is still whole` |

## T-0363 — rework 3: a quiet point instead of a shape check

| id | file | mutation | failing test |
|---|---|---|---|
| T-0363-M15 | packages/chat/src/tail.ts | the earlier acceptance rule came back (a reset line and no unpaired output), so a silent call whose start is before the window was dropped | `chat transcript: after, mark and tail > a silent call stays in the tail while a parallel call fills the window` |

## T-0363 — rework 4: no quiet point in a log without message ends

| id | file | mutation | failing test |
|---|---|---|---|
| T-0363-M16 | packages/chat/src/tail.ts | in a log with no text, thinking or message end, a finished call was taken as the quiet point | `chat transcript: after, mark and tail > in a log with no message ends a finished call does not hide a running one` |

## T-0363 — rework 6: the log is folded incrementally

The window rule (M11 to M16 above) was replaced by a fold that keeps its state and byte offset per log and reads only what was appended; M11, M13, M14, M15 and M16 no longer apply to the code. The bounded-read test keeps its name and now checks the appended bytes.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0363-M17 | packages/chat/src/tail.ts | every read started again from byte 0 | `chat transcript: after, mark and tail > reading the tail of a log of 50 000 lines reads a bounded number of bytes` |
| T-0363-M18 | packages/chat/src/tail.ts | a log shorter than the saved offset kept its old state | `chat transcript: after, mark and tail > a log that was cut short or replaced is read again from its start` |
| T-0363-M19 | packages/chat/src/tail.ts | the partial last line was counted as read, so its second half was lost | `chat transcript: after, mark and tail > a line split across two appends is folded once, whole` |

## T-0363 — rework 7: the partial last line is kept

| id | file | mutation | failing test |
|---|---|---|---|
| T-0363-M20 | packages/chat/src/tail.ts | the saved offset stopped after the last complete line, so a partial line was read again at every poll | `chat transcript: after, mark and tail > a large unfinished line is read once, not at every poll` |

## T-0485 — a failed reply is shown

| id | file | mutation | failing test |
|---|---|---|---|
| T-0485-M1 | packages/chat/src/reply.ts | `recordFailure` appended no entry, so a failed reply left no line | `a failed reply > leaves one line after the person's message, saying what failed and why` |
| T-0485-M2 | packages/chat/src/reply.ts | the failure line did not mask the provider's message with `secretValues` | `a failed reply > masks the provider's message before it enters the chat` |
| T-0485-M3 | packages/chat/src/reply.ts | `recordFailure` skipped no failure already after the last person's message, so a rerun added a second line | `a failed reply > does not gain a second line when the step runs again` |
| T-0485-M4 | packages/chat/src/views.ts | a radian chat hid the failure line with its text and thinking entries | `a failed reply > shows the failure line in a radian chat too` |
| T-0485-M5 | packages/chat/src/reply.ts | a long provider message was not cut, so the failure line could grow without limit | `a failed reply > cuts a long provider message to one line` |
| T-0485-M6 | packages/chat/src/reply.ts | the failure line kept the provider message's internal words (`harness`, `run`, `step`, `flow`, `fact`) | `a failed reply > uses the person's words for the internal names a provider's message carries` |

## T-0491 — chat commands as actions

| id | file | mutation | failing test |
|---|---|---|---|
| T-0491-M1 | packages/chat/src/index.ts | `chat:send` never parsed a command, so every slash line stayed a model message | `commands in chat:send > a known command runs its action, records no model message, and leaves one line` |
| T-0491-M2 | packages/chat/src/command.ts | the clash rule kept the short name for the other plugin instead of `chat` | `commands in chat:send > the chat plugin keeps a clashing short name and another plugin gets its own` |
| T-0491-M3 | packages/chat/src/command.ts | a bare command with `confirm` ran without the `yes` the action asks for | `commands in chat:send > a command that asks to confirm runs only with yes` |
| T-0491-M4 | packages/chat/src/views.ts | command facts were not rendered, so the transcript lost the line | `commands in chat:send > the transcript shows the command line and the outcome` |
| T-0491-M7 | packages/chat/src/command.ts | `chatCommands` kept actions that declared no command, so `/help` listed actions that are not commands | `commands in chat:send > /help lists exactly the commands this chat has` |
| T-0491-M8 | packages/chat/src/command.ts | `argsOf` let the last field take only its own word instead of the rest of the line | `commands in chat:send > more than one argument is positional and the last takes the rest of the line` |
| T-0491-M9 | packages/chat/src/command.ts | a refused or invalid argument was thrown instead of becoming a refusal line, so nothing was recorded | `commands in chat:send > a missing or wrong argument is refused in a line and changes nothing` |
| T-0491-M10 | packages/chat/src/command.ts | `findCommand` fell back to the first command, so an unknown `/xxx` ran an action instead of staying a message | `commands in chat:send > an unknown slash and a slash inside the text are ordinary messages` |
| T-0491-M11 | packages/chat/src/index.ts | a command also recorded a model message and sent its event while a reply was running | `commands in chat:send > a command runs at once while a reply is being written and starts no reply` |
## T-0486 — a reply keeps the step's durations

| id | file | mutation | failing test |
|---|---|---|---|
| T-0486-M6 | packages/chat/src/reply.ts | the reply fact did not keep the step's `timings` with its usage | `chat/reply > the reply fact keeps the step's three durations with the usage` |

## T-0487 — the reply text has no gap at the end

| id | file | mutation | failing test |
|---|---|---|---|
| T-0487-M1 | packages/chat/src/tail.ts | `foldLogTail` dropped finished entries again, so text and a finished call left the tail before their facts were visible | `chat transcript: after, mark and tail > the reply text stays in the tail until its fact is visible, then moves to the markdown` (also the finished tool call test) |
## T-0492 — stopping and retrying a chat reply

| id | file | mutation | failing test |
|---|---|---|---|
| T-0492-M1 | packages/chat/src/index.ts | `chat:stop` treated a run that had already ended as the running reply | `chat:stop and chat:retry > stop with no reply running says so and changes nothing` |
| T-0492-M2 | packages/chat/src/index.ts | `chat:retry` answered again after a normal reply instead of refusing | `chat:stop and chat:retry > retry refuses after a normal reply and starts nothing` |
| T-0492-M3 | packages/chat/src/model.ts | the last reply outcome read a failure entry as no reply outcome | `chat:stop and chat:retry > retry after a failure answers again on the same session, and keeps the failed attempt` |
| T-0492-M4 | packages/chat/src/views.ts | a stopped half reply was shown without the stopped mark | `chat:stop and chat:retry > stop during text keeps the half-written reply, marked stopped, and says what happens to later messages` |
| T-0492-M5 | packages/chat/src/index.ts | a retry right after a stop waited for the stopped entry instead of following the successful stop line | `chat:stop and chat:retry > retry after a stop answers again on the same session, keeps the stopped reply, and a rerun adds no entry` |
| T-0492-M6 | packages/chat/src/index.ts | `chat:stop` asked the run control to cancel a run id that was not the chat's latest | `chat:stop and chat:retry > stop during text keeps the half-written reply, marked stopped, and says what happens to later messages` |

| T-0485-M6 | packages/chat/src/reply.ts | the failure line kept the provider message's internal word `harness` instead of the person's `agent` | `a failed reply > uses the person's words for the internal names a provider's message carries` |

## T-0504 — a rerun's failure and the tail's kept entries

| id | file | mutation | failing test |
|---|---|---|---|
| T-0504-M1 | packages/chat/src/reply.ts | `recordFailure` compared the failure text again, so a rerun with another message added a second line | `a failed reply > does not gain a second line when the step runs again` |
| T-0504-M2 | packages/chat/src/reply.ts | `plainWords` rewrote `run` in "run out of quota" to `reply`, garbling the provider's message | `a failed reply > uses the person's words for the internal names a provider's message carries` |
| T-0504-M3 | packages/chat/src/tail.ts | `foldLogTail` kept a finished entry its facts already held, so a long run kept every entry | `chat transcript: after, mark and tail > a finished entry the facts already hold leaves the saved fold` |

## T-0493 — `/status`

| id | file | mutation | failing test |
|---|---|---|---|
| T-0493-M1 | packages/chat/src/index.ts | `chat:status` was not declared as an action, so `/status` stayed an ordinary message | `chat:status > shows each line: agent, model, effort, reply, waiting, session usage and the last reply` |
| T-0493-M2 | packages/chat/src/index.ts | an unknown cost was shown as `$0.00` instead of `unknown` | `chat:status > an unknown cost is said to be unknown, never shown as zero` |
| T-0493-M3 | packages/chat/src/model.ts | `writingReply` always returned undefined, so status said it was not writing | `chat:status > works while a reply is being written and says since when and how many wait` |
| T-0493-M4 | packages/chat/src/reply.ts | the chat did not keep the tokens its replies used, so the session's token usage was unknown | `chat:status > shows each line: agent, model, effort, reply, waiting, session usage and the last reply` |
| T-0493-M5 | packages/chat/src/model.ts | the last reply's stored timings were not turned into a time to first output | `chat:status > shows each line: agent, model, effort, reply, waiting, session usage and the last reply` |

## T-0496 — a message during a reply is interjected

| id | file | mutation | failing test |
|---|---|---|---|
| T-0496-M1 | packages/chat/src/reply.ts | the reply tested the mid-run capability backwards, so it passed no inbox | `a message that arrives while a chat reply is being written > during text it is delivered once, marked answered by that reply and not answered again`, `a message that arrives while a chat reply is being written > during a tool call it is delivered once, after the call, and not answered again` |
| T-0496-M2 | packages/chat/src/reply.ts | the reply did not name the messages it took mid-run in `replyTo`, so a next round answered them again | `a message that arrives while a chat reply is being written > during text it is delivered once, marked answered by that reply and not answered again`, `a message that arrives while a chat reply is being written > during a tool call it is delivered once, after the call, and not answered again` |
| T-0496-M3 | packages/chat/src/reply.ts | the inbox counted a message as taken before the harness listened, so a message the worker never got was marked answered | `a message that arrives while a chat reply is being written > a message the worker does not take before the reply ends waits for the next round` |

## T-0506 — chat command follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0506-M1 | packages/chat/src/command.ts | `parseCommand` stopped matching a message with leading whitespace before the slash | `commands in chat:send > leading whitespace before the slash still starts a command` |
| T-0506-M2 | packages/chat/src/command.ts | `/help` kept listing commands whose `when` does not hold now | `commands in chat:send > /help leaves out a command that is unavailable now` |
| T-0506-M3 | packages/chat/src/command.ts | number and integer arguments stayed text instead of being coerced | `commands in chat:send > number, integer and boolean arguments are positional and coerced` |
| T-0506-M4 | packages/chat/src/index.ts | a successful stop recorded no `chat.stop` fact, so a retry right after it found no stopped attempt | `chat:stop and chat:retry > retry after a stop answers again on the same session, keeps the stopped reply, and a rerun adds no entry` |
| T-0506-M5 | packages/chat/src/reply.ts | a reply that reported no cost was not counted as missing, so a mixed session showed a whole total | `chat:status > a session that mixes reported and unreported usage says the totals are partial` |
| T-0506-M6 | packages/chat/src/index.ts | `/status` ignored the run control saying the latest run had ended | `chat:status > a run a crash left without an ending entry is not called writing` |
| T-0506-M7 | packages/chat/src/reply.ts | the inbox counted a message as taken even when the harness said it could no longer take it | `a message that arrives while a chat reply is being written > a message the worker says it can no longer take waits for the next round` |
| T-0506-M8 | packages/chat/src/reply.ts | an attempt that failed or stopped did not record the mid-run messages it took as answered | `a message that arrives while a chat reply is being written > a message delivered before a failure is answered, so the next round does not repeat it` |

## T-0507 — the read-only worktree question offers Always allow

| id | file | mutation | failing test |
|---|---|---|---|
| T-0507-M4 | packages/chat/src/reply.ts | `Always allow` did not write the exact call and working directory to the user layer | `a read-only chat > Always allow writes the exact command and cwd, and the same command is not asked again` |
| T-0507-M5 | packages/chat/src/reply.ts | the read-only asker no longer read the user layer, so an always-allowed call asked again | `a read-only chat > Always allow writes the exact command and cwd, and the same command is not asked again` |
| T-0507-M6 | packages/chat/src/reply.ts | the worktree question kept the old `yes`/`no` instead of the approved words and the worktree offer | `a read-only chat > the question offers the approved words in order, then the worktree offer` |
| T-0507-M8 | packages/chat/src/reply.ts | `Deny` was read as an approving answer instead of a refusal | `a read-only chat > Deny refuses the call as no did, writes nothing, and opens no worktree` |

## T-0508 — a worktree yes ends the asking reply

| id | file | mutation | failing test |
|---|---|---|---|
| T-0508-M2 | packages/chat/src/reply.ts | a worktree yes returned a refusal and let the asking reply go on read-only | `a read-only chat > a yes ends the asking reply, leaves the message unanswered and sends the worktree event once` |
| T-0508-M3 | packages/chat/src/reply.ts | a late worktree yes passed through to the harness and started another reply | `a read-only chat > a late yes opens the worktree without starting another reply` |
| T-0508-M6 | packages/chat/src/views.ts | the worktree entry was drawn as the agent's own words instead of the one line saying the chat moved | `chat entries > the worktree line is shown as itself, not as the agent's words` |

## T-0509 — late permission answers and a stopped worktree yes

| id | file | mutation | failing test |
|---|---|---|---|
| T-0509-M2 | packages/chat/src/reply.ts | a late `Allow once` added no one-time permission to the run's access profile | `a read-only chat > Allow once answered after the wait lets this run's call through and writes nothing` |
| T-0509-M3 | packages/chat/src/reply.ts | a late `Always allow` wrote nothing to the user layer | `a read-only chat > Always allow answered after the wait writes the user layer and lets this run's call through` |
| T-0509-M4 | packages/chat/src/reply.ts | a worktree yes no longer stopped the harness, so one that swallowed the stop could run more calls | `a read-only chat > a yes stops the agent at once even when the harness swallows the stop` |
| T-0509-M5 | packages/chat/src/reply.ts | the normal worktree event key carried the run id and did not match the key the catch path emits | `a read-only chat > a yes stops the agent at once even when the harness swallows the stop` |

## T-0511 — a first reply waits for the model list

| id | file | mutation | failing test |
|---|---|---|---|
| T-0511-M7 | packages/chat/src/reply.ts | a chat with a named model checked the old synchronous list instead of waiting for the first refresh | `the reply and the model > a first reply with a named model waits for the list, then passes by it` |

## T-0513 — a repository chat starts with its agent files

| id | file | mutation | failing test |
|---|---|---|---|
| T-0513-M6 | packages/chat/src/reply.ts | the first prompt left the starting text out | `a repository chat's starting text > goes before the first message, and not again in that session` |
| T-0513-M7 | packages/chat/src/reply.ts | a chat that moved working directory got no new place and kept the old text | `a repository chat's starting text > after the chat moves to its worktree, the next message gets the place alone, once` |
| T-0513-M8 | packages/chat/src/reply.ts | the starting text was put before every message, not only the first | `a repository chat's starting text > goes before the first message, and not again in that session` |

## T-0514 — a reply in progress says what it is doing

| id | file | mutation | failing test |
|---|---|---|---|
| T-0514-M1 | packages/chat/src/views.ts | Thinking was always answered as Starting | `a reply's status > Starting starts at the first unanswered message and lasts until the ready line` |
| T-0514-M2 | packages/chat/src/tail.ts | the log's ready line was ignored, so the status stayed Starting | `a reply's status > Starting starts at the first unanswered message and lasts until the ready line` |
| T-0514-M3 | packages/chat/src/views.ts | the newest open call was named instead of the oldest | `a reply's status > Running names the oldest call still going, since when it started` |
| T-0514-M4 | packages/chat/src/views.ts | a failure no longer ended the status | `a reply's status > there is no status after a failure` |
| T-0514-M5 | packages/chat/src/views.ts | an old assistant message without `replyTo` no longer answered the message before it, so an idle snapshot said Starting | `a reply's status > an old assistant message with no replyTo answers the message before it` |

## T-0515 — a chat's worker is kept between replies

| id | file | mutation | failing test |
|---|---|---|---|
| T-0515-M7 | packages/chat/src/index.ts | closing a chat left its kept worker running | `closing a chat ends its kept worker` |
| T-0515-M9 | packages/chat/src/reply.ts | a pi reply no longer passed `keepWorker`, so its next message started a new worker | `a killed kept worker gives the next chat message a normal reply` |

## T-0516 — a chat's claude worker is kept

| id | file | mutation | failing test |
|---|---|---|---|
| T-0516-M6 | packages/chat/src/reply.ts | a claude reply no longer passed `keepWorker`, so its next message started a new worker | `a claude chat keeps its worker between replies and closes it with the chat` |

## T-0517 — a bot uses the owner's own agent settings

| id | file | mutation | failing test |
|---|---|---|---|
| T-0517-M7 | packages/chat/src/reply.ts | the reply did not hand the bot's own-settings switch to the agent step | `a reply reads the bot again > the own-settings switch is off by default and reaches the agent when on` |

## T-0521 — a failed chat reply does not poison the next one

| id | file | mutation | failing test |
|---|---|---|---|
| T-0521-M1 | packages/chat/src/model.ts | the unanswered messages were joined with a blank line again, not as separate blocks | `a failed reply > the C-0021 history answers a new message after two empty failures` |
| T-0521-M2 | packages/chat/src/reply.ts | an empty failure was marked taken only on the third in a row | `a failed reply > two empty failures in a row stop the oldest message from being sent a third time` |
| T-0521-M3 | packages/chat/src/reply.ts | an empty reply with no usage still read `the agent gave no reply` | `a failed reply > an empty result that called no model says so, with the agent's own reason` |

## T-0523 — the worktree question's answers say what they are

| id | file | mutation | failing test |
|---|---|---|---|
| T-0523-M1 | packages/chat/src/reply.ts | the worktree question was asked without its `choiceInfo` | `a read-only chat > a question about writing a file names the path and says it is a write` |

## T-0525 — chat access levels

| id | file | mutation | failing test |
|---|---|---|---|
| T-0525-M5 | packages/chat/src/index.ts | `chat:access` recorded the fact but left the chat's level unchanged | `chat:access > the next reply uses the changed level, and the history says who changed it and to what` |
| T-0525-M6 | packages/chat/src/reply.ts | the reply handed the harness the chat's profile without its level | `chat:access > the next reply uses the changed level, and the history says who changed it and to what` |
| T-0525-M7 | packages/chat/src/reply.ts | an agent that declares no level was called instead of refusing the reply | `a chat whose agent cannot carry the level > the reply is refused at its start, names the level, and the agent is never called` |
| T-0525-M8 | packages/chat/src/views.ts | the row never showed a level that differed from the starting one | `chat:access > the row leaves the starting level out and shows a choice` |

## T-0526 — a level change asks the owning plugin first

| id | file | mutation | failing test |
|---|---|---|---|
| T-0526-M3 | packages/chat/src/index.ts | `chat:access` no longer ran the chat's `accessAction` before it recorded the level | `a repository chat's access level > /access edits opens work/chat-<id>, moves the chat there, and a write passes without a question` (and `/access full does the same`) |
| T-0526-M4 | packages/chat/src/index.ts | `chat:access` recorded the level before the `accessAction` could refuse it | `a repository chat's access level > a worktree that cannot be opened leaves the level unchanged and says why` |

## T-0529 — a chat shows how full the context is

| id | file | mutation | failing test |
|---|---|---|---|
| T-0529-M6 | packages/chat/src/reply.ts | the reply ignored the model list's context window | `a chat's context usage > the reply records the last call's context and the model's window, and the view shows both` |
| T-0529-M7 | packages/chat/src/model.ts | the view kept the previous session's context after a new session began | `a chat's context usage > a new session clears the view until the next reply` |

## T-0530 — a harness describes each model it lists

| id | file | mutation | failing test |
|---|---|---|---|
| T-0530-M5 | packages/chat/src/index.ts | `chat:model` left out the descriptions of the models it offers | `chat:model > the argument carries what the agent knows about each model` |

## T-0531 — a chat's skills as `/name`

| id | file | mutation | failing test |
|---|---|---|---|
| T-0531-M1 | packages/chat/src/views.ts | the chat view returned no skills, so a client got the commands but not the skills in the same request | `a chat's skills > a bot chat lists its bot's skills with their descriptions, in a stable order` |
| T-0531-M2 | packages/chat/src/skills.ts | `skillMessage` expanded the skill for every harness, including one that declares `loadsSkills` | ``a chat's skills > a harness that loads skills itself gets `/name rest` unchanged`` |
| T-0531-M3 | packages/chat/src/skills.ts | the skill's body was left out of the message for a harness that does not load skills | `a chat's skills > a harness that does not load skills gets the skill body and then the rest` |
| T-0531-M4 | packages/chat/src/index.ts | `chat:send` no longer looked for an operad command first, so a skill named like one answered instead | `a chat's skills > an operad command of the same name wins, so the skill does not shadow it` |
| T-0531-M5 | packages/chat/src/command.ts | `/help` listed the commands but no skills after them | ``a chat's skills > `/help` lists the skills after the commands, marked as skills`` |

## T-0536 — the value a chat action offers as current

| id | file | mutation | failing test |
|---|---|---|---|
| T-0536-M1 | packages/chat/src/index.ts | `chat:effort` left out the current effort | `the value a chat action offers as current > a pi chat with no effort offers pi's own defaultThinkingLevel` |
| T-0536-M2 | packages/chat/src/index.ts | `chat:model` left out the current model | `the value a chat action offers as current > a chat with no model offers the configured model` |

## T-0540 — a chat follows its agent's live default effort

| id | file | mutation | failing test |
|---|---|---|---|
| T-0540-M1 | packages/chat/src/model.ts | `effectiveEffort` preferred the stored default over the agent's live one | `the value a chat action offers as current > a chat made when the agent's default was medium offers the default it declares now` (and `chat:status > shows the agent's live default, and the stored one only when it declares none`) |

## T-0541 — an effort equal to its stored default is inherited

| id | file | mutation | failing test |
|---|---|---|---|
| T-0541-M1 | packages/chat/src/model.ts | `chosenEffort` returned any stored effort, so one equal to its stored default was treated as a choice | `the value a chat action offers as current > an effort equal to the stored default is inherited, and one that differs is offered` (and `chat:status > shows the live default for an inherited effort, a choice, and the stored default only when none is declared`) |

## T-0546 — a plugin-written message names its own event source

| id | file | mutation | failing test |
|---|---|---|---|
| T-0546-M1 | packages/chat/src/index.ts | `sendMessage` ignored the source its caller named, so a scheduled message became `other` | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` (packages/bot/test/schedule.test.ts) |

## T-0553 — scheduled gaps from the desktop and iOS reviews

| id | file | mutation | failing test |
|---|---|---|---|
| T-0553-M1 | packages/chat/src/views.ts | a chat row dropped the scheduled origin it was given | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` (packages/bot/test/schedule.test.ts) |
| T-0553-M2 | packages/chat/src/model.ts | `createChat` dropped the scheduled origin it was given | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` (packages/bot/test/schedule.test.ts) |

## T-0558 — a chat's access level is live

| id | file | mutation | failing test |
|---|---|---|---|
| T-0558-M2 | packages/chat/src/index.ts | `chat:access` no longer wrote the live-level file | `chat:access > a change updates the live file a running reply reads, keeping its base profile` |
| T-0558-M3 | packages/chat/src/reply.ts | `levelRecheck` returned no check, so an open question was not checked again | `chat:access > a question open when the level rises is checked again under the new level` |
| T-0558-M8 | packages/chat/src/reply.ts | `levelRecheck` compared the new level with the reply's start level instead of the level the question was opened under | `chat:access > a question opened after a lowering is lifted when the level returns to the reply's start` |
| T-0558-M9 | packages/chat/src/reply.ts | `withLevelFileDeny` left the chat directory out of `denyPaths`, so an agent could write its own live level file | `chat:access > every level denies its own live level file to write, edit and a bash redirect` |

## T-0560 — follow-ups for the live access level

| id | file | mutation | failing test |
|---|---|---|---|
| T-0560-M1 | packages/chat/src/reply.ts | `levelRecheck` lifted a question when the new level still asked about it | `chat:access > a question opened after a lowering stays open when the new level still asks` |
| T-0560-M2 | packages/chat/src/index.ts | `chat:access` said the next reply would use the level, not that replies follow it | `chat:access > the next reply uses the changed level, and the history says who changed it and to what` |

## T-0565 — a message sent during a reply is in time order

| id | file | mutation | failing test |
|---|---|---|---|
| T-0565-M1 | packages/chat/src/views.ts | `turnFacts` no longer ordered a turn by its items' times | `the transcript places a message sent during a reply by its time > stored: the reply's items before the message stay above it, and those after stay below it` |
| T-0565-M2 | packages/chat/src/views.ts | the live section did not stop finished content before a message it was holding in the tail | `the transcript places a message sent during a reply by its time > live: the tail puts the message among the reply's lines, and the stored read after the run keeps that order` |
| T-0565-M3 | packages/chat/src/reply.ts | a text entry was recorded without the time its log line carried | `the transcript places a message sent during a reply by its time > stored: the reply's items before the message stay above it, and those after stay below it` |
| T-0565-M4 | packages/chat/src/views.ts | `runChunks` fell back to the older chunks, so a mid-run message stayed in its own chunk above the whole reply | `the transcript places a message sent during a reply by its time > stored: the reply's items before the message stay above it, and those after stay below it` |

## T-0566 — a message the run did not take stays out of its reply

| id | file | mutation | failing test |
|---|---|---|---|
| T-0566-M1 | packages/chat/src/views.ts | `runChunks` kept a message the reply did not name in the reply's items | `the transcript places a message sent during a reply by its time > stored: a message the run did not take stays out of the reply's items and waits below it` |

## T-0567 — running and intermediate text keep their lines

| id | file | mutation | failing test |
|---|---|---|---|
| T-0567-M1 | packages/chat/src/views.ts | the live tail flattened the text being written again | `chat transcript: after, mark and tail > text being written keeps its lines and their Markdown` |
| T-0567-M2 | packages/chat/src/views.ts | `entryMarkdown` flattened a stored intermediate text entry again | `chat entries > stored intermediate text and thinking keep their lines and Markdown` |

## T-0568 — a reply interrupted by a crash or restart

| id | file | mutation | failing test |
|---|---|---|---|
| T-0568-M1 | packages/chat/src/reply.ts | the recovered reply no longer read the agent's log, so it kept none of the entries the live view had | `a reply interrupted by a crash or restart > keeps the items it finished and a stopped line, and /retry continues the chat` |
| T-0568-M2 | packages/chat/src/reply.ts | the recovered reply recorded no line saying it stopped | `a reply interrupted by a crash or restart > keeps the items it finished and a stopped line, and /retry continues the chat` |
| T-0568-M3 | packages/chat/src/index.ts | `chat:retry` refused a stopped attempt, so it refused a reply a crash interrupted | `a reply interrupted by a crash or restart > keeps the items it finished and a stopped line, and /retry continues the chat` |
| T-0568-M4 | packages/chat/src/reply.ts | the keep step added its stopped line after a reply step that had already returned interrupted | `a reply interrupted by a crash or restart > a step that returns interrupted keeps its one stopped line` |
| T-0568-M5 | packages/chat/src/reply.ts | the keep step marked a reply already recorded for a run that owed no message | `a reply interrupted by a crash or restart > a reply already recorded and owing no message is not marked interrupted` |
| T-0568-M6 | packages/chat/src/views.ts | the interrupted line was drawn as the agent's own words instead of one line of its own | `a reply interrupted by a crash or restart > keeps the items it finished and a stopped line, and /retry continues the chat` |
| T-0568-M7 | packages/chat/src/model.ts | `entryOfFact` dropped the interrupted flag, so the stopped line lost its own shape | `a reply interrupted by a crash or restart > keeps the items it finished and a stopped line, and /retry continues the chat` |
| T-0568-M8 | packages/chat/src/reply.ts | the keep step skipped every run with an assistant message, so an interrupted second round kept nothing | `a reply interrupted by a crash or restart > keeps the second round when an earlier round already recorded a reply` |
| T-0568-M9 | packages/chat/src/reply.ts | the recovered log recorded the earlier round's entries again | `a reply interrupted by a crash or restart > keeps the second round when an earlier round already recorded a reply` |

## T-0570 — a running reply is pushed over the event stream

| id | file | mutation | failing test |
|---|---|---|---|
| T-0570-M1 | packages/chat/src/views.ts | `livePush` left the `tail` out of the pushed part | `the chat's live push > the text being written is the same tail the section shows` |
| T-0570-M2 | packages/chat/src/views.ts | `livePush` flattened the pushed tail onto one line, so thinking lost its quote lines | `the chat's live push > thinking being written is a block quote` |
| T-0570-M3 | packages/chat/src/views.ts | `toolMarkdown` dropped a finished tool call's duration from the pushed tail | `the chat's live push > a tool call ending replaces its start with how long it took` |

## T-0570 rework — the pushed tail

| id | file | mutation | failing test |
|---|---|---|---|
| T-0570-M4 | packages/chat/src/views.ts | `tailPush` left the `tail` out of the pushed part | `the chat's pushed tail > the text being written is the same tail the section shows` |
| T-0570-M5 | packages/chat/src/views.ts | `tailPush` flattened the pushed tail onto one line, so thinking lost its quote lines | `the chat's pushed tail > thinking being written is a block quote` |
| T-0570-M6 | packages/chat/src/views.ts | `toolMarkdown` dropped a finished tool call's duration from the pushed tail | `the chat's pushed tail > a tool call ending replaces its start with how long it took` |
## T-0569 — a form question is never the worktree question

| id | file | mutation | failing test |
|---|---|---|---|
| T-0569-M10 | packages/chat/src/reply.ts | `isWriteQuestion` and `questionedCall` did not recognise a form, so a form whose text reads like a write question became the worktree question | `a form a chat's agent asks > it is never turned into the worktree question, and its answers reach the harness` |

## T-0574 — a retry is a live transcript item

| id | file | mutation | failing test |
|---|---|---|---|
| T-0574-M1 | packages/chat/src/views.ts | the live transcript dropped the `retry` item | `chat transcript: after, mark and tail > a retry is a live item with the time of its next attempt` |
| T-0574-M2 | packages/chat/src/views.ts | the live tail left out the retry line | `chat transcript: after, mark and tail > a retry is a live item with the time of its next attempt` |
| T-0574-M3 | packages/chat/src/reply.ts | a `pi` reply did not ask the worker for its retry | `chat/reply > a pi chat asks for pi's retry; another agent is not asked` |

## T-0572 — a chat's queued messages

| id | file | mutation | failing test |
|---|---|---|---|
| T-0572-M1 | packages/chat/src/model.ts | `takenIds` ignored `chat.taken`, so a run's first message stayed queued and could still be changed | `a chat's queued messages > the row and the transcript say what is queued, and a run's first message stops being queued` |
| T-0572-M2 | packages/chat/src/model.ts | `applyMessageChanges` kept a withdrawn message, so it stayed in the chat's messages | `a chat's queued messages > withdrawing a queued message removes it from the transcript, leaves a history entry, and sends nothing to the agent` |
| T-0572-M3 | packages/chat/src/index.ts | `chat:edit` recorded the old text instead of the new one | `a chat's queued messages > changing a queued message's text keeps its attachments, and the agent gets the new text` |
| T-0572-M4 | packages/chat/src/index.ts | the queued-message check no longer refused a message a run had taken | `a chat's queued messages > a message a run has taken cannot be withdrawn or changed` |
| T-0572-M5 | packages/chat/src/reply.ts | the inbox handed a message without recording the take, so an action could still withdraw it | `a chat's queued messages > a take and a withdraw of the same message never both happen: the take wins when it starts first` |
| T-0572-M6 | packages/chat/src/index.ts | `chat:send` no longer wrote the new queue to the chat object, so the row showed none | `a chat's queued messages > the row and the transcript say what is queued, and a run's first message stops being queued` |
| T-0572-M7 | packages/chat/src/views.ts | the row carried `data.queued` without `data.queuedCount` | `a chat's queued messages > the row and the transcript say what is queued, and a run's first message stops being queued` |
## T-0575 — `chat:retry` is offered only when it would answer

| id | file | mutation | failing test |
|---|---|---|---|
| T-0575-M4 | packages/chat/src/index.ts | `chat:retry` was offered on every open chat again, instead of only when it would start a reply | `chat:retry is offered only when it would start a reply > a finished reply does not offer it, and says why` |
| T-0575-M5 | packages/chat/src/index.ts | `retryCheck` did not check whether a reply is being written | `chat:retry is offered only when it would start a reply > a reply being written does not offer it, even after a failed attempt` |
| T-0575-M6 | packages/chat/src/index.ts | `retryCheck` ignored the stop fact that is recorded before the stopped half reply | `chat:retry is offered only when it would start a reply > a stop offers it at once, before the stopped half reply enters the record` |
| T-0575-M7 | packages/chat/src/index.ts | `run` no longer checked the rule again, so a reply that started after the offer was retried anyway | `chat:retry is offered only when it would start a reply > the run checks the rule again when a reply started after the offer` |

## T-0571 — a reply's structured form beside its Markdown

| id | file | mutation | failing test |
|---|---|---|---|
| T-0571-M1 | packages/chat/src/views.ts | `replyBlocks` left the answer out of a finished reply | `a reply's structured form > live: the input and the process are there, and the stored read adds the answer and the reply's duration` |
| T-0571-M2 | packages/chat/src/views.ts | `addCategory` put every tool in `other` | `a reply's structured form > a failed tool keeps its name, input, duration and failure, and a long output keeps its first lines, count and file` |
| T-0571-M3 | packages/chat/src/views.ts | `replyItemOfEntry` set `failed` false for a failed tool | `a reply's structured form > a failed tool keeps its name, input, duration and failure, and a long output keeps its first lines, count and file` |
| T-0571-M4 | packages/chat/src/views.ts | `processOf` did not close a group at a message the reply took mid-run | `a reply's structured form > a reply with a mid-run message keeps both in time order and splits its process there` |
| T-0571-M6 | packages/chat/src/views.ts | `load` left the live log's process items out of the reply data | `a reply's structured form > live: the input and the process are there, and the stored read adds the answer and the reply's duration` |
| T-0571-M7 | packages/chat/src/views.ts | `messageFrom` dropped a reply's timings, so a finished reply had no duration | `a reply's structured form > live: the input and the process are there, and the stored read adds the answer and the reply's duration` |

## T-0571 rework — a reply's window and the size cap

| id | file | mutation | failing test |
|---|---|---|---|
| T-0571-M8 | packages/chat/src/views.ts | a page read carried every reply instead of the replies on that page | `a reply's structured form > many replies: a page carries the replies on it, and an after read only what finished since its mark` |
| T-0571-M9 | packages/chat/src/views.ts | a read with `after` carried every finished reply instead of the ones finished since the mark | `a reply's structured form > many replies: a page carries the replies on it, and an after read only what finished since its mark` |
| T-0571-M10 | packages/chat/src/views.ts | `replyData` left the tool output text in place, so the replies went over the cap | `a reply's structured form > many replies: the cap cuts tool output text before it cuts the Markdown, keeping its lines` |
| T-0571-M11 | packages/chat/src/views.ts | a `full` read cut the tool output text as a capped read did | `a reply's structured form > many replies: the cap cuts tool output text before it cuts the Markdown, keeping its lines` |
| T-0571-M12 | packages/chat/src/views.ts | `tailPush` left the running reply's data out of the pushed part | `the chat's pushed tail > the running reply is structured in the push` |
| T-0571-M15 | packages/chat/src/views.ts | a read with `after` left the one still-running reply out of its data | `a reply's structured form > live: the input and the process are there, and the stored read adds the answer and the reply's duration` |

## T-0576 — chat friction follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0576-M1 | packages/chat/src/views.ts | a retry with no `receivedAt` fell back to the log's last stamped line, so `until` moved on every read | `chat transcript: after, mark and tail > a retry with no time of its own is left out of the retry item and the tail alike` |
| T-0576-M2 | packages/chat/src/views.ts | `replyData` blanked tool output but left thinking, text, input and answer text whole, so a reply whose output was empty could still go over the cap | `a reply's structured form > the cap shortens the thinking, text and answer of a reply too` and `the chat's pushed tail > the pushed running reply's data stays under the cap` |
| T-0576-M3 | packages/chat/src/model.ts | `entryOfFact` dropped a stored tool entry that had no call id or name instead of showing it as a tool | `a reply's structured form > a stored tool entry without a call id or name stays as a tool` |
| T-0576-M4 | packages/chat/src/views.ts | a page or `after` read built every reply, or lost the answer before its window, so the window's first reply carried replies it did not answer or lost its own input | `a reply's structured form > many replies: a page's first reply keeps its own input, and an after read starts at its mark` |

The T-0570 rows earlier in this file name `livePush`, which is now `tailPush`;
their current tests are `the chat's pushed tail > the text being written is the
same tail the section shows`, `... > thinking being written is a block quote`
and `... > a tool call ending replaces its start with how long it took`. Rows
are append-only, so the old lines stay as history.

## T-0577 — a tool output's server address

| id | file | mutation | failing test |
|---|---|---|---|
| T-0577-M1 | packages/chat/src/views.ts | `replyOutput` left `url` out, so a client got no address for the whole output | `a tool's whole output carries the server address that serves it, and no local path` |
| T-0577-M2 | packages/chat/src/views.ts | the chat's `file` check allowed every path instead of only the files its facts name | `the attachment route refuses a file the chat does not name, and one outside the chat` |

## T-0585 — the step a chat's refresh data names after a reply

| id | file | mutation | failing test |
|---|---|---|---|
| T-0585-M9 | packages/chat/src/reply.ts | `runAfterStep` returned for every named step instead of running it | `the step a chat's refresh data names after a reply > runs once after the reply, with the chat` |

## T-0585 rework 1 — the after step of a stopped run

| id | file | mutation | failing test |
|---|---|---|---|
| T-0585-M10 | packages/chat/src/reply.ts | `keepInterrupted` no longer ran the after step for a stopped or interrupted run | `the step a chat's refresh data names after a reply > runs after a stopped or interrupted reply, for the run the keep step finishes` |

## T-0586 — the memory notes on a bot chat's message

| id | file | mutation | failing test |
|---|---|---|---|
| T-0586-M1 | packages/chat/src/notes.ts | `notesToAttach` returned no note for a new session | `the notes on a bot chat's message > a new session's first message carries the whole index and instructions` |
| T-0586-M2 | packages/chat/src/notes.ts | the hash comparison was reversed, so an unchanged note went again and a changed one did not | `the notes on a bot chat's message > a file changed elsewhere is sent whole on the next message, once` |
| T-0586-M3 | packages/chat/src/reply.ts | the hashes were taken from the text read before the run, so a change the run wrote was sent back | `the notes on a bot chat's message > a change this chat's run wrote is not sent back` |
| T-0586-M4 | packages/chat/src/reply.ts | compaction was only the agent's flag, not a smaller context, so nothing went again after a compaction | `the notes on a bot chat's message > the first message after a compaction carries the whole notes again` |
| T-0586-M5 | packages/chat/src/notes.ts | a note with a limit was never cut and carried no cut line | `the notes on a bot chat's message > the index is cut at its limit with a line saying so, and a change past the cut still resends it` |
| T-0586-M6 | packages/chat/src/reply.ts | the stored hashes were merged with the old ones, so a file the refresh step no longer names stayed | `the notes on a bot chat's message > the stored hashes cover the files the refresh step names now, and no others` |
| T-0586-M10 | packages/chat/src/notes.ts | every file changed during the run kept its hash after the run, so a change another chat wrote during the reply was taken as seen | `the notes on a bot chat's message > a change another chat wrote during the reply is sent on the next message` |
| T-0586-M11 | packages/chat/src/notes.ts | no tool name counted as a write, so a change the run reported writing was sent back | `the notes on a bot chat's message > a change this chat's run wrote is not sent back` |

## T-0590 — memory v1 follow-ups, shell writes and one after step per run

| id | file | mutation | failing test |
|---|---|---|---|
| T-0590-M26 | packages/chat/src/notes.ts | a shell command that wrote a note was not counted as this run's write | `the notes on a bot chat's message > a note written through a shell command is not sent back either` |
| T-0590-M27 | packages/chat/src/reply.ts | `runAfterStep` ran after every round, including one that ended `more` | `the step a chat's refresh data names after a reply > runs once for a run that takes more than one round, not once per round` |
| T-0590-M28 | packages/chat/src/reply.ts | compaction ignored the agent's `data.compacted` flag | `the notes on a bot chat's message > the agent's own compaction flag brings the whole notes back` |

## T-0635 — one elapsed format

| id | file | mutation | failing test |
|---|---|---|---|
| T-0635-M7 | packages/chat/src/views.ts | a tool call's duration added a second | `chat entries > the transcript shows done, failed, blocked and denied tool calls, and thinking as an unlabeled quote` |
| T-0635-M14 | packages/chat/src/index.ts | a reply's first output added a second, so `1s` read `2s` | `chat:status > shows each line: agent, model, effort, reply, waiting, session usage and the last reply` |
