---
description: The memory plugin: the shared wiki, a bot's memory and the git history of what a bot wrote.
---

# Memory and the wiki

The `memory` plugin gives a bot two places to keep what it knows:

- the **wiki**, one shared knowledge base every bot reads and some bots write;
- the bot's **memory**, a directory of its own inside its working directory.

Enable it like any other plugin:

```sh
operad plugin enable memory
```

The plugin owns one setting and one skill. The wiki is a Markdown directory with
a git history; the bot's memory has the same history, one repository per bot.

## The wiki

The wiki is a reserved directory that every bot shares. It is meant for notes
about the world that outlive a chat: a person may point it at their own notes
library, such as an Obsidian vault, and edit it there.

| Setting | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `memory.wikiDir` | string | `wiki` in the operad home, so `~/.operad/wiki` for the usual home | a directory; `~` is your home directory and a relative path is under the operad home | At the next bot reply and at the next `serve` start | Refused by the settings call with the schema's reason |

The directory is created when it is missing and made a git repository when it is
not one. A directory that is already a git repository is used as it is: it is
never initialised again and its files are never restructured. So pointing the
setting at an existing vault keeps that vault's history, branches and layout.

Who may write the wiki is each bot's access profile, not a global switch (see
[Access](access.md)). By default the `default` bot writes it and every other bot
only reads it. A bot's own setting changes that:

| Setting | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `bot.bots.<name>.writeWiki` | boolean | `true` for `default`, `false` for every other bot | `true` or `false` | At the next bot reply | Refused by the schema |

Read access is always there. A bot that may not write the wiki has the directory
refused for writing, not merely questioned, so a misreading cannot change a
person's notes by accident.

## A bot's memory

A bot's memory lives in `memory/` inside its working directory, so `default`'s
is `~/.operad/bot/default/memory/`. It is not shared: another bot cannot read it.
The directory is a git repository of its own, created when it is missing, so one
bot's history stays apart from every other bot's. A working directory that is
already inside a repository keeps that repository: the plugin commits only the
`memory/` part.

The layout has three layers and one file:

| Path | What it holds |
|---|---|
| `memory/index.md` | the index: one line per entry, a link and a few words. It stays small; the detail belongs in a topic note |
| `memory/log/YYYY-MM-DD.md` | an append-only daily log of what happened |
| `memory/topics/<name>.md` | topic notes, linked from the index |
| `memory/instructions.md` | a person's long-standing instructions to that bot |

The plugin creates `index.md`, `instructions.md` and `log/` when they are missing
and never overwrites them.

## The nightly tidy

Once a night the bot checks its memory for work. The check costs no model call:
it asks whether the memory directory changed since the last tidy commit and
whether `index.md` is over its 8,000-character limit. When neither holds, the
night ends with no cost. The time is a bot setting, `tidyTime`, an `HH:MM` in
the machine's local time zone, `03:30` by default. A night the machine slept
through is caught up once, not once for every missed night; a changed time
starts from the latest planned check.

When there is work, the bot has one pending card with how many notes were added
or changed, how many chats need checking and whether the index is over its
limit. Its actions are **Run** (Chinese 运行) and **Skip** (Chinese 跳过). An
unanswered card stays and never expires; the next check updates the same card's
counts instead of making another. **Skip** closes it until the next check finds
work. The bot setting **Run without asking** (Chinese 不询问直接运行) is off by
default; when it is on, no card is made and the tidy runs directly. Only a
change then sends one line through the `notify` command.

The run reads the notes changed since the last tidy against the chats of that
period, corrects wrong or out-of-date notes (the newer note replaces the older,
and the old note stays marked as replaced rather than being deleted), and moves
detail into topic notes when the index is over its limit. It ends in one memory
commit. A rewrite that drops at least a quarter of the old index entries is
void: the old entries stay and only additions are kept. A tidy does not start
while any chat of the bot is writing a reply; an automatic night waits for the
next check, and **Run** waits until that chat ends.

The model is the bot's `backgroundModel` when written. Without it the bot's
agent may declare a cheap model for background work; `claude` declares
`haiku`, and `pi`, `codex` and `radian` leave it unset, so they use the bot's
model, else the agent's default. operad does not compare prices. A run started
from the card leaves a result card with its cost and a summary of the commit's
diff; an automatic run leaves no card.

| Setting | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `bot.bots.<name>.tidyTime` | string | `03:30` | `HH:MM` from `00:00` to `23:59`, in local time | The next nightly check | Refused by the schema |
| `bot.bots.<name>.runWithoutAsking` | boolean | `false` | `true` or `false` | The next nightly check | Refused by the schema |
| `bot.bots.<name>.backgroundModel` | string | the agent's declared background model, else the bot's model | a model the bot's agent lists | The next tidy run | Refused at the run when the agent does not list it |

## What a reply carries

A bot chat puts the memory index and the person's instructions on its message,
not in the agent's system prompt. The first message of a new session, and the
first after the agent compacts its context, carries both files whole. After
that, a reply compares each file with what the session last saw: a file changed
elsewhere (another chat of the same bot, a scheduled run, a tidy step) goes
again in full, while a change the chat's own run wrote is not repeated. The
index is cut at about 8,000 characters, with a line saying it was cut; keep the
file shorter than that by moving detail into topic notes. These notes are not
part of the transcript and do not change the message you sent.

## The memory skill

While the plugin is enabled, every bot mounts the `memory` skill
(`SKILL.md`) next to the skills it lists. The skill tells the bot what a
memory is for: the things it cannot look up, such as a person's preferences, a
correction they made and a rule they verified. It points at operad's own history
and the wiki instead of copying them. It also says that rules the bot must obey
do not belong in memory: they live in the bot's instructions and its access
profile, and changing one is a proposal for a person.

The skill asks the bot to read its memory before answering, to write without
asking, and to keep the index short. A person reviews what changed afterwards in
the git history rather than approving each write.

## What a bot wrote is recorded in git

After a bot reply that changed its memory directory or the wiki, the plugin
makes one commit in each repository the reply changed. The message names the bot
and the chat it was talking in, for example:

```
memory: bot default, chat C-12
wiki: bot default, chat C-12
```

A reply that wrote nothing makes no commit. A tidy run uses
`tidy: bot <bot>, chat <chat>` and always makes a memory commit, even when it
changed no file, so the next check has a baseline. The commits are ordinary
commits in ordinary repositories: review them with `git log`, or in an editor
that shows them, and revert one like any other commit. Nothing is pushed
anywhere.

The plugin cannot tell your own uncommitted edit from the bot's: when a reply
ends, every change under the wiki at that moment is committed with the bot and
the chat in the message. Commit your own edits before a bot writes, or commit
them separately afterwards.

## Notes a bot found outside

A note written after a bot read a web page, mail or an item a source plugin
fetched can come from content someone else controls. The skill asks the bot to
mark such a note in its frontmatter:

```md
---
untrusted: true
---
```

A note marked that way is never linked from `memory/index.md`: the plugin removes
an index line that points at it before it commits, and the note itself stays
where it was written. The bot is asked to keep it out of the index in the first
place.

operad cannot yet tell by itself that a bot run read such content: the agent's
reads and the text a local MCP server returns are not recorded per run. Until
they are, the mark depends on the bot writing it, and a note the bot does not
mark stays as it is.

## Not here yet

The plugin has no full-text index, and no capture flow yet. Those are planned;
the wiki, the memory layout and the nightly tidy are usable now.
