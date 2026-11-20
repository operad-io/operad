# `@operad-io/memory`

The `memory` plugin. The shared **wiki** is a Markdown directory every bot can
read; a bot's **memory** is `memory/` inside its own working directory. Both are
git repositories. Optional: `operad plugin enable memory`.

## Settings

The `memory` section of `config.json` (`plugins.memory.settings`), checked
against `memory.schema.json` and editable through the settings interface:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `wikiDir` | string | `wiki` under the home, so `~/.operad/wiki` usually | The shared wiki: created when missing, and made a git repository when it is not one. A directory that is already a git repository is used as it is: never initialised again, never restructured. `~` is the user's home; a relative path is under the operad home. |

The default is the relative path `wiki`, so it resolves under whichever operad
home is in use: a home other than `~/.operad` gets its own wiki.

## The skill

`skills/memory/SKILL.md` is mounted for every bot while the plugin is enabled.
`resolveBot` appends `MEMORY_SKILL_DIR` to the bot's skills; `memoryEnabled(home)`
reads `plugins.memory` from `config.json` (enabled unless `enabled` is `false`).
The skill is static text; the wiki's current path is a setting, not a value
written into the skill.

## The layout

`ensureMemoryLayout(memoryDir)` makes `index.md`, `instructions.md` and `log/`
when they are missing and never overwrites them. A topic note is
`topics/<name>.md`, linked from the index.

## The full-text index

The plugin keeps a SQLite FTS5 index of the wiki, every bot's `memory/`
directory and the chat records. It lives at `<home>/store/search.sqlite`; it is
a cache, so deleting it costs one rebuild on the next search. No document in it
is the only copy of anything.

`openMemorySearch(home, settings)` opens the index through a `SearchBackend`
(`search/types.ts`). `SqliteSearchBackend` is the default; another engine can
implement the same small interface later. It stores one row per document, its
frontmatter fields, its line chunks and its links, and matches with FTS5.

Indexing is incremental: a file is re-read when its nanosecond modification time
or size changes, and a chat is re-read only when its latest fact sequence changes;
its messages then decide its digest. A document whose file or chat is gone is
removed. `MemorySearch.refresh(store)` does this;
`search` and `read` refresh first, so a change made by another process is visible
without waiting for a watch. The plugin's `start` also watches the wiki and bot
memory directories through `watchDirectory` (`@operad-io/engine/platform`) and
listens to the store, for a long-running server.

The tokenizer is `trigram`. On the fixture at
`test/fixtures/search/chinese.json` (mixed Chinese and English), `unicode61`
found 3 of 9 relevant documents (recall 0.333, MRR 0.375); `trigram` found 9 of
9 (recall 1.000, MRR 1.000). Trigram cannot match a query shorter than three
characters, so a shorter term (such as `记忆`) is found by a scoped `instr`
substring scan over the same chunks. `unicode61` treats a whole run of Chinese
characters as one token, so a word inside a sentence misses.

A search is limited to the scopes the caller asks for. The wiki is shared; a
bot's `memory` and `chats` are only the documents whose owner is that bot's
working directory. `fields` filters on frontmatter keys. A directory's
`_about.md`, when present, is returned with the hits found inside that directory
as `about`.

Two commands expose it: `memory search` and `memory read`. Both take JSON on
stdin, and both accept words on the command line (`memory search --scope wiki
--field tags=project tea`, `memory read <id> [from] [to] [--json]`). The operad
MCP server offers them to a bot as the `search` and `read` tools. A read prints
text by default and JSON with `--json`; JSON input asks for JSON too.

## The link table

Beside the documents the index keeps a table of the links the notes write, in
the same `search.sqlite` (ADR 0038 D8). `parseNoteLinks(text)` (`src/links.ts`)
reads `[[target]]`, `[[target|text]]`, `[[target#Heading]]`, `[[#Heading]]`
to a heading in the same note, and the table form `[[target\|text]]`, plus
relative Markdown links `[text](path.md#heading)`, whose destination may have
spaces or be enclosed in angle brackets. Markdown targets are percent-decoded
and a target with a bare `%` is kept as written. Fenced and indented code
blocks, inline code, external links and image embeds are not links. The service
stores each parsed link with the document: source, raw target, optional heading,
kind, and the line and excerpt a backlink shows.

`MemorySearch.refresh` resolves the stored links after it has read the files,
and only when a note changed. `resolveNoteLink(source, link, notes)` takes a
target that names a path from the scope root, then (for a Markdown link)
relative to the source note. A bare wikilink name matches a file name with or
without `.md`; among same-named files the one nearest the source wins. A path
that names a note is not reduced to its file name. Resolution stays inside one
scope and owner. A link that matches nothing is kept unresolved and takes the
note when somebody writes it; a renamed note gives its links a new target, and
a deleted note keeps the links that pointed at it, unresolved.

Four queries answer from the table, after a refresh: `linksFrom(id)`,
`backlinks(id)`, `unresolvedTargets(query)` and `orphanNotes(query)`. `query`
narrows by `scope` and `owner`. `read` uses `readBacklinks(id)` to end a note
with its `Backlinks`: each linking note's path, the line of the link, a short
excerpt around it and whether the source is marked `untrusted`. The outgoing
links stay in the note's own text and are not listed again. A `--json` read
carries the same list as `backlinks`. `linkReport(search, query)`
(`src/link-report.ts`) builds the lists the nightly tidy reads: broken links
with their source path and 1-based line, orphan notes (leaving out `index.md`,
`instructions.md`, `_about.md` and anything under `log/`), unresolved targets
that three or more different notes link to, and up to 20 mentions where one
note's body contains another note's title as a word but writes no link to it.
A note marked `untrusted: true` is left out of every list, as a source or as a
target. The tidy report is not a command or tool output. An index built before the table
existed, or with another version of it, is filled on the next refresh: opening
it clears the stored modification time of its notes, so every note is read
again.

## The wiki objects

The wiki is served to the apps as two read-only object types, declared by this
plugin and shown by the generic `/v1` object interface. There are no actions.

| Type name | Type title | What it is |
|---|---|---|
| `wiki` | Wiki | A folder; its children are its subfolders and notes. |
| `note` | Note | A Markdown note. |

`syncWikiObjects(store, home, settings, search?)` projects the wiki directory
into those objects. The folder type's `prepare` runs it before the first list or
get; a running `serve` runs it from the plugin's `start`, on the wiki and memory
directory watches and on the store's change listener. It reads only
`memory.wikiDir`, never a bot's memory directory. Files remain the only copy: the
object data holds the path, title, modification time, untrusted flag, links and
backlinks, and a section read reads the note's file again. A note whose
modification time did not change is not read again, and the folder type's
`prepare` builds the projection from the directory rather than refreshing the
search index. With a search given, `serve` also refreshes that index; a list or
get passes none.

A folder object's id is its path from the wiki root; a note object's id is its
path with the Markdown extension. A row has no `mark`. A top-level row has no
`parent`, a child's `parent` is its folder's id, so `list --root`,
`list --parent <folder>` and the existing hierarchy work as they do for every
plugin. The folder row's note is the number of notes under it, including its
subfolders; the note row's note is its modification time, with `(untrusted)`
after it when its frontmatter says `untrusted: true`. A path outside the wiki is
refused by the types' `resolve`, and the content read checks the path again. A
file that is gone is marked removed; the default `live` filter hides it, and the
`removed` filter shows it.

A note's `sections` are `content` (title Note) and, only when it has backlinks,
`backlinks` (title Backlinks). The content section is the note body without
frontmatter, paged at `WIKI_PAGE_CHARS` (20,000) characters with the usual
`pages` and `next`. Its `data.links` is the parsed links in order:

```json
{ "target": "notes/tea", "heading": "Brewing", "kind": "wikilink", "object": "note:notes/tea.md" }
```

`target` is as written, `heading` is present when the link names one, `kind` is
`wikilink` or `markdown`, and `object` is the full object id of the resolved
target. `object` is left out while nothing matches. The Markdown is not
rewritten.

The Backlinks section's `data.backlinks` is the same list `readBacklinks` gives,
with `object` added: `{ object, path, title, target, heading?, kind, line,
excerpt, untrusted }`. Its Markdown is one bullet per backlink, linking the
linking note's `operad://objects/<object>` address.

## The memory notes

`memoryNotes(memoryDir)` names the files a bot chat carries on its message: the
index with `maxChars: MEMORY_INDEX_MAX` (8,000) and the instructions whole. A
file that is not there yet is left out, and one created later is picked up by
the next reply. `bot/settings` returns the list as `notes`; the chat plugin
reads and hashes the files (ADR 0026 D18).

## The commit

The plugin declares one step, `memory/commit`, called by a chat after a reply
when its refresh data names it. `bot/settings` returns
`after: "memory/commit"` only when the step is loaded (`ctx.stepLoaded`), so a
home without the plugin is unaffected. `chat/reply` calls the named step after the
round that ends a run with `done` or `failed`, once for the run, and `chat/keep`
calls it for a run that was stopped or interrupted after writing. A step that
fails is logged and never changes the answer.

`runMemoryCommit(ctx, params)`:

1. reads the chat from `params.chat` (or `ctx.object`), and its `parent`
   (`bot:<name>`) and `cwd`; a chat that is not a bot's is skipped;
2. makes the memory layout, and removes from `memory/index.md` and from the
   wiki's `index.md` the lines that link to a note whose frontmatter says
   `untrusted: true`. It reads the same link forms, with the same parser and
   resolution as the search index (`parseNoteLinks`, `resolveNoteLink`), so the
   index it cleans and the link table cannot disagree;
3. makes the bot's `memory/` a repository of its own when it is no repository
   (a memory directory already inside a repository stays part of it);
4. makes the wiki (`ensureWiki`) and commits each directory that changed.

One commit per repository that the reply changed, with the subject
`memory: bot <bot>, chat <chat>` or `wiki: bot <bot>, chat <chat>`. Only that
directory's paths are staged and committed, so another change in the same
repository is not taken along. The step cannot attribute a change inside those
paths to the bot or to a person: every uncommitted change under the directory
when the reply ends goes into the commit. The commits are made with a fixed identity
(`operad memory <memory@operad.local>`) and `--no-verify`, so a fresh repository
without `user.name` still records the write. Commits in one home take turns
under `$OPERAD_HOME/memory-commit.lock`.

## The wiki and a bot's access profile

The `bot` plugin asks this package for the wiki path (`wikiDirectoryOfHome`) and
whether the plugin is enabled. `defaultAccess(home, wikiWrite)` names the wiki in
the home deny even before it exists; a bot that may write it leaves that entry
out, and a bot that may only read it also gets a `readPaths` entry so a read
reaches it through the deny. A bot's `writeWiki` setting decides; without it the
default bot writes and every other bot reads (ADR 0030).

## Not here yet

No `capture` or `review` flow, and no per-run record of the material a bot read:
the `untrusted` mark is written by the bot itself, and the plugin only enforces
that a marked note is not indexed. Vector search is not built; the backend
interface is where another engine would provide it. The wiki, the memory layout
and the nightly tidy are usable now.
