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

## T-0588 — the memory tidy's check and rewrite guard

| id | file | mutation | failing test |
|---|---|---|---|
| T-0588-M1 | packages/memory/src/tidy.ts | `memoryTidyState` returned no changed notes | `the memory tidy's check > a fresh memory has no work, a new note is work, and the index over its limit is work` |
| T-0588-M2 | packages/memory/src/tidy.ts | `rewriteDrop` never reported a rewrite as voided | `the void-rewrite guard > a rewrite that drops at least a quarter of the old index entries is void, and append only keeps them` |
| T-0588-M3 | packages/memory/src/tidy.ts | `applyAppendOnly` returned without restoring or merging any file | `the void-rewrite guard > a rewrite that drops at least a quarter of the old index entries is void, and append only keeps them` |
| T-0588-M11 | packages/memory/src/commit.ts | a tidy that changed no file no longer made its empty commit | `Run without asking > a run that changes nothing makes the memory commit but sends no notice` |
