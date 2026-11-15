# ADR 0037: Chat Commands

Status: accepted

## Background

A chat takes text from the app, the desktop app, the terminal, Telegram and the command line. A person who types `/close` or `/model sonnet` expects an action, not a question for the agent. A separate command system would be another thing every client and every plugin had to learn, and an action already names what a person can do.

## Decisions

### D1: A chat command is an action that declares `command`

An action may carry `command`, a one-line description. Its presence is what lets a chat run the action as `/<name>`; the name is the part of the action name after the colon, so `chat:model` is `/model`. When two plugins declare the same short name on a chat, the `chat` plugin keeps it and the other plugin is typed as `/<plugin>_<action>`. The action list over HTTP and MCP carries `command`, so a client builds its `/` menu from the same declarations and names no plugin.

The rest of the line is the action's arguments, positional in the order the action declares its fields. One field takes the rest of the line; with more than one, the last field takes what is left. An action with `confirm` runs only when the text after the name is `yes`; otherwise its line says to send `/<name> yes`.

### D2: `chat:send` runs a command instead of recording a message

When the whole message starts with `/` and names a command this chat has, `chat:send` runs that action and records no `chat.message`; no message event starts a reply. An unknown `/xxx`, or a slash inside the text, is an ordinary message. A command works from every source because it is handled in `chat:send`, not in a client.

A command runs at once while a reply is being written: it does not wait for the reply and does not start one.

### D3: Every command leaves one transcript entry

The command and its outcome are one `chat.command` fact: who typed it, the line as typed, the outcome or the reason it was refused, and whether it ran. The transcript shows it in one shape for every command, so no client changes. It is not a message, so it is never part of what the agent is given and is never answered.

### D4: `/help` lists the chat's commands

`chat:help` is a command action. It lists every command this chat has, each under the name it is typed by, with the one-line description from the same action declaration. `/model`, `/effort`, `/close` and `/help` are declared as commands.
