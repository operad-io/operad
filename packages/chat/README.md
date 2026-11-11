# `@operad-io/chat`

The `chat` plugin: a long conversation with an agent, and how a message is
answered. It comes with operad. It knows nothing of repositories or profiles:
the plugin that opens a chat gives every field (`createChat`).

## The object

A chat has a parent (a full object id), a harness (a harness plugin name, fixed
once the chat exists), a working directory, an access profile, skills, a title,
the harness's own session reference (never shown) and bound channels. Its ids
are `C-0001` upward. Messages are not fields: each is a `chat.message` fact on
the chat (who, when, text, attachment paths, the source and its reference). An
assistant message also names the messages it answers (`replyTo`) and the session
after it.

## `chat:send <chat> --note <text>`

Records the message and sends the event `message` from the source named by the
client (`ios`, `telegram`, `cli`; any other client counts as `cli`), keyed by the
message id and about the chat. Three default rules start `chat:reply` with `auto`
on that event.

## `chat:reply`

One step, `chat/reply`, and a loop in the flow. The step builds the prompt from
the unanswered messages in the facts (never from the event), continues the
chat's session, records the reply as a fact before it counts as done, updates the
session reference and looks again for messages that arrived meanwhile: if there
are some its result is `more` and the flow runs it again. The flow's `maxVisits`
(20) ends a loop that never catches up. A question that ran out of grace ends the
step `waiting`; the answer comes back with the session.

The harness gets `operadTools: { home }`, so the agent calls operad through MCP
tools and never through a shell.

In a chat whose access profile is `readOnly`, a harness question about writing a
file becomes the worktree question (`yes`/`no`) and never a one-time
permission. A `yes` sends the event `chat.worktree`; the plugin that owns the
working directory acts on it (`dev` opens `work/chat-<id>`).

## The `transcript` section

A live section that pages over the message facts, so the command line, the TUI
and the app show a chat with no client change.
