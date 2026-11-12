# `@operad-io/chat`

The `chat` plugin: a long conversation with an agent, and how a message is
answered. It comes with operad. It knows nothing of repositories or bots:
the plugin that opens a chat gives every field (`createChat`).

## The object

A chat has a parent (a full object id), an agent (the name of a harness plugin,
fixed once the chat exists), a working directory, an access profile, skills, a
title, the agent's own session reference (never shown), bound channels, and
whether it is closed. Its ids are `C-0001` upward. Messages are not fields: each
is a `chat.message` fact on the chat (who, when, text, attachment paths, the
source and its reference). An assistant message also names the messages it answers
(`replyTo`), the run it belongs to (`runId`) and the session after it. Closing a
chat appends a `chat.closed` fact and marks the object closed; the messages stay
in its transcript.

What the agent did during an answer is recorded too, as `chat.entry` facts with
the same `runId` as the reply: intermediate text, thinking, a tool call (its call
id, name, input summary, result, start, duration, the first 4 KB of its output,
the file holding the whole output and the first line of an error) and the
half-written reply of a run that was stopped. Increments are not stored. Output
longer than 4 KB goes to a file under the chat's own directory (under
`attachments/chat/<id>/tool-output/`), and secret values are masked before a
fact or a file is written. A rerun skips a tool call whose id was already recorded and does not add
the same unfinished text again.

## `chat:send <chat> --note <text>`

Records the message and sends the event `message` from the source named by the
client (`ios`, `telegram`, `cli`; any other client counts as `cli`), keyed by the
message id and about the chat. Three default rules start `chat:reply` with `auto`
on that event. A closed chat refuses the action and adds no message.

## `chat:model <chat> --model <name>`

Changes the model the chat's next reply uses. The argument is one of the models the chat's agent lists (its plugin declares them); a closed chat, or an agent that lists none, does not offer the action. A `chat.model` fact records who changed it, from what and to what. A chat whose model its agent cannot take fails the reply with a message naming the model; it never falls back to another one.

## `chat:effort <chat> --effort <level>`

Changes the effort the chat's next reply uses. The argument is one of the levels the chat's agent lists (its plugin declares them; pi's thinking levels are its efforts); a closed chat, or an agent that lists none, does not offer the action. A `chat.effort` fact records who changed it, from what and to what. A chat whose effort its agent cannot take fails the reply with a message naming it; it never falls back to another one. The row shows the effort when it is not the agent's default.

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

The agent gets `operadTools: { home }`, so it calls operad through MCP tools and
never through a shell.

In a chat whose access profile is `readOnly`, an agent question about a
command, a write or an edit becomes the worktree question (`yes`/`no`) and
never a one-time permission. The question names the call: the command, or the
path and whether it is a write or an edit; a long command is cut, and the ask
keeps the whole call. A `yes` sends the event `chat.worktree`; the plugin that
owns the working directory acts on it (`dev` opens `work/chat-<id>`). A `no`
tells the agent the call was refused because the chat is read-only, and that it
should answer in the chat or use read-only commands.

## The `transcript` section

A live section that pages over the message and entry facts, so the command line,
the TUI and the app show a chat with no client change. A turn's entries show
before its reply: one line per tool call with what ran and how long it took, how
a failed, blocked or denied call ended, the agent's text with its speaker, and
thinking as a block quote. Tool output is not shown. Radian chats show the tool
lines only. Pages count messages, and a turn's entries stay on the page of its
reply.

## The speaker

The transcript labels the model's messages with a speaker name, read each time
it is drawn: `plugins.chat.settings.speaker`, `Operad Bot` when not set. A
chat's parent object may carry a `speaker` of its own (a bot does), and that
name is used instead. Messages already recorded get a changed name too.
