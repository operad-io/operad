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
(`replyTo`), the run it belongs to (`runId`), the session after it and, when its
harness reported them, the token usage (`tokens`), the context it ended with
(`context`: the last model call's input plus cache read and cache write, and the
model's `window` when known) and the step's three durations (`timings`: start to
ready, ready to first increment, and the whole step). The
chat carries the cost (`costMicros`, with `costQuality`) and tokens summed from
its replies; a total missing some replies is marked incomplete for the cost and
for the tokens. Closing a chat appends a `chat.closed` fact and marks the object
closed; the messages stay in its transcript.

What the agent did during an answer is recorded too, as `chat.entry` facts with
the same `runId` as the reply: intermediate text, thinking, a tool call (its call
id, name, input summary, result, start, duration, the first 4 KB of its output,
the file holding the whole output and the first line of an error) and the
half-written reply of a run that was stopped. A reply that fails records one
`failure` entry instead of a reply: one plain line saying the reply failed and
why, with the provider's message masked and cut to a sensible length. A reply
that ends with no text, no usage and no error ended without calling the model,
and the line says that, with the agent's own reason when it gives one (for
`claude`, the result's subtype, its errors and a local command the session ran).
A failure entry keeps its reason and the oldest message the attempt was for. Increments
are not stored. Output longer than 4 KB goes to a file under the chat's own
directory (under `attachments/chat/<id>/tool-output/`), and secret values are
masked before a fact or a file is written. A rerun skips a tool call whose id was
already recorded and does not add the same unfinished text again. A rerun of one
run adds no second failure line; each failed run records its own line.

Each reply run also records a `chat.run` fact with its run id, so the transcript
can find the log of the step that runs the agent. While that run lasts, the
`transcript` section returns a `tail`: the text and thinking being written, the
tool calls that started and did not end, and a finished entry until the same
read can show its fact, all read from the appended part of that log, with secrets
masked. An entry leaves the tail only when its fact is visible in `markdown`, so
the reply never disappears between its last log line and its fact. It also
returns `mark`, and a read with `after: <mark>` returns only what was recorded
later.

## `chat:send <chat> --note <text>`

Records the message and sends the event `message` from the source named by the
client (`ios`, `telegram`, `cli`; any other client counts as `cli`), keyed by the
message id and about the chat. Three default rules start `chat:reply` with `auto`
on that event. A closed chat refuses the action and adds no message.

## Queued messages

A message is queued from when it is sent until a run takes it. A run takes the
messages of its first prompt when it starts, and each message an agent takes
mid-run when the inbox hands it over. A taken message stays taken, even when
the attempt fails and a later run answers it. The fact `chat.taken` records the
messages a run took; it is written before the agent starts or the message is
handed over.

The chat object keeps the queue of its messages in `queued`; the row returns it
as `data.queued` with `data.queuedCount`, and has neither field when the queue is
empty. The `transcript` section returns the same data on every read. Each entry
has `id`, `text`, `at` and `attachments`.

`chat:withdraw <chat> --message <id>` records a `chat.message_change` fact of
kind `withdraw`; the message leaves the transcript and is never part of a
prompt, and the transcript shows one history entry saying it was withdrawn.
`chat:edit <chat> --message <id> --text <text>` records one of kind `text`; the
transcript and the next prompt use the new text, and the attachments stay.
Both refuse a message a run has taken with a line naming it. A take and either
action take one lock per chat, so a message is never both taken and withdrawn or
changed. Neither action is a chat command.

## Commands in a chat

An action with `command` set to a one-line description can be typed after `/`.
`chat:model`, `chat:effort`, `chat:access`, `chat:close` and `chat:help`
declare it, so `/model sonnet`, `/effort high`, `/access full`, `/close` and
`/help` work in every chat. The
name is the action name after the colon. When another plugin gives a chat an
action with the same short name, `chat` keeps the short name and the other is
`/<plugin>_<action>`.

`chat:send` checks the whole message: when it starts with `/` after leading
whitespace and names a command this chat has, it runs that action with the rest
as arguments and records no message for the agent. A `/xxx` that names no command, or a slash
later in the message, is an ordinary message. Arguments are positional in the
order the action declares its fields: one field takes the rest of the line, and
with more than one the last takes what is left. An action that asks to confirm
runs only when the rest of the line is `yes`, so `/close` asks for `/close yes`.
A command runs at once while a reply is being written, does not wait for it and
does not start one.

Every command appends one `chat.command` fact: who typed it, the line as typed,
the outcome or the refusal, and whether it ran. The transcript shows it as one
entry; it is not a `chat.message`, so `promptFor` and the agent never see it.

`/help` lists this chat's commands that can run now, with the one-line
description from each declaration, under the name the chat types it by. It then
lists the chat's skills, marked as skills.

## Skills in a chat

A chat's view carries the skills this chat can use beside its actions:
`GET /v1/objects/<id>` and MCP `show` return `skills: [{ name, description? }]`
with the commands, so one request gives both. A bot chat lists its bot's
current skills; a repository chat lists the skills its `dev.json` gives it. Each
name and description comes from the skill's `SKILL.md`, the description cut to
the same length as the harness prompt list (160 characters, then `...`), and the
order is the order of the given skill directories. A skill whose `SKILL.md` or
name cannot be read is left out. The view carries no paths and no bodies.

`/name rest`, where `name` is one of these skills, is an ordinary message to the
agent, not a command; an operad command of the same name wins, so a skill never
shadows `/model` or `/help`. A harness that declares `capabilities.loadsSkills`
gets the line unchanged (`/name rest`) because it loads the skill itself. Any
other harness gets the skill's `SKILL.md` body in the prompt, after a line
naming the skill and before `rest`. The message fact keeps what the person typed,
so the transcript shows `/name rest`; the body is prompt text, never recorded.
An unknown `/name` is an ordinary message as before. An ordinary message sent
during a reply is expanded the same way before it reaches the agent.

## `chat:stop <chat>`

Stops the reply being written. It asks the plugin's run control to cancel the
run of the chat's latest `chat.run` fact; the control says whether it cancelled
an active run, and a successful stop records a `chat.stop` fact naming the run.
What was written so far is recorded by the interrupted path as a `stopped` entry
and shown as stopped. Messages that arrived during the reply and were not handed
to the agent stay unanswered and no new reply starts by itself; those it took
stay answered. The command line says so and says `/retry` answers the last
message. With no reply running, or with one that had
already ended, it says so and changes nothing. Its button word is **Stop**.

## `chat:new <chat>`

Starts a new agent session in the chat (`/new`). It records a `chat.new` fact
and clears the chat's session reference, and ends the chat's kept worker. The
reply after it passes no `resumeSession`, so each agent starts a session of its
own: `pi` creates a new session file, `claude` starts without `resume`, `codex`
starts a thread (`thread/start`, not `thread/resume`) and `radian` runs without
`--resume`. The transcript stays, the `context` view is empty until the next
reply, and the bot's memory notes ride on that reply as on any new session.
With a `goal`, the `chat.new` fact carries it and the old session's reference, and a reply round
builds a brief first: one call resuming the old session (read-only, no tools), recorded as a
`chat.brief` fact with its cost and as one `/new` tool line. The brief and the goal ride on the
first reply of the new session only; a failed call leaves the goal alone. Refused while a reply is
being written.

The first message after it also carries a short pointer (`[Earlier record of this
chat]`, after any memory notes) telling the agent the earlier record exists: read
it with the `section` tool (`chat:<id>`, `transcript`) and search it with `search`
(scope `chats`, a bot chat) then `read`. The person does not see it. It repeats if
that reply fails and is retried, and not after the first reply. A compaction
(T-0766, not yet on main) does not carry it yet.

## `chat:retry <chat>`

Answers the last message again when the last attempt failed, was stopped or was
interrupted by a serve stop, restart or crash, and no reply is being written: it
sends one message event, keyed by that attempt's run id, so a repeated command
before the reply begins does not answer twice. The failed, stopped or
interrupted attempt stays in the record and the new reply continues the chat's
session. It is offered only when it would start that reply: the chat is open, a
message waits for a reply, the last attempt failed, was stopped or was
interrupted, and no reply is being written. Otherwise it is not among the chat's
actions and its `why` says why; a stop records its fact before the stopped half
reply enters the record, so a retry works at once after `/stop`. One rule
decides the offer and the run, and the run checks it again because a reply may
start in between. Typing `/retry` when it is not offered answers with the same
refusal line as before and starts nothing; a reply being written is the one new
line.

## `chat:compact <chat>`

Compacts a `pi` chat's context now (ADR 0037 D12); it is offered on an open
chat whose agent is `pi` and nowhere else. It records a `chat.compact` request
and, when no reply is being written, sends a message event keyed `compact:<id>`;
a reply being written goes round once more when it ends. A round with no message
waiting passes `compact.only` to the agent and writes no reply; one with a
message waiting answers it with `compact.now`. The reply step marks the request
taken before the agent starts. A pi reply always passes `compact.at` (0.75), and
a chat with memory notes adds the flush turn's text; when the step's data says
`compacted`, one `chat.command` line says so (`compact (automatic)` after a
reply, `compact` after the command) and the notes ride whole on the next message.

Each compaction also records a `chat.compact` fact of kind `compacted` whose
`full` is true when the context it left is at or over `COMPACT_AT` of the
window (`stillFull`; false when the window or the size after is unknown). While
the latest such fact since the last `/new` is full (`chatTooFull`), a reply with a
message waiting fails with reason `full` and the line `CHAT_TOO_FULL_LINE` before
any agent is started, so two compactions never run without `/new` or a fitting
compaction between them.

## `chat:status <chat>`

Reads the chat's facts and asks the run control whether the latest run is still
active, so a run a crash left is not called writing. It costs no tokens and works
while a reply is being written. It returns a few short lines: the agent, the model and
effort in force, whether a reply is being written and since when, how many
messages wait, the session's cost and token usage, and the last reply's cost,
token usage and, when its `timings` hold both parts, its time to first output.
A number an agent did not report is `unknown`, never 0. When some replies
reported a number and others did not, a session total is marked partial.

## `chat:model <chat> --model <name>`

Changes the model the chat's next reply uses. The argument is one of the models the chat's agent lists (its plugin declares them); a closed chat, or an agent that lists none, does not offer the action. A `chat.model` fact records who changed it, from what and to what. A chat whose model its agent cannot take fails the reply with a message naming the model; it never falls back to another one.

## `chat:effort <chat> --effort <level>`

Changes the effort the chat's next reply uses. The argument is one of the levels the chat's agent lists (its plugin declares them; pi's thinking levels are its efforts); a closed chat, or an agent that lists none, does not offer the action. A `chat.effort` fact records who changed it, from what and to what. A chat whose effort its agent cannot take fails the reply with a message naming it; it never falls back to another one. The row shows the effort when it is not the agent's default.

## `chat:access <chat> --level <level>`

Changes how much the agent may do without asking in this chat: `plan`, `ask`, `edits` or `full`, typed as `/access <level>`. A closed chat does not offer it. A `chat.access` fact records who changed it, from what and to what, and every call of a reply from then on uses the level, including a reply already being written; a question open when it changes is checked again under the new level. It prints `chat <id> now uses access level <level>; replies follow it`. The starting level comes from the plugin that created the chat (a bot chat starts at `ask`, except one a scheduled prompt opens, which starts at `full`; a repository chat starts at `plan`); the row shows the level when it is not that starting level. A chat whose creating plugin names an `accessAction` runs it with the new level before anything is recorded; a failed action refuses the change and leaves the level as it was. A repository chat uses that action to open its worktree before it becomes writable, while a bot chat has none and works in its own directory. The action's information gives every level its approved words and a short description; `full` says that it skips every question while a deny still refuses and a read-only working directory still asks. Every reply composes the chat's profile with the level through `@operad-io/access-match`; `claude` and `pi` carry every level, while an agent that declares no level refuses the reply at its start with a message naming the level.

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
are some its result is `more` and the flow runs it again. Each unanswered message
is its own block in the prompt, separated by a blank line and `---`, so two
messages never read as one and a message that starts with `/` is text to the
agent rather than one of its commands. A refresh step may also name `notes`:
files whose whole text rides on the message as `[name]` ... `[End of name]`.
The first message of a session and the first after a compaction carry them all;
later replies carry only a file whose hash differs from what this session last
saw, and a change the reply itself wrote is not sent back. The hashes are the
chat object's `noteHashes`, so a restart keeps them, and a note with `maxChars`
is cut with a line saying it was cut. A chat whose refresh step names no notes
gets none (ADR 0026 D18). A failed reply leaves its messages
unanswered for the next reply, as ADR 0026 D14 says; an empty failure twice in a
row for the same oldest message records that message as taken, so it is not sent
a third time. The flow's `maxVisits`
(20) ends a loop that never catches up. A question that ran out of grace ends the
step `waiting`; the answer comes back with the session.

When the chat's agent declares `capabilities.takesMessagesMidRun` (`claude`,
`pi`, `codex`), the step passes it an inbox. A message that arrives while the
reply is being written is handed to the agent at once, after the tool calls
already running, and the reply's `replyTo` names it, so that reply answers it and
no next round does. A message with an attachment waits for the next round, where
its images and files reach the agent as a first message's do; the inbox carries
text only. A message the attempt took is recorded as answered even when the
attempt ends waiting, fails or is stopped; a harness answers false when it can
no longer take a message, so one the run ended before queuing waits. A message
that arrives after the harness has returned stays unanswered and the next round
answers it. An agent without the capability (`radian`) gets no inbox and keeps
the next-round behaviour. A command is never
a message fact, so it is never handed to the agent.

The agent gets `operadTools: { home }`, so it calls operad through MCP tools and
never through a shell.

A `pi` reply turns pi's automatic retry on: a failed model request is tried
again with pi's own bounded backoff, and the live transcript carries a `retry`
item with the attempt, the time of the next try and the provider's reason (ADR
0027 D9). A task keeps pi's retry off and lets dev's own retry wait and
fallbacks decide. A successful retry removes the item; when the retries run out
the reply fails as usual.

A chat's access level is composed into the profile of every reply (ADR 0025
D8): below `full` the level adds its asks on top of the profile's own deny and
ask rules; at `full` the profile's asks and outward questions do not apply, while
a deny, `readOnly` and a write under `readPaths` remain.
In a repository chat whose profile is `readOnly` (its initial `plan` level, or
the main clone before its worktree), an agent question about a command, a write
or an edit becomes the worktree question. Its choices are
`Allow once`, `Always allow`, `Deny` and the worktree offer: `Allow once` runs
this call only, `Always allow` writes the exact call and working directory to
the user layer (ADR 0025 D7) and runs it, `Deny` refuses it, and the worktree
offer sends the event `chat.worktree`, which the plugin that owns the working
directory acts on (`dev` opens `work/chat-<id>`). The reply that asked ends at
once, and the same message is answered again in the worktree; a yes that comes
after the reply has ended opens the worktree but starts no second reply. The
transcript shows one line saying the chat now works in a worktree. A run no person's message started is offered no
`Always allow` and reads no user layer. The question names the call: the command,
or the path and whether it is a write or an edit; a long command is cut, and the
ask keeps the whole call. A `Deny` tells the agent the call was refused because
the chat is read-only, and that it should answer in the chat or use read-only
commands.

The agent's own question is not about a call, so it never becomes the worktree
question: `ctx.ask` with `questions` passes through the level check and the
read-only check unchanged. The pending item carries the form (ADR 0008 D7), and
the person's answers reach the agent in its harness's shape (ADR 0026 D6).

## The `transcript` section

A live section that pages over the message and entry facts, so the command line,
the TUI and the app show a chat with no client change. A turn's entries show
before its reply: one line per tool call with what ran and how long it took, how
a failed, blocked or denied call ended, the agent's text with its speaker, and
thinking as a block quote. A message the reply takes during the turn is ordered
with the entries by its time: entries whose time is earlier stay above it and
those whose time is later go below it. A message the reply does not take waits
for the next round and stays below the finished turn. A tool call's time is its
start; a text or thinking part's time is when its log line was received. An
entry with no time keeps the recorded order, so an older chat reads as before.
The message that started the turn stays above all its entries. A failed reply shows one line saying so and
why, for every agent including radian. A stopped half reply is shown as stopped. A
model request the agent is waiting to retry is a live `retry` item with its
attempt, the time of the next try and the provider's reason; it leaves the live
view when the retry succeeds or the retries run out. The Markdown shows no tool
output; `data.replies` carries the first 4 KB of it. Radian chats show the
tool lines only otherwise. Pages count messages, and a turn's entries stay on
the page of its reply. Every read also carries `data.replies`, the structured form of each reply beside the Markdown: the reply's input, its process grouped per turn, and its answer and duration when it finished. Its window is the read's: a page carries that page's replies, a read with `after` carries the replies finished since the mark and the one still running, and the pushed `tail` carries the running reply; a client merges by `runId`. A process group carries the category ids `read`, `edit`, `run`, `search` and `other`; a tool item carries its call id, name, input, start, duration, result, whether it failed, and its recorded output with its line count and, when the whole output was written to a file, the `/v1/attachments/...` address that serves it. The size cap counts the replies with the Markdown and tail; when they do not fit, tool output text is cut first, with its line count kept and `truncated` set, and only then is Markdown shortened. A `full` read leaves the replies whole. ADR 0027 D3 has the shape. Every read also carries `context: { used, window?, model? }`,
the last finished reply's context; a new session leaves it out until the next
reply. The chat's object view carries the same `context`. Every read also
carries `data.queued` and `data.queuedCount`, the messages a run has not taken.

Segments (ADR 0026 D21): each stretch that `/new` or a compaction starts is a
segment. The Markdown puts `### <title> · <date, UTC>` before
the first item of every segment but the first, and `data.segments` lists them
(`number`, `at`, `kind`, `title`, `cursor`) once there are two or more. The
cursor of a read may also be `segment:<n>`, `date:<YYYY-MM-DD>` or
`message:<id>`; the page starts there and `next` continues. A title is the goal
of `/new`, or one call after the segment's first exchange (`chat.segment_title`).

## The speaker

The transcript labels the model's messages with a speaker name, read each time
it is drawn: `plugins.chat.settings.speaker`, `Operad Bot` when not set. A
chat's parent object may carry a `speaker` of its own (a bot does), and that
name is used instead. Messages already recorded get a changed name too.

## The recap on return

`plugins.chat.settings.awayMinutes` (default 240; 0 turns it off): a message
written after this many minutes without the person's message or command is
followed by one `recap` message listing the routine results and the replies that
came meanwhile (ADR 0026 D21). It is not sent to the model.
