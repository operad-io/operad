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
| T-0406-M8 | packages/telegram/src/source.ts | `poll` let an update that threw stop the batch, so one bad update blocked every later message | `the telegram source > an update that cannot be handled does not stop the later ones, and is retried` |
| T-0406-M10 | packages/telegram/src/index.ts | the plugin reported `0.0.0` instead of the version of the package that ships it | `plugin versions > telegram reports the version of the package that ships it` |
| T-0407-M1 | packages/telegram/src/replies.ts | a message already sent was not skipped when its send had given up, so it was tried again on the next sweep | `a send that fails > that gives up says so in the chat's history, is not dropped silently and is not tried again` |
| T-0407-M2 | packages/telegram/src/replies.ts | giving up wrote nothing in the chat's history, so a failed reply was dropped silently | `a send that fails > that gives up says so in the chat's history, is not dropped silently and is not tried again` |
| T-0407-M3 | packages/telegram/src/replies.ts | a reply recorded before the reply side first ran counted as new | `sending a reply > a chat not bound to Telegram and a reply older than the first start send nothing` |
| T-0407-M4 | packages/telegram/src/api.ts | a failed send's error kept the token in its text | `a send that fails > the Bot API's own errors never carry the token` |
| T-0407-M5 | packages/telegram/src/replies.ts | what was sent was not written to the state file, so a restart sent the reply again | `restart > a reply written before a killed process sends is sent by the next one, once` |
| T-0407-M6 | packages/telegram/src/replies.ts | the wait between tries did not double | `a send that fails > is tried again after the waits the clock gives, and goes out once` |
| T-0407-M7 | packages/telegram/src/replies.ts | a user's message was sent to Telegram as if it were a reply | `sending a reply > a new assistant reply is sent once to the bound Telegram chat, and a restart does not resend it` |
