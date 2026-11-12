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
| T-0335-M1 | packages/chat/src/reply.ts | the worktree question left the call out and asked only about changing code | `a read-only chat > a command that redirects output into a file is named in the worktree question too` |
