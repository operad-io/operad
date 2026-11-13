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
