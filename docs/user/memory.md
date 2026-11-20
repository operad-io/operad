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

The plugin owns one setting, one skill and one index. The wiki is a Markdown
directory with a git history; the bot's memory has the same history, one
repository per bot.

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

## Search

The plugin keeps a full-text index of the wiki, each bot's memory and the chat
records. It lives in `~/.operad/store/search.sqlite`. The index is a cache:
anything it holds is rebuilt from the Markdown files and the chats, so deleting
the file costs one rebuild and loses no note.

A bot searches it with the `search` tool, which comes with the other operad
tools. A search can cover the wiki, the bot's own memory or the bot's own chats;
the wiki is shared, the memory and chats are not. A result names the document,
its line range and a snippet. The `read` tool returns the document, or the range
of lines a result points at. Frontmatter fields can narrow a search, and a
directory's `_about.md` comes back with the hits found inside that directory.

A read also shows the notes that link to the one you read. When there are any,
it ends with a `Backlinks` section: each linking note's path, the line of the
link and a short excerpt around it. A linking note whose frontmatter says
`untrusted: true` is marked, just as a search result is. The note's own outgoing
links are already in its text, so they are not listed again. With no backlinks
the section is left out. The `read` command prints this text; `--json` gives the
same list as a `backlinks` array instead.

The index uses SQLite FTS5's `trigram` tokenizer, which works on Chinese as well
as English: a two-character Chinese word inside a sentence is found by a
substring fallback because trigram needs three characters. `unicode61`, the FTS5
default, treats a whole run of Chinese characters as one word. On the repository
fixture `unicode61` found 3 of 9 relevant documents and `trigram` found 9 of 9.

A note a person edits in their own editor is found on the next search. A
long-running `serve` also watches the wiki and memory directories and the store,
so its index follows along between searches.

## The wiki in the app

The app reads the wiki through the same object interface as every other plugin,
so the wiki has a list page and an object page without a separate file API. There
are two read-only object types: a wiki **folder** and a wiki **note**. They have
no actions. Only the directory in `memory.wikiDir` is shown; a bot's own memory
directory is not.

The top level is the wiki root: a list without a parent shows the folders and
notes directly in it. Opening a folder lists its subfolders and notes, and a note
opens on its content.

| Object | Row |
|---|---|
| folder | its name as the title, and how many notes are under it, including its subfolders |
| note | the first heading as the title, else the file name without `.md`, and the modification time |

A folder's title is its directory name. A note whose frontmatter says
`untrusted: true` is listed like any other note, with the same `(untrusted)`
mark a search result carries. A row has no state mark.

A note's page has a **Note** section with its Markdown content, and a
**Backlinks** section when other notes link to it. Backlinks follow the same
link rules as `memory read`: each one opens the linking note's object. The
Backlinks section is left out when there are none. Content longer than one page
is paged with the section cursor, like any other long section.

The content section also names the notes its links point at, so a client can
follow `[[links]]` and relative Markdown links. A link to a page nobody wrote
yet stays unresolved; the Markdown itself is not rewritten.

## What a bot wrote is recorded in git

After a bot reply that changed its memory directory or the wiki, the plugin
makes one commit in each repository the reply changed. The message names the bot
and the chat it was talking in, for example:

```
memory: bot default, chat C-12
wiki: bot default, chat C-12
```

A reply that wrote nothing makes no commit. The commits are ordinary commits in
ordinary repositories: review them with `git log`, or in an editor that shows
them, and revert one like any other commit. Nothing is pushed anywhere.

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
where it was written. The nightly tidy also leaves such a note out of its link
lists, so it is never suggested for linking. The bot is asked to keep it out of
the index in the first place.

operad cannot yet tell by itself that a bot run read such content: the agent's
reads and the text a local MCP server returns are not recorded per run. Until
they are, the mark depends on the bot writing it, and a note the bot does not
mark stays as it is.

## Not here yet

No capture or review flow yet. Vector search is not built; the index is built so
another search engine can replace it without changing the tools. The wiki, the
memory layout and the nightly tidy are usable now.
