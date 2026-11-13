---
description: The phone app: pairing, tabs, notifications, chats, attachments, model and effort, and always allow.
---

# The phone app

The app reaches `operad serve` over [the HTTP interface](http.md) and shows the
same objects, pending items and history as the command line. It does not know
any plugin: a plugin's type gives a tab, an object page and actions, and the app
renders them.

## Why it exists

Work in operad often waits for a person: a question from a run, a review to
approve, a chat reply. The app lets you see that and answer it from a phone
instead of at the machine that runs `operad serve`. It shows the same objects,
pending items and history as the command line, and it can answer, run actions,
change settings, and hold chats with an agent. It does not know any plugin, so a
plugin you add shows up in the app without a new version of it. This repository
holds only the server side; the app itself is not part of it, and this page
describes what the app does through the interface.

## How it works

1. `operad serve` listens on the addresses in `http.listen`, and every request
   to it needs the bearer token kept in `$OPERAD_HOME/secrets/http.json`.
2. `operad pair` prints that address and token as a QR code that encodes
   `operad://pair?url=<url>&token=<token>`. You scan it in the app, which
   then reaches this `serve` with them. See [Pairing the app](#pairing-the-app).
3. The app reads `GET /v1/types` to learn which tabs exist, then fills them
   from `GET /v1/pending`, `GET /v1/running` and `GET /v1/objects`. See
   [Tabs](#tabs).
4. Opening a row calls `GET /v1/objects/<id>`: the row, its sections and the
   actions it offers now. The app draws what the plugin returned.
5. `GET /v1/events` keeps the screens current. When something starts waiting for
   a person the app receives a push; tapping it opens `OPERAD_LINK`, an
   `operad://objects/<id>` link. See
   [Pending and notifications](#pending-and-notifications).
6. Answers and actions go back as `POST /v1/answer` and `POST /v1/act`, files as
   `POST /v1/uploads`, and settings as `POST /v1/settings`; the server judges
   whether each is applied, and the app shows the reason when it is not.
7. If you rotate the token with `operad http token rotate`, the next request
   gets `401` and the app says the token was rotated.

## Pairing the app

`operad pair` shows what the app needs to reach this `serve`:

```text
url http://192.168.1.20:7480
token <the token>

Scan this in the operad app:

<a QR code>
```

The URL is `http://<address>:<port>` for the first non-loopback entry of
`http.listen`. Pass `--url <base url>` to name another address, such as a
Tailscale HTTPS name (`operad pair --url https://mac.tail1234.ts.net`); it must
be an `http` or `https` URL without credentials or a query. The QR code encodes
`operad://pair?url=<url>&token=<token>`. It needs `http.enabled` true, and with no
`--url` an address in `http.listen` that is not loopback. With the default `http`
values, `pair` says that `http.listen` has only loopback addresses and asks for
one or `--url`; it names `http.enabled` only when that is false.

`pair` is the one command that prints the token. It refuses when its output is
not a terminal, so a pipe or a log never receives it; `--show-token` overrides
that and prints `url`, `token` and the pairing `link` as plain lines, with no
QR code. If you paste the token anywhere, rotate it with `operad http token
rotate`; a running `serve` refuses the old token at once and closes the streams
opened with it.

The app reaches only addresses `serve` may listen on: loopback, a private
(`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local or Tailscale
address. A phone on the same network uses the private address; a phone elsewhere
uses Tailscale or `--url`. The token is required on every request; a missing or
old token is `401`, and the app says the token was rotated.

## Tabs

The bottom tab bar is:

- **Pending**: everything that waits for a person.
- **Running**: every run in progress.
- one tab per plugin's top-level object type: **Repo** for `dev`, **Chat** for
  `chat`.
- **Settings**: the server settings, and the objects a plugin puts under
  settings.

A type below the top level (a plan, a task) has no tab; it opens from its
parent's page, from Pending or from Running. The `bot` plugin has no tab: a bot
page is that bot's settings page, and bots appear under **Settings** in a
section named **Bots**.

An object page is the row (id, title, state, note, badge and mark), a progress
bar when the object has a next level, the child list, then the section tabs.
History is always the last section; there is no separate History tab. A live
section follows its end and shows new content; the transcript of a chat is one.
The bottom action bar has the first available action as the main button and a
`⋯` menu for the rest; an action that needs a note opens an input box, and a
`confirm: true` action asks in red. An action that opens an object (`opens`)
takes the app to that object.

## Pending and notifications

Pending is `GET /v1/pending`: the same list as `operad pending`. Each item shows
the object's title and row, the prompt, the choices and the actions it offers.
Answering a question is `POST /v1/answer`; running an action is `POST /v1/act`.
A choice that is also an action on the object runs the action, so its note and
confirmation apply. A closed question is `409` and is not applied; the app
shows the reason and refreshes.

The app receives a push when something starts waiting for a person; the
`notify` command is the command-line equivalent of that moment. Tapping it opens
`OPERAD_LINK`, which is `operad://objects/<id>` and opens that object's page.
The app does not receive a push for every state change; open the object or pull
to refresh for those. A wait that a plugin answers automatically is not
announced, so the phone does not buzz for a question that is about to answer
itself.

## Running

Running is `GET /v1/running`: the object, its title, the flow and step, how long
the step has run, how long the run has run, and whether it is queued. It is live
through the event stream. A run with no object shows its run id; a step that has
not started shows `-`.

## Chats

A chat is a long conversation with an agent. The **Chat** tab lists the chats
that are open, grouped by their parent (a repository or a bot); the `open` filter
is the default, and `closed` shows the closed ones.

### Starting a chat

The new-chat entry is on the Chat tab, not on a repository or bot page. It asks
for the parent (a repository or a bot), the agent, the model, the effort and a
title; the title is optional and is taken from the first message when it is
left out. The first message is what creates the chat: opening the new-chat page
and leaving without a message leaves no empty chat. The app calls the parent's
creating action (`dev:chat` for a repository, `bot:chat` for a bot) with those
arguments and the first message in one step, then opens the returned chat.

- **Agent**: `claude`, `pi` or `radian` when loaded. A repository chat offers
  only the agents that can stop a tool call before it starts (`claude` and
  `pi`), because it is read-only by default; `radian` is offered to a bot chat
  only. The agent cannot change after the chat starts; make a new chat to change
  it.
- **Model** and **effort**: the lists and defaults come from the chosen agent.
  An agent that lists none has no model or effort to pick, and the field is not
  shown. The chat can change its model or effort at any time; the change applies
  to the next reply.

The chat's row and page show the agent, and the model and effort when known.
The page also shows the accumulated cost when the agent reports one.

### The transcript and sending

The chat page is the `transcript` section plus the input box. Each user message
shows its text, its attachments and who sent it (`ios`, `telegram`, `cli`, ...).
The agent's reply and its process are shown as Markdown lines: intermediate
text, `Thinking`, tool calls with their result, duration and a short output, and
the final reply. Tool output is cut in the transcript; the full file is
available to the agent from the chat's directory. A run that is still replying
shows its unfinished text and thinking as a tail that updates; the finished
entries are already recorded, so reopening the chat does not lose them and a
restart of `serve` does not repeat them.

Sending is `chat:send` with `note` and the uploaded attachments. The app sends
the message, records it and starts the reply; a chat that is closed refuses the
message and says so. Closing a chat asks for confirmation (`chat:close`) and
keeps the transcript readable, but the chat takes no more messages and offers no
other actions.

### A repository chat is read-only

A chat on a repository works in the main clone, read-only. A shell command runs
there only when it is on the short list of commands that only read (`git
status`, `ls`, `cat`, `grep`, `sed -n`, `bun test`, ...); every other command,
and every write or edit, becomes a question that names the command or the path.
When the agent wants to change code it asks whether to open a worktree. A no
tells the agent that the call was refused because the chat is read-only and
that it should answer in the chat or use read-only commands. On yes, `dev` opens
`work/chat-<id>` and the chat works there from then on, once; the main clone
stays read-only. The worktree's changes reach main only through a task that
points at it, through the normal gate and integrate.

### A bot chat

A chat on a bot uses the bot's working directory, skills and access profile; the
bot's settings are read again at every reply, so tightening access or adding a
skill applies without a new chat. A bot chat can use the local MCP servers the
bot lists, if its agent takes MCP servers natively (`claude` and `radian` do;
`pi` does not yet). A server whose tools changed is not mounted until a person
approves the change in Pending.

## Attachments

The input box can send photos, camera images and files. The app uploads each one
with `POST /v1/uploads`, then passes the returned `ref` in the message's
`attachments`. A file is at most 20 MB; a larger one gets `413` with the limit.
The uploaded file moves into the chat's own attachment directory under the
operad home when the message is recorded, and the transcript links it through
`GET /v1/attachments/...`.

When the agent replies, an image the agent can read (`claude`, `pi`) is given as
image input, up to 5 MB each; every other file is given as a path the agent can
read. The chat's access profile gains read access to that chat's attachment
directory and nothing else. A message may be only attachments with no text.

## Always allow

When an agent asks to run a command or touch a path its access profile does not
allow, the question is a pending item on the chat. The choices are a one-time
allow, a one-time rejection, and, when the step offers it, `allow_always`.
Choosing `allow_always` writes an entry in `$OPERAD_HOME/access-user.json`:

| Key | Type | Value |
|---|---|---|
| `kind` | string | `command` or `path` |
| `value` | string | The exact command text, or the path as the call wrote it; a tool call is `mcp <server>.<tool>` |
| `cwd` | string | The working directory the call was allowed in |
| `tool` | string | For a `path` entry, the tool it allows, such as `write` or `edit` |

The next call is not asked again only when its kind, value and working directory
match exactly. A run no person's message started does not see the always-allowed
entries (see [Access](access.md)). To revoke one, delete its line from
`access-user.json`; a missing file is an empty list, and a file that cannot be
read is reported and treated as empty.

## Settings

The Settings tab lists the server settings `GET /v1/settings` returns, with the
current value, the default and whether it is editable. Changing one calls
`POST /v1/settings`; a setting that asks to confirm asks in the app, and a
refused value shows the server's reason and writes nothing. Settings that belong
to a repository are shown when that repository is the open scope.

Bots are under Settings, one page each. A bot page shows its working directory,
default agent, speaker, skills and MCP servers; its settings are edited through a
proposal, which appears in Pending and is applied only when a person approves
it. MCP servers are added with `operad bot mcp` and approved in Pending.
