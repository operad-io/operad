---
description: The Telegram plugin: talk to a bot chat from Telegram and answer what waits for you there.
---

# Telegram

The `telegram` plugin lets you write to a bot from Telegram and answer there what
waits for a person. A message you send opens a [chat](chats-and-bots.md) on a bot;
the bot's replies come back to Telegram; a question the agent asks arrives as a
message with one button per choice. It is optional and works only while
`operad serve` runs.

## Why it exists

The phone app and the terminal are not always at hand, and Telegram is. The plugin
puts the same chat and the same pending items in a conversation you already keep
open. Nothing is a copy: the chat is the chat the app shows, and an item answered
in Telegram is answered everywhere.

## Set it up

1. In Telegram, talk to BotFather and create a **new bot** for operad. Do not reuse
   a bot some other program already uses: Telegram lets only one client pull
   updates for a token, so two programs on one token take messages from each other
   and one of them stops working.
2. Find your own numeric Telegram user id. A bot that reports it (such as
   `userinfobot`) is run by a third party, who sees what you send it; the id is
   also in the `from` field of any update the Bot API gives your own bot.
3. Enable the plugin and store the token as the plugin's secret:

   ```sh
   operad plugin enable telegram
   operad secret set telegram token
   ```

   The token never reaches history, a log line or an error.
4. Write your user id in `config.json` (see [Settings](#settings)) and start
   `operad serve`.
5. Send the bot a message in a private chat. A chat opens on the bot named by `telegram.bot`
   (`default` unless you change it) and the reply arrives in the same Telegram chat.

```json
{
  "plugins": {
    "telegram": {
      "settings": {
        "users": [123456789],
        "bot": "default",
        "pending": ["dev"]
      }
    }
  }
}
```

## Settings

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `telegram.users` | array of integers | `[]` | Telegram user ids | When `operad serve` starts | Refused by the schema; an unlisted user is recorded and starts nothing |
| `telegram.bot` | string | `"default"` | a bot name from the `bot` section | When `operad serve` starts; used when a listed user writes first, and again after their chat is closed | Refused by the schema; a bot that is not written is refused when the message opens the chat |
| `telegram.pending` | array of strings | `[]` | plugin names, such as `dev` | When `operad serve` starts | Refused by the schema |

The secret is `token`, set with `operad secret set telegram token`.

## What a listed user can do

A user whose id is in `telegram.users`, writing in a private chat with the bot:

- Writes to a chat. The first message opens a chat on the `telegram.bot` bot and
  binds it to that Telegram chat; later messages go to the same chat. Each listed
  user has a chat of their own. When the chat is closed, the next message opens a
  new one. The message is yours: it counts as written by you, with your Telegram
  user id as the sender, and the history of a run says which Telegram message
  started it.
- Answers a question by tapping a button. A tap counts as your answer, given as
  your Telegram user id, and as the confirmation when the action asks to confirm.
- Answers an item that needs words, such as a reject or a question with no
  choices, by replying to its message. With several such actions, begin the reply
  with the action's name and a colon, such as `reject:`. Text that is not a reply
  to such an item is an ordinary message to the chat.
- Answers the items of the plugins in `telegram.pending`. With `["dev"]` the
  `dev` plugin's merge and confirm items are answerable from Telegram.

Everyone else can do nothing. A message from a user who is not listed, and every
message in a group, is recorded and answered with nothing: no chat opens and
nothing starts. A tap from an unlisted user counts for nothing.

## What is sent

- Each reply of a chat bound to Telegram. Markdown is cut down to what Telegram
  shows (bold, italic, code, links; headings and lists become plain lines), and a
  long reply goes out as several messages. A failed send is tried again with
  growing waits. Replies written before the plugin first ran are not sent.
- The typing indicator. While a reply of a chat bound to Telegram is being
  written, that Telegram chat shows the bot as typing; it stops when the reply is
  sent or the run ends, fails or is cancelled.
- Each item waiting in a chat bound to Telegram, and each item of a plugin listed
  in `telegram.pending` (to every listed user). It is one message with a button for
  each choice. After an answer from anywhere (Telegram, the app, the command line)
  the buttons go and the message ends `answered: X`, X being the choice. A tap on an
  item that was already answered says so and changes nothing.

Tool calls and the live text of a reply are not sent. The chat shows them in the
app.

## Restarting

The plugin keeps what it has read and sent under `<home>/telegram/`. If `serve` is
stopped and started, no message is written twice, no reply is sent twice and none
is skipped.

## When it does not work

- `the telegram plugin has no token`: run `operad secret set telegram token`.
- The bot answers nobody: the id is not in `telegram.users`, or the message was in
  a group.
- Messages from the bot stop coming and another program uses the same token: make a
  bot of its own for operad.
