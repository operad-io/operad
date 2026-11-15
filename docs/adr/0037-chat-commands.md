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

`chat:help` is a command action. It lists every command this chat has, each under the name it is typed by, with the one-line description from the same action declaration. `/model`, `/effort`, `/close`, `/stop`, `/retry`, `/status` and `/help` are declared as commands.

### D5: `/stop` stops the reply being written

`chat:stop` cancels the reply run of this chat through the plugin's run control. What was written so far stays as a `stopped` entry (ADR 0027 D2), shown as stopped. Messages that arrived during the reply stay unanswered and no new reply starts by itself; the command's line says so and says `/retry` answers the last message. With no reply running it says so and changes nothing. The run control reports whether it cancelled a run, so a plugin can tell those two cases without a second run lookup; the kernel gains no new concept. The action is a command and appears in the chat's actions; its button word is "Stop".

### D6: `/retry` answers the last message after a failed or stopped reply

`chat:retry` starts a reply again when the last attempt failed or was stopped. The failed or stopped attempt stays in the record, and the new reply continues the chat's session. When the last reply finished normally, or the last attempt neither failed nor stopped, it refuses with a line saying so and starts nothing. A retry of one attempt starts one reply, so repeating the command before that reply begins does not answer twice. It is a command and appears in the chat's actions.

### D7: Telegram shows the commands as a menu and a choice as buttons

A command is typed into a Telegram chat as any other text, with the bot's name allowed after the command's name (`/model@operad_bot sonnet` is `/model sonnet`), and its text reaches `chat:send`, so the `chat` plugin still handles every command. The plugin registers the chat's commands with `setMyCommands` at start and again when the set changes: the name typed after `/` and the one-line description from the same action declaration. A name Telegram's menu cannot take (lowercase letters, digits and underscores, at most 32 characters) is left out and logged; it still runs when typed. Telegram's own `/start` gets a short greeting that points at `/help` and starts nothing. A command typed before the person has a chat opens one on the bot, as a first message does, so `/help` works from the start.

A command whose one argument is a choice (an `enum` in the action's schema, such as `/model` and `/effort`) sent without it answers with the choices as an inline keyboard, paged when they do not fit, instead of running. A tap runs the command as `/<name> <choice>` through `chat:send`; the keyboard goes and the message is edited to `chosen: <choice>`, as an answered pending item's message is edited to `answered: <choice>`. What a typed command returns is sent to the Telegram chat in a reply's shape. Only a listed user's command runs, as with a message: one from anyone else is dropped without a reply.

### D8: `/status` says where the chat stands and what it has used

`chat:status` is a command action. It reads the chat's facts only, costs no tokens and works while a reply is being written. In a few short lines it shows the agent, the model and effort in force, whether a reply is being written and since when, how many messages wait, the cost and token usage of the session so far, and the usage of the last reply. When the reply records its timings, the last reply line also shows its time to first output. A number an agent did not report, such as a cost, is said to be unknown and is never shown as 0. It is a command and leaves one transcript line like every other command.

### D9: An ordinary message sent during a reply is interjected

A message that is not a command and arrives while a reply is being written is handed to the agent in that same reply, after the tool calls already running. It does not interrupt the reply and does not start another round. The agent is given it only when its harness declares `takesMessagesMidRun`; an agent that does not (radian) leaves the message unanswered for the next round, as before. A message with an attachment also waits for the next round, where its images and files reach the agent as a first message's do; the mid-run inbox carries text only. A message is never delivered to the agent as a command: `/stop` and the other commands still run at once and never enter the reply. The message is recorded where it was sent and is marked answered by the reply it was given to; one the reply ended before the agent took waits for the next round, so it is neither lost nor answered twice. There is no `/steer` command.

### D10: The TUI lists a chat's commands in its input

On a chat's page, `/` opens its input with the commands listed from the same action declarations: the name typed after the slash, the one-line description, and the arguments the command takes, a choice showing its options. The list filters as the person types. Choosing a command fills the line; it does not run the action. Sending the line goes through `chat:send` like any text, so the same declaration decides whether it is a command. A line that names no command is sent as written. The `:` palette keeps listing every action; elsewhere `/` keeps its key meaning.
