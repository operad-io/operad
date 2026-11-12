# `@operad-io/chat`

The `chat` plugin: a long conversation with an agent, and how a message is
answered. It comes with operad. It knows nothing of repositories or bots:
the plugin that opens a chat gives every field (`createChat`).

## The object

A chat has a parent (a full object id), a harness (a harness plugin name, fixed
once the chat exists), a working directory, an access profile, skills, a title,
the harness's own session reference (never shown), bound channels, and whether
it is closed. Its ids are `C-0001` upward. Messages are not fields: each is a
`chat.message` fact on the chat (who, when, text, attachment paths, the source
and its reference). An assistant message also names the messages it answers
(`replyTo`) and the session after it. Closing a chat appends a `chat.closed`
fact and marks the object closed; the messages stay in its transcript.

## `chat:send <chat> --note <text>`

Records the message and sends the event `message` from the source named by the
client (`ios`, `telegram`, `cli`; any other client counts as `cli`), keyed by the
message id and about the chat. Three default rules start `chat:reply` with `auto`
on that event. A closed chat refuses the action and adds no message.

## `chat:close <chat>`

Asks for confirmation and records a `chat.closed` fact naming who closed it. A
closed chat's row reads `closed` and is final; it offers no actions, and a
message is refused with a short line saying the chat is closed. The transcript
stays readable. Chats have the filters `open` (the default) and `closed`, with
the kernel's `all` after `open`, so lists hide closed chats unless asked.

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

In a chat whose access profile is `readOnly`, a harness question about a
command, a write or an edit becomes the worktree question (`yes`/`no`) and
never a one-time permission. The question names the call: the command, or the
path and whether it is a write or an edit; a long command is cut, and the ask
keeps the whole call. A `yes` sends the event `chat.worktree`; the plugin that
owns the working directory acts on it (`dev` opens `work/chat-<id>`). A `no`
tells the agent the call was refused because the chat is read-only, and that it
should answer in the chat or use read-only commands.

## The `transcript` section

A live section that pages over the message facts, so the command line, the TUI
and the app show a chat with no client change.

## The speaker

The transcript labels the model's messages with a speaker name, read each time
it is drawn: `plugins.chat.settings.speaker`, `Operad Bot` when not set. A
chat's parent object may carry a `speaker` of its own (a bot does), and that
name is used instead. Messages already recorded get a changed name too.
