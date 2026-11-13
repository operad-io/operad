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
| T-0407-M1 | packages/telegram/src/replies.ts | a message already sent was not skipped when its send had given up, so it was tried again on the next sweep | `a send that fails > that gives up is recorded as the plugin's own event, adds nothing to the chat and is not tried again` |
| T-0407-M2 | packages/telegram/src/replies.ts | giving up recorded no `send_failed` event, so a failed reply was dropped silently | `a send that fails > that gives up is recorded as the plugin's own event, adds nothing to the chat and is not tried again` |
| T-0407-M3 | packages/telegram/src/replies.ts | a reply recorded before the reply side first ran counted as new | `sending a reply > a chat not bound to Telegram and a reply older than the first start send nothing` |
| T-0407-M4 | packages/telegram/src/api.ts | a failed send's error kept the token in its text | `a send that fails > the Bot API's own errors never carry the token` |
| T-0407-M5 | packages/telegram/src/replies.ts | what was sent was not written to the state file, so a restart sent the reply again | `restart > a reply written before a killed process sends is sent by the next one, once` |
| T-0407-M6 | packages/telegram/src/replies.ts | the wait between tries did not double | `a send that fails > is tried again after the waits the clock gives, and goes out once` |
| T-0407-M7 | packages/telegram/src/replies.ts | a user's message was sent to Telegram as if it were a reply | `sending a reply > a new assistant reply is sent once to the bound Telegram chat, and a restart does not resend it` |
| T-0407-M8 | packages/telegram/src/format.ts | `escapeHtml` returned the text unchanged, so `<`, `>` and `&` reached Telegram as markup | `the markdown a reply is reduced to > emphasis, code, links and headings become Telegram HTML and everything is escaped` |
| T-0407-M9 | packages/telegram/src/format.ts | a split reply did not reopen the code fence in the next piece | `the markdown a reply is reduced to > a long reply is split inside the limit, and a code fence is closed and reopened` |
| T-0407-M10 | packages/telegram/src/format.ts | a split reply did not close the code fence at the end of a piece | `the markdown a reply is reduced to > every piece of a split reply has its code fences closed` |
| T-0407-M11 | packages/telegram/src/format.ts | a chunk whose HTML grew past 4096 was cut instead of split again at half the size | `the markdown a reply is reduced to > a single line longer than the limit and text that grows when escaped still fit` |
| T-0407-M12 | packages/telegram/src/replies.ts | Telegram's refusal of the markup was not answered by sending the chunk as plain text | `sending a reply > markup Telegram cannot read is sent again as plain text` |
| T-0407-M13 | packages/telegram/src/replies.ts | the wait ignored the `retry_after` Telegram gave | `a send that fails > waits as long as Telegram asked` |
| T-0407-M14 | packages/telegram/src/replies.ts | a refusal that cannot change was retried like any other | `a send that fails > a refusal that cannot change is not retried` |
| T-0407-M15 | packages/telegram/src/replies.ts | the watch loop did not sweep the chat an event named, so only the startup sweep sent replies | `sending a reply > a reply is sent when the client's events name the chat, and stop ends the watch` |
| T-0407-M16 | packages/telegram/src/api.ts | a 429 or 5xx answer was not marked retryable | `how the Bot API's answer is sorted > a server error can be retried, a bad request cannot, and unreadable markup is named` |
| T-0407-M17 | packages/telegram/src/api.ts | a 400 "can't parse entities" answer was not marked as bad markup | `how the Bot API's answer is sorted > a server error can be retried, a bad request cannot, and unreadable markup is named` |
| T-0407-M18 | packages/telegram/src/replies.ts | giving up also wrote a `chat.entry` fact into the chat, so the notice appeared as if the agent had said it | `a send that fails > that gives up is recorded as the plugin's own event, adds nothing to the chat and is not tried again` |
| T-0407-M19 | packages/telegram/src/replies.ts | the `send_failed` event named no object, so it belonged to no chat | `a send that fails > that gives up is recorded as the plugin's own event, adds nothing to the chat and is not tried again` |
