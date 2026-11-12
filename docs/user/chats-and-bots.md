---
description: Chats with an agent, and bots.
---

# Chats and bots

A chat is a long conversation with an agent. The `chat` plugin comes with
`operad init`; a chat belongs to the plugin that opens it. `dev` opens one on a
repository:

```
operad dev:chat --repo operad --title "The build" [--agent pi]
operad chat:send C-0001 --note "why does the gate fail on main?"
operad show C-0001 --section transcript
```

`dev:chat` offers `claude` and `pi` as agents (the first one loaded when `--agent` is left out): they can stop a tool call before it starts, which a read-only chat needs. `radian` is refused there as an agent and stays for bot chats.

`chat:send` records the message and sends an event (source `ios`, `telegram` or
`cli`, key = the message id, about the chat). The plugin's own rule starts
`chat:reply` for each of the three sources, automatically; a rule of yours in
`triggers.json` with the same source and type replaces it. The reply reads the
messages no reply answers yet from the chat's own record, continues the agent
session, records the reply, and goes round again while new messages came in
meanwhile (at most 20 rounds). After a restart a reply that was already
recorded is not given twice.

`chat:send` takes `attachments`: files a client uploaded (`POST /v1/uploads`),
which are stored under the chat's attachment directory in the operad home. A
message may be only files. The transcript shows each as a line with its name
(an image as an image, another file as an `Attachment:` link). The reply gives
an image to `claude` and `pi` as image input (up to 5 MB each) and every file to
the agent as a path in the prompt; the chat's access profile gains read access
to that chat's attachment directory (`readPaths`) and nothing else. The MCP tools
cannot pass a file; a client uploads it.

`chat:close C-0001` asks for confirmation and records a `chat.closed` event. A
closed chat keeps its transcript, refuses `chat:send` with a short message and
offers no actions. Chats have the filters `open` (the default) and `closed`; the
kernel adds `all`, so `operad list chat --filter all` still shows closed chats.

A chat on a repository works in the main clone, read-only: a shell command runs
there only when it is on a short list of commands that only read (`git status`,
`ls`, `cat`, `grep`, `sed -n`, `bun test`, ...); every other command, and every
write or edit, becomes the worktree question, which names the command or the
path. When the agent wants to change code it asks whether to open a worktree.
A no tells the agent the call was refused because the chat is read-only, and
that it should answer in the chat or use read-only commands. On yes, `dev` opens
`work/chat-<id>` and the chat works there from then on, once; the main clone
stays read-only. The worktree's changes reach main only through a task that
points at it, through the normal gate and integrate.

The agent reaches operad through its tools (`list`, `show`, `section`, `pending`,
`answer`, `running`, `history`, `command`, `act`, under the same allow lists as
`operad mcp`), never by running `operad` in a shell.
