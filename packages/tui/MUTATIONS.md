# Mutation records — `tui`

Rows whose mutation broke code in `packages/tui/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0029-M1 | packages/tui/src/client.ts | `401` fell through to the generic error instead of `TuiUnauthorizedError` | `TuiClient > turns each server error into its typed error and keeps the message` |
| TK0029-M2 | packages/tui/src/client.ts | `section` stopped sending `full=true` | `TuiClient > gets one object with its row, sections, actions and a URL-encoded id` |
| TK0029-M3 | packages/tui/src/client.ts | `act` dropped `confirmed` from the request body | `TuiClient > acts with a note, arguments and confirmation` |
| TK0029-M4 | packages/tui/src/discover.ts | a given `--token` was replaced by the home's token | `TuiClient > discovers the server from the home, and the flags win` |
| TK0029-M5 | packages/tui/src/events.ts | `reset` no longer cleared the old `Last-Event-ID` | `TuiEvents > an id the server cannot resume becomes one reset signal` |
| TK0029-M6 | packages/tui/src/events.ts | the reconnect sent a fixed id instead of the last event's id | `TuiEvents > a reconnect with the last id gets the event it missed` |
| TK0029-M7 | packages/tui/src/events.ts | a stream that closed without an event still reset the retry to the minimum | `TuiEvents > a stream that closes without an event keeps backing off` |
| TK0029-M8 | packages/tui/test/support.ts | closing a harness left its scratch home behind | `TuiClient > a harness removes its own scratch home and leaves another's alone` |
| TK0029-M9 | packages/tui/src/events.ts | a `401` no longer ended the stream | `TuiEvents > a bad token ends the stream after one error event` |
| TK0029-M10 | packages/tui/src/events.ts | a refused stream pushed no `error` event | `TuiEvents > 404 and 409 end the stream; 500 is retried with backoff` |
| TK0029-M11 | packages/tui/src/events.ts | a reconnect with no id to resume from sent no `reset` | `TuiEvents > a reconnect with no id to resume from sends one reset` |
| TK0029-M12 | packages/tui/src/events.ts | an event's id was not kept for the next request | `TuiEvents > the same instance reconnects with the last id and gets the missed event` |
| TK0029-M13 | packages/tui/src/client.ts | the abort signal was not passed to `fetch` | `TuiClient > an aborted request rejects with the abort, not an unreachable server` |
| TK0029-M14 | packages/tui/src/client.ts | an aborted request was reported as an unreachable server | `TuiClient > an aborted request rejects with the abort, not an unreachable server` |
| T-0030-M1 | packages/tui/src/state.ts | a cursor move near the end never asked for the next page | `the TUI reducer > moving past the end asks for the next page once and appends it once` |
| T-0030-M2 | packages/tui/src/state.ts | the two-pane threshold became `>` instead of `>=`, so 100 columns stayed one pane | `the TUI reducer > resize crosses 100 columns and carries the theme` |
| T-0030-M3 | packages/tui/src/state.ts | a Pending row lost its waiting flag | `the TUI reducer > each list maps its own flags to a row mark` |
| T-0030-M4 | packages/tui/src/state.ts | an appended page kept `loading` true | `the TUI reducer > moving past the end asks for the next page once and appends it once` |
| T-0030-M5 | packages/tui/src/view/index.ts | the waiting marker used the weak gray instead of the accent | `the TUI view > two panes show the header, a waiting marker and the footer` |
| T-0030-M6 | packages/tui/src/view/index.ts | the view always drew both panes, ignoring the width | `the TUI view > below 100 columns the right pane is gone` |
| T-0030-M7 | packages/tui/src/state.ts/app.ts | the shell no longer cleared a page request as it launched it, so every key fetched the page again | `the TUI app > keys, resizes and refreshes while a page is in flight fetch it once` |
| T-0030-M8 | packages/tui/src/state.ts | an appended page for an older list version was no longer dropped | `the TUI app > a page that lands after a refresh's replace is dropped` |
| T-0030-M9 | packages/tui/src/app.ts | a new refresh no longer aborted the previous refresh's requests | `the TUI app > the previous refresh is aborted and its late answer is dropped` |
| T-0030-M10 | packages/tui/src/state.ts | a replace no longer bumped the list version | `the TUI app > a page that lands after a refresh's replace is dropped` |
| T-0030-M11 | packages/tui/src/state.ts | an answer to an older refresh was applied | `the TUI app > the previous refresh is aborted and its late answer is dropped` |
| T-0030-M12 | packages/tui/src/view/index.ts | the list drew every row instead of the window around the cursor | `the TUI view > a long list scrolls with the cursor and the status takes the footer` |
| T-0030-M13 | packages/tui/src/state.ts | a replace kept the cursor index instead of following the selected object's id | `the TUI app > a refresh keeps the selected object, fetching as deep as the list was` |
| T-0030-M14 | packages/tui/src/app.ts | a refresh fetched only the first page, not as deep as the list was | `the TUI app > a refresh keeps the selected object, fetching as deep as the list was` |
| T-0030-M15 | packages/tui/src/app.ts | an `error` event from the stream was not shown | `the TUI app > an error event from the stream shows its reason` |
| T-0030-M16 | packages/tui/src/app.ts | messages were written to stderr while the screen was up | `runTui > failures are printed after the screen is closed, never while it is up` |
| T-0030-M17 | packages/tui/src/state.ts | a Ctrl or Meta chord acted like its plain key | `the TUI reducer > ctrl and meta chords are ignored, and only ?, escape and q act while the keys are open` |
| T-0030-M18 | packages/tui/src/state.ts | keys other than `?`, escape and `q` acted on the list hidden behind the key list | `the TUI reducer > ctrl and meta chords are ignored, and only ?, escape and q act while the keys are open` |
| T-0030-M19 | packages/tui/src/app.ts | a failure while the screen was being set up was thrown, not reported | `runTui > restores the terminal and reports the failure when the view cannot be made` |
| T-0030-M20 | packages/tui/src/app.ts | the renderer was not remembered for the final cleanup, so a failed setup left it open | `runTui > restores the terminal and reports the failure when the view cannot be made` |
| T-0031-M1 | packages/tui/src/state.ts | `Enter` returned the state without opening the selected row | `the object pane reducer > Enter opens the selected row and asks for the object` |
| T-0031-M2 | packages/tui/src/state.ts | `[` and `]` kept the same section instead of moving to another | `the object pane reducer > ] and [ switch the section tabs and load the next one` |
| T-0031-M3 | packages/tui/src/state.ts | scrolling at the end never asked for the section's `next` page | `the object pane reducer > scrolling at the end asks for the section's next page once` |
| T-0031-M4 | packages/tui/src/state.ts | `f` required a section that was already full, so a capped section never loaded whole | `the object pane reducer > f loads a capped section with full=true` |
| T-0031-M5 | packages/tui/src/state.ts | scrolling up left a live section following its end | `the object pane reducer > a live section follows its end, scrolling up stops it and G resumes` |
| T-0031-M6 | packages/tui/src/state.ts | `G` set the section to its end but never resumed following | `the object pane reducer > a live section follows its end, scrolling up stops it and G resumes` |
| T-0031-M7 | packages/tui/src/markdown.ts | a diff's added line used the removed colour | `the TUI Markdown > a diff is coloured, a table is aligned and a mermaid block keeps its label` |
| T-0031-M8 | packages/tui/src/markdown.ts | every Markdown line lost its fenced-code flag | `the TUI Markdown > the engine's lines keep fenced code marked for a monospace client` |
| T-0031-M9 | packages/tui/src/view/index.ts | a live section's tab lost its dot | `the object pane view > the row, the section tabs and a live dot are in the right pane` |
| T-0031-M10 | packages/tui/src/app.ts | the shell cleared the object request without launching its fetch | `the TUI object app > Enter fetches the object and its section; a change refreshes both` (timed out after 2000ms) |
| T-0031-M11 | packages/tui/src/state.ts | the last section page kept the old `next`, so paging never stopped | `the object pane reducer > scrolling at the end asks for the section's next page once` |
| T-0031-M12 | packages/tui/src/app.ts | a change refreshed the object but not its open live section | `the TUI object app > Enter fetches the object and its section; a change refreshes both` (timed out after 2000ms) |
| T-0031-M13 | packages/tui/src/state.ts | a late object answer created the object even after escape had closed the pane | `the object pane reducer > an object answer after escape does not reopen the pane` |
| T-0031-M14 | packages/tui/src/state.ts | the object version restarted at 1 for a different id, so a stale answer matched the new object | `the object pane reducer > a stale answer for the previous object keeps the newly opened one` |
| T-0031-M15 | packages/tui/src/view/index.ts | the narrow object was not drawn in the wrapping pane | `the object pane view > a narrow screen wraps the object's long lines instead of clipping them` |
| T-0031-M16 | packages/tui/src/state.ts | the section line count used raw Markdown lines instead of the wrapped rows | `the object pane view > a narrow live section follows its wrapped end and keeps the hint` |
| T-0031-M17 | packages/tui/src/view/index.ts | the view drew raw Markdown lines without wrapping them to the section width | `the object pane view > a narrow live section follows its wrapped end and keeps the hint` |
| tui-autostart-M3 | packages/tui/src/autostart.ts | a held home lock was ignored, so a second serve could be started | `ensureServer > a home lock with a silent port is an error naming http.enabled and http.port, and starts nothing` |
| tui-autostart-M4 | packages/tui/src/autostart.ts | an answering serve was not recognised and a second one was started | `ensureServer > a serve that already answers is not started again` |
| tui-autostart-M5 | packages/tui/src/autostart.ts | a non-operad answer was treated as silence | `ensureServer > a port that answers but is not operad is an error naming the port` |
| tui-autostart-M6 | packages/tui/src/autostart.ts | `http.enabled` false still started a serve | `ensureServer > http.enabled false starts nothing and names the key` |
| tui-autostart-M7 | packages/tui/src/autostart.ts | an early exit of the child was not noticed | `ensureServer > a child that exits at once is an error naming the log and showing its tail` |
| tui-autostart-M8 | packages/tui/src/autostart.ts | the `starting operad serve` line was not printed | `ensureServer > a fresh home with no config starts serve, waits for it and returns the address` |
| tui-autostart-M9 | packages/tui/src/autostart.ts | the child was not detached from the TUI's process group | `a real serve > a fresh home on a free port: tui starts serve, connects, and the child is stopped after` |
| tui-autostart-M10 | packages/tui/src/app.ts | `--url` no longer skipped the start check | `runTui and the flags > --url and --no-start never start or check a serve; neither does nothing at all` |
| tui-autostart-M11 | packages/tui/src/app.ts | `--no-start` no longer skipped the start check | `runTui and the flags > --url and --no-start never start or check a serve; neither does nothing at all` |
| tui-autostart-M13 | packages/tui/src/autostart.ts | a `200` reply without a `types` list counted as operad | `probeServer > tells operad, a silent address and another service apart` |
| tui-autostart-M16 | packages/tui/src/autostart.ts | an early exit of the child always failed, even when another serve held the lock | `ensureServer: races and bounds > two tui starting at once both end connected to the one serve` |
| tui-autostart-M17 | packages/tui/src/discover.ts | `http.port` 0 no longer failed before a start | `ensureServer: races and bounds > port 0 or an empty listen fails before anything is spawned` |
| tui-autostart-M18 | packages/tui/src/autostart.ts | the start deadline was a hundred times too far, so probe time did not bound the wait | `ensureServer: races and bounds > probe time counts against the start deadline` |
| pending-row-M6 | packages/tui/src/state.ts | a pending item with a row still showed the prompt as its title | `the TUI reducer > a pending item with a row shows the object's title and state, and the question as the note` |
| T-0031-M18 | packages/tui/src/sanitize.ts | `sanitize` returned the text unchanged, so control bytes reached the terminal | `server text never reaches the terminal as a control > a log line, a title, a note and every error are drawn without control bytes` |
| T-0031-M19 | packages/tui/src/state.ts | a reopened row kept the `loading` mark of its carried sections | `the object pane reducer > reopening a row after an error does not carry a section that was loading` |
| T-0031-M20 | packages/tui/src/app.ts | a live refresh fetched one page and dropped the pages the reader had scrolled to | `a live refresh > keeps the pages the reader scrolled to` |
| T-0031-M21 | packages/tui/src/layout.ts | the layout cache never hit, so every key and render wrapped the section again | `a large section is laid out once > keys and renders after the first do not wrap the text again` |
| T-0031-M22 | packages/tui/src/wrap.ts | every glyph counted one column | `wrapping is by display width > CJK and emoji take two columns, combining marks none` |
| T-0031-M23 | packages/tui/src/state.ts | enter on the already-open row opened it again | `focus > side by side the pane follows the cursor and the list keeps j and k` |
| T-0031-M24 | packages/tui/src/state.ts | any text with the truncation words capped the section | `the object pane reducer > capped > the same words inside the text, or another last line, do not` |
| T-0031-M25 | packages/tui/src/app.ts | closing the object left its section requests running | `a section request that is not finished > escape and a reopen do not leave the section loading` |
| T-0031-M26 | packages/tui/src/state.ts | a page from an earlier open of the object appended to the new open | `a section request that is not finished > a page that lands after the object was closed and reopened is dropped` |
| T-0035-M1 | packages/tui/src/state.ts | `LIST_WIDTH` was 30, so the divider moved off column 36 | `the TUI view > thin lines: the rules, the marker column, one divider and no boxes` |
| T-0035-M2 | packages/tui/src/view/index.ts | `fit` returned a long text whole, so a long title pushed past the pane | `the TUI view > the object pane text starts two cells after the divider and a long title never pushes the rule` |
| T-0035-M3 | packages/tui/src/state.ts | an error row took two lines in the list window | `the TUI reducer > the window around the cursor counts one line per row, an error row too` |
| T-0035-M4 | packages/tui/src/view/index.ts | `rowText` returned the run id for a row without an object | `the TUI view > a row without an object shows its label; a row error shows in the footer` |
| T-0035-M5 | packages/tui/src/view/index.ts | the footer ignored the selected row's `error` | `the TUI view > the selected row's error shows in the footer` |
| T-0032-M1 | packages/tui/src/actions.ts | an empty required note was sent | `actions in the reducer > a note action refuses to send while a required note is empty` |
| T-0032-M2 | packages/tui/src/state.ts | the person's key binding no longer came before the built-in keys | `actions in the reducer > a bound key runs its action; a user binding beats the plugin's and the built-in keys` |
| T-0032-M3 | packages/tui/src/actions.ts | `y` sent `confirmed: false` | `actions in the reducer > a confirm action asks and only y sends, with confirmed` |
| T-0032-M4 | packages/tui/src/actions.ts | any key answered the confirmation as yes | `actions in the reducer > a confirm action asks and only y sends, with confirmed` |
| T-0032-M5 | packages/tui/src/actions.ts | a refusal dropped the server's status from the footer line | `actions in the reducer > a refusal shows the server's status and message until the next key` |
| T-0032-M6 | packages/tui/src/state.ts | `:` opened no palette | `actions in the reducer > the palette filters by fuzzy match and shows key, note and confirm` |
