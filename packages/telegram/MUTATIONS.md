# Mutation records — `telegram`

Rows whose mutation broke code in `packages/telegram/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0406-M1 | packages/telegram/src/source.ts | the source acted on an update whose message the bound chat already held, so a resent update wrote a second message | `the telegram source > a resent update writes no second message and starts no second reply` |
| T-0406-M2 | packages/telegram/src/source.ts | a closed chat was reused instead of replaced, so a message after a close stayed unanswered | `the telegram source > a closed chat is replaced by a new one on the next message` |
| T-0406-M3 | packages/telegram/src/source.ts | an unlisted sender got a chat and a message | `the telegram source > an unlisted sender and a group message are recorded and start nothing` |
| T-0406-M4 | packages/telegram/src/source.ts | the update event was keyed by the clock instead of the update id, so the update was not recorded once under its id | `the telegram source > a private message from a listed user becomes one user message on a bound chat` |
| T-0406-M5 | packages/telegram/src/state.ts | `readOffset` returned 0, so the recorded offset was never read back | `the telegram source > a private message from a listed user becomes one user message on a bound chat` |
| T-0406-M7 | packages/telegram/test/bunfig.toml | the package had no `test/bunfig.toml`, so a test worktree could not copy the package's test preload | `scripts/check-install.ts > the same worktree with every link passes, and bun test runs` |
