# ADR 0028: Repository Chats and Bot Chats

Status: accepted

## Background

A chat starts in one of two places: from a repository, to work on that repository, or from a bot, as the everyday assistant. They are the same object (ADR 0026); they differ in where they start and where the working directory and configuration are read from.

## Decisions

### D1: Two kinds of chat, by where they start

- A **repository chat** is created by the `dev` action `dev:chat` on a repository. Its parent is the repository, its working directory is the repository, and its agent, access profile and skills are read from the repository's `dev.json`. It is for discussing the repository, opening plans and tasks and looking at runs.
- A **bot chat** is created by the `bot` plugin's action `bot:chat` on a bot. Its parent is that bot, and its working directory, skills and access profile come from the bot.

Creating is an action on the parent object whose parameters are the agent (an enum of the loaded harness plugins, defaulting to the one `dev.json` or the bot names), the model, the effort and a title, drawn by the client's ordinary parameter form. The kernel gains no type-level action and no new object. Continuing an old chat is opening it and using `chat:send`.

### D2: A repository chat only offers agents that can stop a call before it starts

A repository chat offers only agents that can stop a tool call before it begins (claude and pi), and defaults to the first of them. radian sees a call only after it started, from its journal, and cannot stop it, so it cannot keep the main clone read-only: it is not among the agents of `dev:chat` and is used only for a bot chat.

### D3: A repository chat that works in a worktree is read-only in the main clone

How a repository's work is placed is its `workIn` setting (ADR 0039 D1). With `workIn` `branch`, a repository chat works in the main clone on the branch that is checked out, at its access level (below), and no worktree is offered: raising the level to `edits` or `full` opens nothing, no `work/chat-<id>` branch is made, and `plan` stays read-only. While a task holds the main clone (ADR 0039 D3), the chat's reply is read-only and its context says which task holds the clone and what to do: wait until that task is merged, cancelled or rejected, then ask again. No worktree is offered meanwhile, and the chat is writable again at its level once the task has ended. The rest of this decision is the rule for `workIn` `worktree`.

With `workIn` `worktree`, a repository chat works in the main clone, read-only unless a person explicitly allows a call there. When the agent decides it needs to change code, it asks through `ctx.ask` about the call: `Allow once` runs this call in the main clone only, `Always allow` writes the exact command or path and working directory to the user layer (ADR 0025 D7) and runs it, `Deny` refuses it, and the worktree offer opens a worktree. If the person chooses the worktree offer, `dev` opens a worktree on `work/chat-<id>`, and the chat's working directory moves there once (never again); that worktree is writable, and the main clone stays read-only. A chat at `plan` moves to `edits` with it, and the transcript records the change, so the reply there is not read-only; a level the person set above `plan` stays. A reply still running in the main clone when its chat moves to the worktree by a level change ends and is answered again there. The reply that asked ends when the person chooses it, and its message is answered again in the worktree, so the agent continues there with write access and no second worktree question comes from that reply. A yes that arrives after the reply has ended opens the worktree once but starts no second reply. Changes in that worktree reach the main branch only through a task that this chat opened and that points at that worktree, by integrate; the hard rule of the project flows stands.

A repository chat starts at the access level `plan`; a bot chat starts at the level of the bot's `accessLevel` setting, `ask` unless the bot sets it, and follows the setting until a person chooses a level with `/access` (ADR 0026 D15). With `workIn` `worktree`, a repository chat that still works in the main clone and is raised to `edits` or `full` first opens its worktree on `work/chat-<id>`, the same worktree the answer above opens, moves the chat there once, and then the level applies there. If the worktree cannot be opened, the level is not changed and the chat says why. A repository chat already in its worktree applies the level there directly. With `workIn` `branch` the level applies in the main clone as it is. `ask` and `plan` never open a worktree; `ask` in the main clone keeps the worktree question for a write. A bot chat at any level works in the bot's own directory directly; no worktree is opened for it.

### D4: A chat reaches operad through MCP tools, not the shell

A chat calls plugins through operad's MCP tools, not by typing `operad` commands in a shell: the read tools of `operad mcp`, the plugins' verbs, and the actions on the allowed list are attached to the harness (claude and radian over stdio MCP; pi as `customTools`). A bot chat looks at tasks, opens a task and asks why a task is stuck through them, and never edits a repository's files itself; a repository chat is the same.

### D5: A chat is created by its first message

A client starts a chat by choosing a parent (a bot or a repository) and an agent, and opens an empty chat page; the chat is created only when the first message is sent, so opening without speaking leaves no empty chat. The creating actions (`dev:chat`, `bot:chat`) therefore accept the first message and create the chat and send it in one action; with no title given, the title is the start of the first message. These actions declare that what they create is a chat (ADR 0018 D2), so a client puts them only at the chat's own entry and the repository and bot pages have no Chat button. The command line may still run `dev:chat` without a message.

### D6: One chat can have several channels

A channel conversation (such as a Telegram chat, ADR 0033) bound to an operad chat sends its messages into that chat, and replies go back to the channel the message came from; every client sees all of it. By default there is one operad chat per (channel, chat) pair, created on the default bot. A chat created in the app is bound to no channel.

### D7: A repository chat reads the repository's skills

A repository's `dev.json` lists the skill directories its chats read, relative to the repository, defaulting to `.agents/skills`; an empty list gives them none. A path that leaves the repository is refused. A directory of skills, or a `.agents` directory, expands as for a bot (ADR 0030 D1), so a repository with `.agents/skills` needs no setting. The chat reads them at every reply, from the main clone while it is read-only and from its own worktree once it has one, so a skill changed on a branch is the one that branch's chat uses. In the main clone the agent may read a skill directory but not change it; in the chat's worktree it changes a skill like any other repository file, and the change reaches main through a task. Task workers do not get these skills.

### D8: A repository chat starts with the repository's agent files

A repository chat hands the repository's instruction files to its agent itself; the harnesses still discover nothing (ADR 0023 D3, ADR 0024 D4). `dev/chat_settings` returns, beside the working directory, access profile, skills and MCP servers, the text a new session starts with. `chat/reply` puts it before the person's first message when the chat has no session yet, and not again in that session. When the working directory of a reply differs from the one the session's text was built for, the next message is preceded by the first part alone, so a chat that moved to its worktree no longer reads the read-only wording. The chat plugin does not interpret the text, and a chat whose `refresh` step
returns no context gets none. A bot chat starts with one line telling its agent
that a schedule it writes is a proposal (ADR 0030 D11).

The text is built by `dev` from the working directory the reply uses: the main clone while the chat is read-only, the chat's worktree once it has one. It has three parts. First, where the chat is: the repository's name and working directory; the read-only wording in the main clone, or the worktree and its branch; the commands the access profile refuses, and, when `operad` is among them, that the agent uses the operad tools it was given. Second, the repository's instruction file in full: `AGENTS.md` at the root of the working directory, else `CLAUDE.md`; a link to the other counts once. A file over 32 KB is cut at a line end, with a line saying it was cut and giving its path. Third, the other agent files by path only: every other tracked `AGENTS.md` below the root, and the files under the root `.agents` directory outside a skill directory the chat already loads. At most 50 paths are listed; a line says how many more were left out.

Nothing outside the repository is read: no user instruction file, and no path that leaves the repository through a link. The file names are fixed, not settings. The text goes to the agent, not onto the screen, so the transcript shows the person's message as it was sent and no new user-visible word is added.

### D9: A chat's skills are listed and typed as `/name`

A chat's skills are the ones its creating plugin gives it: a bot's list (ADR 0030 D1), read as it is now, or a repository's list (D7), from no new source. The chat's view carries them beside its actions, so one `GET /v1/objects/<id>` and one MCP `show` give the commands and the skills together. Each entry has the skill's name and the description from its `SKILL.md`, on one line and cut to the cap ADR 0022 D9 uses, in the order the skill directories are given. A skill whose `SKILL.md` or name cannot be read is left out, as the harness list leaves it out.

A message that starts with `/name rest`, where `name` is one of these skills, is an ordinary turn to the agent, not a command, unless an operad command of the same name exists: the command wins and the skill yields. A harness that declares `loadsSkills` gets the line unchanged. Any other harness gets the skill's `SKILL.md` body in that message, after a line naming the skill and before `rest`, inside the prompt the chat already builds; the transcript keeps the message as the person typed it. An unknown `/name` stays an ordinary message as ADR 0037 D2 says. `/help` lists the skills after the commands, each marked as a skill; a skill whose name is a command is left out because the command wins.

### D10: A client with no chosen parent opens the default bot's new chat

The default bot always exists (ADR 0030 D1), so a client that opens without a chosen parent starts a new chat there rather than on a list: the agent is the bot's configured agent, else the first loaded agent, and the first message still creates the chat (D5). The `operad` command with no arguments is this entry; it creates the home when there is none and starts `serve` when none answers before it shows the chat's input. The desktop and iOS apps open the same chat when no chat is chosen. The starting chat is a chat like any other, so this adds no user-visible word.
