# ADR 0038: Full-Text Search

Status: accepted

## Background

A bot that cannot search its own memory, the shared wiki and its chats answers from whatever happens to be in its context. Grepping the Markdown files misses the chat records, and the default SQLite FTS5 tokenizer (`unicode61`) treats a whole run of Chinese characters as one token, so a word inside a sentence is not found. The index therefore has to be part of the memory plugin from its first version, on the records that already exist.

## Decisions

### D1: One index per home, and it is a cache

The memory plugin keeps a SQLite FTS5 index, opened with `bun:sqlite`, at `<home>/store/search.sqlite`. It is never the only copy of anything: every document comes from a Markdown file or a chat record that remains where it was. Deleting the file costs one rebuild on the next search. The index is not written inside the wiki or a bot's memory directory, so a person's notes library and its git history are unchanged by it.

### D2: What is indexed, and who may reach it

The index holds three scopes: `wiki`, `memory` and `chats`. A wiki document is shared and has no owner. A memory document belongs to the bot whose working directory holds the `memory/` it came from; a chat document belongs to the bot whose working directory is the chat's. A search for a bot reaches the shared wiki plus only the memory and chats whose owner is that bot's working directory. A document id names the scope and the file: `wiki:<path>`, `memory:<bot directory>:<path>`, `chat:<chat id>`.

A file is re-read when its modification time or size changes; a chat is re-read when the digest of its messages changes. A document whose file or chat is gone is removed. `search` and `read` refresh the index before answering, so a change another process made is visible without waiting for a watch. A running `serve` also watches the wiki and bot memory directories through `@operad-io/engine/platform` and listens to the object store.

### D3: The tokenizer is `trigram`, with a substring fallback

The index is built with FTS5's `trigram` tokenizer. It matches Chinese words inside a sentence and mixed Chinese/English text. The measurement on the Chinese and mixed fixture in the repository: `unicode61` found 3 of 9 relevant documents (recall 0.333, MRR 0.375), `trigram` found 9 of 9 (recall 1.000, MRR 1.000).

Trigram cannot match a query shorter than three characters. A term shorter than three characters is found by a scoped `instr` substring scan over the same chunks, under the same scope, owner and field filters. A query with both long and short terms uses FTS5 for the long terms and the substring scan for the short ones.

### D4: Search sits behind a backend interface

`SearchBackend` in the memory package is the replaceable part: `put`, `remove`, `get`, `keys`, `search`, `about` and `close`. The service owns scopes, ownership, indexing and the shape of a result; a backend owns storage and matching. `SqliteSearchBackend` is the shipped implementation. Another engine, such as BM25 with vectors, can implement the interface without changing the tool or the indexer. No external search engine, local model or extra runtime dependency is part of this decision.

### D5: A result names the document, its lines and a snippet

A hit returns the document id, its scope and title, the file path within its scope, the line range of the matching chunk and a snippet of it. A search may narrow by scope and by frontmatter fields; a field with several values matches any of them.

A directory may hold an `_about.md` describing what belongs there. When a hit is inside such a directory, that description is returned with the result as an `about` entry, so the bot sees what the directory is for without a second read.

`read` takes a document id and an optional line range and returns those lines with the document's title, path and total line count. It reads any document the asking bot can reach, whether or not the search found it.

### D6: A bot reaches search through the operad tools

The MCP server a bot already receives offers `search` and `read`. `search` takes the query text, an optional scope (`wiki`, `memory`, `chats`), frontmatter field filters and a limit; `read` takes a document id and an optional line range. They run the memory plugin's `search` and `read` commands, which are the same verbs the command line uses. Without the memory plugin loaded the tools say so; the kernel gains no search of its own.

### D7: The memory skill tells the bot to search first

The `memory` skill says to search before saying it does not know, to try several phrasings (keywords and a natural question, Chinese and mixed text), to read the document a hit points at, and to use the directory notes that arrive with hits. The skill states what the scopes reach; the access profile still decides what the agent may read.

### D8: A link table in the same index

While the index is built or refreshed, each note's links are parsed and kept in one table in the same `search.sqlite`: the source document, the raw target, the resolved target document or none, the optional `#heading`, and the kind (`wikilink` or `markdown`). The table covers every note the index covers, the wiki and each bot's memory; a chat writes no links.

A wikilink is `[[target]]`, `[[target|text]]`, `[[target#Heading]]`, `[[#Heading]]` to a heading in the same note, or the table form `[[target\|text]]`, whose escaped pipe separates the target from the text so a surrounding Markdown table does not split its row. A Markdown link is relative, `[text](path.md#heading)` or `[text](notes/page.md)`; its destination may have spaces or be enclosed in angle brackets, its target is percent-decoded, and a target that is not a valid escape, such as one with a bare `%`, is kept as written rather than refused. Fenced and indented code blocks and inline code are not links, and neither is an external link or an image embed.

A target that names a path is taken from the scope root. A Markdown target that is not a path from the root is taken relative to the note that writes it; a Markdown target does not fall back to a file name. A bare wikilink name matches a file name with or without `.md`; among files of the same name the one nearest the source note wins, and the path breaks a tie. A wikilink that names a path does not fall back to a bare name. A link resolves only inside its own scope and owner, so a wiki note never resolves into a bot's memory.

An unresolved link is kept: a link to a page nobody wrote yet stays in the table with no target, and takes the page when it is written. A link to a note that moved follows the note to its new path. A deleted note loses the links it wrote; the links that pointed at it stay, with no target.

Like the text index the table is a cache. It is built from the files, updated on the same change events, and dropped and rebuilt when the index itself is rebuilt. It writes no note and makes no model call.

The memory package answers four queries from the table: the links a note writes, the links that point at a note, the unresolved targets with how many links name each, and the notes no other note links to. It also builds a tidy report from them: broken links with their source line, orphan notes, targets three or more notes link to, and up to 20 mentions of a note's title that is not linked. The nightly tidy reads that report for the wiki and its bot's memory and puts the non-empty lists in the tidy agent's prompt, with guidance to fix a clear broken link, leave a link to a page nobody wrote yet, consider linking an orphan, and suggest but not force linking a mention. The lists never make a run happen; they leave out a note marked `untrusted: true`, so such a note is never promoted into the index.

A `read` of a note ends with a `Backlinks` section when other notes link to it. The section lists each linking note by path, with the line of the link and a short excerpt around it. A linking note whose frontmatter says `untrusted: true` is listed with the same mark a search result carries. The links the note itself writes are already in its text, so they are not listed again. With no backlinks the section is left out. `--json` carries the same list as a `backlinks` array. No pending card reads the table.

### D9: A search can stay inside one chat

`memory search --chat <id> <words>` searches one chat only, from any directory: naming the chat is the reach, as opening it is, so the bot-ownership rule of D2 does not apply to it. It returns every matching place in the chat, not the best one per document, each with its line range, a snippet and the id of the message the first matching line is in (`message`), so a client can read the transcript from that message (ADR 0026 D22). It is a command-line argument only: the JSON arguments the bot's `search` tool passes cannot name a chat, so a bot reaches no chat but its own (D2, D6). It refreshes the index first, like every search.

### D10: A stretch that is not remembered is not indexed

A chat message marked as part of a stretch that is not remembered (ADR 0026 D23) is not indexed, so a bot cannot read it back through search. The owner decided this on 2026-11-23.
