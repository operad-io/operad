# Mutation records — `memory`

Rows whose mutation broke code in `packages/memory/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0585-M1 | packages/memory/src/memory.ts | `ensureRepository` returned the directory without running `git init` | `the wiki directory > is created when missing, with a git repository` |
| T-0585-M2 | packages/memory/src/memory.ts | a repository that already held the directory was reported as one this call made | `the wiki directory > a directory that is already a repository is used as it is, never re-initialised` |
| T-0585-M3 | packages/memory/src/commit.ts | `withoutUntrustedLines` returned the index unchanged, so an untrusted note stayed linked | `a bot run is recorded in git > a note marked as untrusted is kept out of the index, and the note itself stays` |
| T-0585-M4 | packages/memory/src/commit.ts | `commitChanges` committed an unchanged directory instead of returning no commit | `a bot run is recorded in git > a second run that wrote nothing makes no commit` |
| T-0585-M5 | packages/memory/src/commit.ts | `commitMessage` left the bot and the chat out of the subject | `a bot run is recorded in git > one commit in the memory and one in the wiki, each naming the bot and the chat` |
| T-0585-M6 | packages/memory/src/memory.ts | `ensureMemoryLayout` stopped making `instructions.md` | `the memory layout > the index, the daily log and the instructions are made, and nothing is overwritten` |

## T-0585 rework 1 — a chat that is not a bot's

| id | file | mutation | failing test |
|---|---|---|---|
| T-0585-M13 | packages/memory/src/commit.ts | `botChatOf` accepted a chat whose parent was not a bot | `a bot run is recorded in git > a chat that is not a bot's is left alone` |

## T-0586 — the memory files a reply carries

| id | file | mutation | failing test |
|---|---|---|---|
| T-0586-M7 | packages/memory/src/memory.ts | `memoryNotes` left the instructions out | `the files a bot chat carries as notes > the index is cut at 8,000 characters and the instructions are whole` |
| T-0586-M8 | packages/memory/src/memory.ts | `MEMORY_INDEX_MAX` was 9,000 instead of 8,000 | `the memory notes a bot chat carries > a long index is cut at the memory plugin's limit` |

## T-0587 — the full-text index, its scopes and the search tool

| id | file | mutation | failing test |
|---|---|---|---|
| T-0587-M1 | packages/memory/src/search/backend.ts | the trigram substring fallback was turned off, so a term shorter than three characters matched nothing | `the Chinese tokenizer measurement > trigram with its short-query fallback finds every fixture query` |
| T-0587-M2 | packages/memory/src/search/backend.ts | the scope/owner condition was dropped, so one bot's memory and chats were reachable from another bot's search | `the full-text index > a bot sees only its own memory and chats beside the shared wiki` |
| T-0587-M3 | packages/memory/src/search/service.ts | an existing document was always kept, so a changed file was never re-read | `the full-text index > a changed file is found on the next search, and a deleted one is gone` |
| T-0587-M4 | packages/memory/src/search/backend.ts | the frontmatter field conditions were left out of the query | `the full-text index > frontmatter fields filter the results` |
| T-0587-M5 | packages/memory/src/search/service.ts | the search skipped the `_about.md` lookup, so directory notes never came back | `the full-text index > a directory's _about.md is returned with its hits` |

## T-0588 — the memory tidy's check and rewrite guard

| id | file | mutation | failing test |
|---|---|---|---|
| T-0588-M1 | packages/memory/src/tidy.ts | `memoryTidyState` returned no changed notes | `the memory tidy's check > a fresh memory has no work, a new note is work, and the index over its limit is work` |
| T-0588-M2 | packages/memory/src/tidy.ts | `rewriteDrop` never reported a rewrite as voided | `the void-rewrite guard > a rewrite that drops at least a quarter of the old index entries is void, and append only keeps them` |
| T-0588-M3 | packages/memory/src/tidy.ts | `applyAppendOnly` returned without restoring or merging any file | `the void-rewrite guard > a rewrite that drops at least a quarter of the old index entries is void, and append only keeps them` |
| T-0588-M11 | packages/memory/src/commit.ts | a tidy that changed no file no longer made its empty commit | `Run without asking > a run that changes nothing makes the memory commit but sends no notice` |

## T-0590 — memory v1 follow-ups, the wiki and the search index

| id | file | mutation | failing test |
|---|---|---|---|
| T-0590-M17 | packages/memory/src/commit.ts | `commitBotRun` stripped untrusted links from the bot's index but not the wiki's | `a bot run is recorded in git > a note marked as untrusted in the wiki is kept out of the wiki's index too` |
| T-0590-M18 | packages/memory/src/commit.ts | the wiki's removed untrusted links were left out of `unindexed` | `a bot run is recorded in git > a note marked as untrusted in the wiki is kept out of the wiki's index too` |
| T-0590-M19 | packages/memory/src/tidy.ts | `tidyCommitForChat` matched the chat as a substring, so C-1 found C-12 | `the memory tidy's check > a tidy commit is found for its own chat, not one whose id has it as a prefix` |
| T-0590-M20 | packages/memory/src/search/service.ts | `refreshChats` read every chat's facts instead of comparing the latest fact sequence | `the full-text index > an unchanged chat's facts are not read on the next refresh` |
| T-0590-M21 | packages/memory/src/search/sources.ts | `chatOwner` returned the stored cwd string while a search resolved its owner | `the full-text index > a chat's owner is compared as a resolved path` |
| T-0590-M22 | packages/memory/src/tidy.ts | `lastTidyCommit` returned undefined instead of the latest tidy commit | `Run without asking > a run that changes nothing makes the memory commit but sends no notice` |
| T-0590-M23 | packages/memory/src/tidy.ts | `tidyCommitSummary` never reported a voided rewrite | `the void-rewrite guard > a tidy chat's commit voids the rewrite, keeps the old entries and records why` |

## T-0595 — untrusted notes are kept out of the index through wikilinks too

| id | file | mutation | failing test |
|---|---|---|---|
| T-0595-M1 | packages/memory/src/commit.ts | `withoutUntrustedLines` read only Markdown links, so an index line with a wikilink to an untrusted note stayed | `a bot run is recorded in git > an index line that links to an untrusted note with a wikilink is removed too` |
