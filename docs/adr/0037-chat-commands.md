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

`chat:help` is a command action. It lists every command this chat has, each under the name it is typed by, with the one-line description from the same action declaration. `/model`, `/effort`, `/close`, `/stop`, `/retry` and `/help` are declared as commands.

### D5: `/stop` stops the reply being written

`chat:stop` cancels the reply run of this chat through the plugin's run control. What was written so far stays as a `stopped` entry (ADR 0027 D2), shown as stopped. Messages that arrived during the reply stay unanswered and no new reply starts by itself; the command's line says so and says `/retry` answers the last message. With no reply running it says so and changes nothing. The run control reports whether it cancelled a run, so a plugin can tell those two cases without a second run lookup; the kernel gains no new concept. The action is a command and appears in the chat's actions; its button word is "Stop".

### D6: `/retry` answers the last message after a failed or stopped reply

`chat:retry` starts a reply again when the last attempt failed or was stopped. The failed or stopped attempt stays in the record, and the new reply continues the chat's session. When the last reply finished normally, or the last attempt neither failed nor stopped, it refuses with a line saying so and starts nothing. A retry of one attempt starts one reply, so repeating the command before that reply begins does not answer twice. It is a command and appears in the chat's actions.

### D7: `/status` says where the chat stands and what it has used

`chat:status` is a command action. It reads the chat's facts only, costs no tokens and works while a reply is being written. In a few short lines it shows the agent, the model and effort in force, whether a reply is being written and since when, how many messages wait, the cost and token usage of the session so far, and the usage of the last reply. When the reply records its timings, the last reply line also shows its time to first output. A number an agent did not report, such as a cost, is said to be unknown and is never shown as 0. It is a command and leaves one transcript line like every other command.
