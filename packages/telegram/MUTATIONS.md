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
| T-0408-M1 | packages/telegram/src/pending.ts | a tap from a user not in the `users` list was acted on | `pending items go to Telegram > a tap from an unlisted user counts for nothing` |
| T-0408-M2 | packages/telegram/src/pending.ts | an answered item was not marked answered in the state file, so the next tap acted again and the next pass did not settle it | `pending items go to Telegram > a tap acts as the telegram user, then the buttons go and the message reads answered: X` |
| T-0408-M3 | packages/telegram/src/pending.ts | the `pending` setting was ignored, so a listed plugin's items were not sent to the listed users | `pending items go to Telegram > an item of a listed plugin goes to every listed user` |
| T-0408-M4 | packages/telegram/src/pending.ts | a tap carrying the position of a note-needing action ran it without a note | `pending items go to Telegram > an action that needs a note has no button; replying to the message gives the note` |
| T-0408-M5 | packages/telegram/src/pending.ts | a reply to an item that takes no note was taken as its answer instead of an ordinary chat message | `pending items go to Telegram > a reply to a button-only item is an ordinary chat message, not an answer` |
| T-0408-M6 | packages/telegram/src/pending.ts | a tap did not change the other copies of the item sent to other chats | `pending items go to Telegram > a tap on a choice answers the question as the telegram user, and every copy of the item reads answered: X` |
| T-0408-M7 | packages/telegram/src/pending.ts | a question answered elsewhere through a choice read a bare "answered" instead of naming the choice the history shows | `pending items go to Telegram > a question answered somewhere else reads answered: X with the choice the history shows` |
| T-0409-M1 | packages/telegram/src/source.ts | a resent update was never matched to the message it already wrote, so a redelivered update wrote a second message | `from the first Telegram message to an answered pending item` |
| T-0409-M2 | packages/telegram/src/pending.ts | a tap on a button of an action that asks to confirm (dev merge) did not count as the confirmation, so the real dev action refused it | `a proposed task and a task waiting for a merge are answered from Telegram through the real dev plugin` |
| T-0423-M1 | packages/telegram/src/replies.ts | the give-up note said the configured number of tries even when the send was tried once | `a send that fails > a refusal that cannot change is not retried` |
| T-0423-M2 | packages/telegram/src/pending.ts | a tap on a message the plugin does not know was not answered | `pending items go to Telegram > a tap on a message the plugin does not know is still answered, so no spinner stays` |
| T-0423-M3 | packages/telegram/src/format.ts | `__x__` was bold inside a word again | `the markdown a reply is reduced to > __x__ is bold only as a whole word, so a dunder name keeps its underscores` |
| T-0423-M4 | packages/telegram/src/format.ts | splitMarkdown took any fence line as closing a fence | `the markdown a reply is reduced to > a fence line with an info string inside a fence does not close it when a reply is split` |
| T-0423-M5 | packages/telegram/src/format.ts | a long line was cut between the halves of a surrogate pair | `the markdown a reply is reduced to > a long line is never cut inside a surrogate pair` |
| T-0423-M6 | packages/telegram/src/api.ts | a send had no time limit of its own | `a send that fails > a send that stalls is ended by its time limit and counts as a failure that can be retried` |
| T-0423-M7 | packages/telegram/src/pending.ts | a reply from an unlisted user to an item's message was taken as an answer | `pending items go to Telegram > a reply from an unlisted user to an item's message answers nothing` |
| T-0444-M1 | packages/telegram/src/typing.ts | the client's `get` was ignored, so a running reply never showed typing | `the typing indicator > is sent when a reply starts, repeated while it runs, and stops after it ends` |
| T-0444-M2 | packages/telegram/src/typing.ts | a reply that stopped running did not end the indicator | `the typing indicator > is sent when a reply starts, repeated while it runs, and stops after it ends` |
| T-0444-M3 | packages/telegram/src/typing.ts | a chat with no Telegram channel was sent typing anyway | `the typing indicator > is not sent for a chat that is not bound to Telegram` |
| T-0444-M4 | packages/telegram/src/typing.ts | an event's chat id was ignored, so a reply start never began typing | `the typing indicator > starts when the client's events name a running chat, and stop ends it` (timed out) |
| T-0444-M5 | packages/telegram/src/typing.ts | the indicator was renewed at twice the interval, so it was not repeated while the reply ran | `the typing indicator > is sent when a reply starts, repeated while it runs, and stops after it ends` (timed out) |
| T-0444-M6 | packages/telegram/src/typing.ts | a failed `sendChatAction` was sent again at once | `the typing indicator > a failed send is not retried, adds nothing to history and does not hold up a reply` |
| T-0444-M7 | packages/telegram/src/api.ts | `sendChatAction` called the `sendMessage` method | `the typing indicator > the Bot API client sends the typing action to the chat` |
| T-0444-M8 | packages/telegram/src/typing.ts | stopping the plugin left the active indicators running | `the typing indicator > starts when the client's events name a running chat, and stop ends it` (timed out) |
| T-0444-M9 | packages/telegram/src/index.ts | `createTelegramPlugin` did not start the typing side | `the telegram plugin starts and stops typing through a real chat reply run` (timed out) |
| T-0444-M10 | packages/telegram/src/index.ts | `createTelegramPlugin` stopped without stopping the typing side | `the telegram plugin starts and stops typing through a real chat reply run` |
| T-0451-M1 | packages/telegram/src/typing.ts | the recorded reply did not end the indicator, so a run that went on kept it typing | `the typing indicator > is sent when a reply starts, repeated while it is written, and stops once the reply is recorded` |
| T-0451-M2 | packages/telegram/src/typing.ts | run flags were read with a detail page per event instead of one list for a burst | `the typing indicator > coalesces a burst of events into one list and no detail page` |
| T-0451-M3 | packages/telegram/src/typing.ts | a failed event stream was not taken again, so typing stopped watching until serve restarted | `the typing indicator > takes the client's events again after the stream fails` (timed out) |
| T-0451-M4 | packages/telegram/src/typing.ts | the periodic check was not started, so an indicator whose run-end event was lost kept renewing | `the typing indicator > stops when a run ends without an event, as the periodic check sees it` |
| T-0451-M5 | packages/telegram/src/typing.ts | a run that stopped running left the indicator going | `the typing indicator > stops when a reply run ends without recording a reply` |
| T-0451-M6 | packages/telegram/src/typing.ts | the event iterator took the engine's `ViewEvent`, a name on the plugin docs allow list, so a plugin package imported it | `scripts/test/plugin-docs.test.ts > the plugin docs > a name a plugin package imports is never on the allow list` |

## T-0485 — a failed reply is shown

| id | file | mutation | failing test |
|---|---|---|---|
| T-0485-M1 | packages/telegram/src/replies.ts | the reply side ignored failure entries, so Telegram never got the line | `sending a reply > a failed reply is sent once as a message, in order with the replies` |
| T-0485-M2 | packages/telegram/src/typing.ts | a failure after the last person's message did not end typing, so the indicator started again | `the typing indicator > stops when a failed reply is recorded, even while its run goes on` |
| T-0488-M1 | packages/telegram/src/progress.ts | the two-second check was ignored, so a changed tail was edited at once | `the progress message of a reply > edits are at most one per two seconds, carry the newest tail, and skip an unchanged text` |
| T-0488-M2 | packages/telegram/src/progress.ts | an unchanged tail was edited again after the interval | `the progress message of a reply > edits are at most one per two seconds, carry the newest tail, and skip an unchanged text` |
| T-0488-M3 | packages/telegram/src/format.ts | a long tail kept its start instead of its end, so the newest words were lost | `the progress message of a reply > a long tail shows its end within Telegram's limit` |
| T-0488-M4 | packages/telegram/src/progress.ts | an edit's 429 ignored the `retry_after` Telegram gave | `the progress message of a reply > a 429 waits the retry_after Telegram asked and the edit still lands` |
| T-0488-M5 | packages/telegram/src/progress.ts | the final reply was not sent before the progress message was deleted | `the progress message of a reply > the final reply is a new message and the progress message is deleted after it` |
| T-0488-M6 | packages/telegram/src/progress.ts | a failed edit deleted the progress message before the reply was final | `the progress message of a reply > a failed edit is logged and the final reply still goes out, then the progress message goes` |
| T-0488-M7 | packages/telegram/src/progress.ts | a restart did not delete the progress message a killed serve left behind | `the progress message of a reply > a restart deletes a progress message a killed serve left behind` |
| T-0488-M8 | packages/telegram/src/progress.ts | the transcript was read whole instead of after the mark the last read gave | `the progress message of a reply > edits are at most one per two seconds, carry the newest tail, and skip an unchanged text` |
| T-0488-M9 | packages/telegram/src/progress.ts | a progress message was sent before any text or tool call | `the progress message of a reply > nothing is sent before the first text, and an unfinished code fence is closed` |
| T-0488-M10 | packages/telegram/src/progress.ts | a run that ended without recording a reply left its progress message behind | `the progress message of a reply > a stopped reply deletes the progress message once the client says the run ended` |
| T-0488-M11 | packages/telegram/src/progress.ts | a failure entry after the last person's message did not finish the progress message | `the progress message of a reply > a failed reply sends its failure line as a new message, then deletes the progress message` |

## T-0504 — typing after a failure and a cancelled progress message

| id | file | mutation | failing test |
|---|---|---|---|
| T-0504-M1 | packages/telegram/src/typing.ts | typing stopped on any failure after the person's message, so a rerun's new writing did not restart it | `the typing indicator > starts again when a rerun after a failure is writing` |
| T-0504-M2 | packages/telegram/src/progress.ts | no look was scheduled after a progress message was sent, so a cancelled run left it without another event | `the progress message of a reply > a cancelled run deletes the progress message without another event` |
| T-0504-M3 | packages/telegram/src/progress.ts | a canceled timer woke the chat again, so finishing a failed reply sent the progress message a second time | `the progress message of a reply > a failed reply sends its failure line as a new message, then deletes the progress message` |
## T-0494 — the command menu, `/start` and choice buttons

| id | file | mutation | failing test |
|---|---|---|---|
| T-0494-M1 | packages/telegram/src/commands.ts | the menu was never given to Telegram, so a started plugin registered nothing | `the bot's command menu > is registered at start and again when the set of commands changes` |
| T-0494-M2 | packages/telegram/src/commands.ts | a command name Telegram's menu does not take was registered anyway | `the bot's command menu > leaves out a name Telegram does not take and says so` |
| T-0494-M3 | packages/telegram/src/commands.ts | the bot's name after a command was kept, so `/help@bot` was an ordinary message | `a command in a Telegram chat > a name with the bot after it is the plain command, and what it returns comes back` |
| T-0494-M4 | packages/telegram/src/commands.ts | `/start` was not answered with the greeting that points at `/help` | `a command in a Telegram chat > /start gets a greeting that points at /help and starts no chat` |
| T-0494-M5 | packages/telegram/src/source.ts | a command from an unlisted sender opened a chat and ran | `a command in a Telegram chat > a command from an unlisted sender is dropped without a reply` |
| T-0494-M6 | packages/telegram/src/commands.ts | a command with one choice sent without it ran instead of answering with buttons | `a command in a Telegram chat > without its one choice it answers with the choices, one page at a time, and a tap runs it` |
| T-0494-M7 | packages/telegram/src/commands.ts | every page showed the first page's choices | `a command in a Telegram chat > without its one choice it answers with the choices, one page at a time, and a tap runs it` |
| T-0494-M8 | packages/telegram/src/commands.ts | after a tap the message named the first choice instead of the one picked | `a command in a Telegram chat > without its one choice it answers with the choices, one page at a time, and a tap runs it` |
| T-0494-M9 | packages/telegram/src/source.ts | what a typed command returned was not sent back to Telegram | `a command in a Telegram chat > a name with the bot after it is the plain command, and what it returns comes back` |
| T-0494-M10 | packages/telegram/src/commands.ts | a tap from a user not in the `users` list ran the command | `a command in a Telegram chat > a tap from an unlisted user counts for nothing` |
| T-0494-M11 | packages/telegram/src/source.ts | a command's text titled the chat it opened, so `/help` became a chat called `/help` | `a command in a Telegram chat > a command before any chat opens one, as a first message does` |
| T-0494-M12 | packages/telegram/src/commands.ts | the menu's event watcher ignored every client event, so a command gained or lost while the bot ran never reached Telegram | `the bot's command menu > follows the client's events and registers again when a command appears or goes` |

## T-0506 — chat command follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0506-M1 | packages/telegram/src/commands.ts | the keyboard state grew without a bound, so every answered keyboard stayed in `commands.json` | `a command in a Telegram chat > the keyboard state file keeps only the newest answered keyboards` |
| T-0506-M2 | packages/telegram/src/commands.ts | markup Telegram refused was not sent again as plain text | `a command in a Telegram chat > what a command returns goes again as plain text when Telegram refuses its markup` |
| T-0506-M3 | packages/telegram/src/commands.ts | a restarted command side forgot the keyboards it had sent | `a command in a Telegram chat > a choice keyboard survives a restart so its buttons still work` |
| T-0506-M4 | packages/telegram/src/commands.ts | a long description was sent whole instead of cut to Telegram's limit | `the bot's command menu > cuts a long command description to what Telegram takes` |
| T-0506-M5 | packages/telegram/src/commands.ts | the menu's event watcher did not register again after a client change | `the bot's command menu > follows the client's events and registers again when a command appears or goes` (timed out) |
| T-0506-M6 | packages/telegram/src/commands.ts | the page after the first had no « button back | `a command in a Telegram chat > without its one choice it answers with the choices, one page at a time, and a tap runs it` |
