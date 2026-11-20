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
frontmatter fields and line chunks, and matches with FTS5.

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
--field tags=project tea`, `memory read <id> [from] [to]`). The operad MCP server
offers them to a bot as the `search` and `read` tools.

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
   `untrusted: true`;
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
