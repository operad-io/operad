# ADR 0033: The Telegram Plugin

Status: accepted

## Background

Telegram is the first channel and the first outside source, and in operad's eyes it is two things in one plugin: it sends pending items and replies out (a channel), and turns a person's messages into events (a source). It runs inside `operad serve`, sees changes of pending items directly and answers through the same client API as the app. A single long-polling `getUpdates` consumer is allowed per token, and the Telegram plugin of Claude Code on the owner's machine already holds one, so operad needs a separate Telegram bot.

## Decisions

### D1: No card object in the first channel

`telegram` is an in-process plugin; it watches pending items directly and answers through the existing action interface. A persistent card object (version, claiming a card, reporting delivery) is not built until a second channel needs it. Idempotence holds anyway: a pending item can be answered only once, and the action interface refuses the second answer.

### D2: The plugin gets the client API

A plugin started by `serve` (`start(ctx)`) receives, besides `emit`, the client API (`list`, `get`, `section`, `events`, `act`, plus `pending` and `answer`), the same one HTTP and the TUI use. `act` and `answer` must carry an `actor` (`{ via: "telegram", id: <Telegram user id> }`, ADR 0007 D2). `answer` answers a wait that has no object action (what the agent asks in a chat, a free-text answer); a pending item that has actions still goes through `act`. The kernel opens no separate interface for channels.

### D3: Source side

The plugin long-polls `getUpdates`, and for each message calls `ctx.emit` with `source: "telegram"`, `key` the `update_id` and `object` the bound chat's id; one `update_id` is recorded once. The `offset` is kept in the plugin's own state file, and deduplication relies on the event's `key`, never on the `offset`. There is no public webhook, so signature checking does not arise.

### D4: Settings and secret

The plugin is `telegram`. The token is the secret `token` (`operad secret set telegram token`) and never enters a fact or a log. The settings are `users` (the Telegram user ids allowed to use it), `bot` (the bot used to open a chat automatically, default `default`) and `pending` (which plugins' pending items are also sent to Telegram besides the bound chats', default empty; `["dev"]` lets merge and confirm be answered in Telegram).

### D5: Binding is automatic

The first time a listed user writes to the Telegram bot in a private chat, the plugin opens a chat on the configured bot and binds this private chat to it; later messages go into the same chat. When that chat is closed, the next message opens a new one. Each listed user has a chat of their own. Only private chats are served: no groups, and no action to bind an existing chat or to change the bot.

### D6: Messages of listed users count as made on the spot

A message from a listed user counts as started by a person on the spot (in the sense of the access profile's rule on runs nobody started on the spot, ADR 0025); the input carries the `actor`. A message from someone not listed is only recorded: no reply, no chat, nothing started.

### D7: What is sent

Each new reply of a chat bound to Telegram is sent to that Telegram chat once. Pending items are sent: every question in a chat bound to Telegram, and the pending items of the plugins listed in `pending`. Live progress (the stream of tool calls) is not sent. Markdown is reduced to what Telegram accepts, and a long reply is split into several messages; this is done inside the plugin.

### D8: How a pending item is answered

An option is a button (an inline keyboard, one per option). An action that needs a reason (reject, a free answer) is answered by replying to the item's message, and the reply is matched by `reply_to`; plain text sent against an item with buttons is not an answer but an ordinary message to the chat. A channel secret alone cannot do owner actions: the answer is a person's, and the plugin only passes it on, which needs the sender to be listed. When an answer arrives, the buttons go and the message is edited to "answered: X"; an item answered elsewhere (the phone, the command line) is edited the same way on Telegram.
