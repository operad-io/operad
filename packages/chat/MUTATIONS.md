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
