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
