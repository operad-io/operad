# ADR 0028: Repository Chats and Bot Chats

Status: accepted

## Background

A chat starts in one of two places: from a repository, to work on that repository, or from a bot, as the everyday assistant. They are the same object (ADR 0026); they differ in where they start and where the working directory and configuration are read from.

## Decisions

### D1: Two kinds of chat, by where they start

- A **repository chat** is created by the `dev` action `dev:chat` on a repository. Its parent is the repository, its working directory is the repository, and its agent and access profile are read from the repository's `dev.json`. It is for discussing the repository, opening plans and tasks and looking at runs.
- A **bot chat** is created by the `bot` plugin's action `bot:chat` on a bot. Its parent is that bot, and its working directory, skills and access profile come from the bot.

Creating is an action on the parent object whose parameters are the agent (an enum of the loaded harness plugins, defaulting to the one `dev.json` or the bot names), the model, the effort and a title, drawn by the client's ordinary parameter form. The kernel gains no type-level action and no new object. Continuing an old chat is opening it and using `chat:send`.

### D2: A repository chat only offers agents that can stop a call before it starts

A repository chat offers only agents that can stop a tool call before it begins (claude and pi), and defaults to the first of them. radian sees a call only after it started, from its journal, and cannot stop it, so it cannot keep the main clone read-only: it is not among the agents of `dev:chat` and is used only for a bot chat.

### D3: A repository chat is read-only in the main clone

A repository chat works in the main clone, read-only. When the agent decides it needs to change code, it asks through `ctx.ask` whether to open a worktree. If the answer is yes, `dev` opens a worktree on `work/chat-<id>`, and the chat's working directory moves there once (never again); that worktree is writable, and the main clone stays read-only. Changes in that worktree reach the main branch only through a task that this chat opened and that points at that worktree, by integrate; the hard rule of the project flows stands.

### D4: A chat reaches operad through MCP tools, not the shell

A chat calls plugins through operad's MCP tools, not by typing `operad` commands in a shell: the read tools of `operad mcp`, the plugins' verbs, and the actions on the allowed list are attached to the harness (claude and radian over stdio MCP; pi as `customTools`). A bot chat looks at tasks, opens a task and asks why a task is stuck through them, and never edits a repository's files itself; a repository chat is the same.

### D5: A chat is created by its first message

A client starts a chat by choosing a parent (a bot or a repository) and an agent, and opens an empty chat page; the chat is created only when the first message is sent, so opening without speaking leaves no empty chat. The creating actions (`dev:chat`, `bot:chat`) therefore accept the first message and create the chat and send it in one action; with no title given, the title is the start of the first message. These actions declare that what they create is a chat (ADR 0018 D2), so a client puts them only at the chat's own entry and the repository and bot pages have no Chat button. The command line may still run `dev:chat` without a message.

### D6: One chat can have several channels

A channel conversation (such as a Telegram chat, ADR 0033) bound to an operad chat sends its messages into that chat, and replies go back to the channel the message came from; every client sees all of it. By default there is one operad chat per (channel, chat) pair, created on the default bot. A chat created in the app is bound to no channel.
