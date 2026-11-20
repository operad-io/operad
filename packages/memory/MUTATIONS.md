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
