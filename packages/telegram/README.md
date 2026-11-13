# @operad-io/telegram

The Telegram plugin: the first channel and the first outside source.

It is an optional plugin. `operad plugin enable telegram` adds it to the home's
`config.json`, and `operad serve` starts it.

```json
{
  "plugins": {
    "telegram": {
      "settings": {
        "users": [123456789],
        "bot": "default",
        "pending": []
      }
    }
  }
}
```

| key | default | meaning |
|---|---|---|
| `users` | `[]` | The Telegram user ids whose private messages become chat messages. A message from anyone else, and every group message, is recorded and starts nothing. |
| `bot` | `"default"` | The bot a chat is opened on when a listed user writes first. |
| `pending` | `[]` | The plugins whose pending items are also sent to Telegram. Items of a chat bound to Telegram are always sent. |

The Bot API token is the plugin's secret:

```sh
operad secret set telegram token
```

The token never reaches a fact, a log line or an error.

A listed user's first private message opens a chat on the configured bot and
binds it through the chat's `channels` (`telegram:<Telegram chat id>`); later
messages go to the same chat. A closed chat is replaced on the next message. One
user's messages never land in another user's chat.

The long-poll offset lives in `<home>/telegram/state.json`. Dedupe does not rely
on it: each update is recorded once as a `telegram` event keyed by its
`update_id`, and a message is written only when the bound chat holds no message
whose source ref is that update id. A killed `operad serve` that starts again
reads the same update without writing a second message or starting a second
reply.

Each new assistant reply of a chat bound to Telegram is sent to that Telegram
chat once. Markdown is reduced to what Telegram accepts (bold, italic, code,
links; headings and lists become plain lines) and a long reply goes out as
several messages. A failed send is retried with growing waits; when it gives up,
the plugin records a `telegram/send_failed` event for the chat (in the run log's
inputs) and writes a line in its own log; the chat's messages are not touched.
The event does **not** show in `operad history` of the chat or in the chat's History
section: those list only the chat's runs and the actions people ran on it, and read
no source event. Showing it there needs a kernel change. What was sent is kept in `<home>/telegram/sent.json`,
so a restart neither resends a reply nor skips one written while it was down.
Replies from before the plugin first ran are not sent. Tool calls are not sent.

## What waits for a person

An item waiting in a chat bound to Telegram goes to that Telegram chat. An item
of a plugin listed in the `pending` setting goes to every user in `users`.
Nothing else is sent, so `dev`'s items stay out until `pending` lists `dev`.
Each item is one message with one button per option. An action that needs a
note (such as reject) has no button: reply to the item's message and the reply
is the note (with several such actions, begin the reply with `reject:`). A
question with no choices is answered the same way, by replying; text that is not
a reply stays an ordinary chat message. Only a listed user's tap or reply
counts, and it is given through the client API with the actor
`{ via: "telegram", id }`. A tap on a button whose action asks to confirm counts
as the confirmation. After an answer from anywhere the buttons go and the
message ends "answered: X", X being the action or choice; a tap on an item
already answered says so and changes nothing. Where an item was answered
somewhere else and no action shows what it was, the message ends "answered".
What was sent is kept in `<home>/telegram/pending.json`.
