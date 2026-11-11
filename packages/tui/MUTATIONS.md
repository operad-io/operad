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
| TK0029-M13 | packages/tui/src/client.ts | the abort signal was not passed to `fetch` (also TK0029-M14) | `TuiClient > an aborted request rejects with the abort, not an unreachable server` |
| T-0030-M1 | packages/tui/src/state.ts | a cursor move near the end never asked for the next page | `the TUI reducer > moving past the end asks for the next page once and appends it once` |
| T-0030-M2 | packages/tui/src/state.ts | the two-pane threshold became `>` instead of `>=`, so 100 columns stayed one pane | `the TUI reducer > resize crosses 100 columns and carries the theme` |
| T-0030-M3 | packages/tui/src/state.ts | a Pending row lost its waiting flag | `the TUI reducer > each list maps its own flags to a row mark` |
| T-0030-M4 | packages/tui/src/state.ts | an appended page kept `loading` true | `the TUI reducer > moving past the end asks for the next page once and appends it once` |
| T-0030-M5 | packages/tui/src/view/index.ts | the waiting marker used the weak gray instead of the accent | `the TUI view > two panes show the header, a waiting marker and the footer` |
| T-0030-M6 | packages/tui/src/view/index.ts | the view always drew both panes, ignoring the width | `the TUI view > below 100 columns the right pane is gone` |
| T-0030-M7 | packages/tui/src/state.ts/app.ts | the shell no longer cleared a page request as it launched it, so every key fetched the page again | `the TUI app > keys, resizes and refreshes while a page is in flight fetch it once` (removed) |
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
| tui-autostart-M10 | packages/tui/src/app.ts | `--url` no longer skipped the start check (also tui-autostart-M11) | `runTui and the flags > --url and --no-start never start or check a serve; neither does nothing at all` |
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
| T-0032-M3 | packages/tui/src/actions.ts | `y` sent `confirmed: false` (also T-0032-M4) | `actions in the reducer > a confirm action asks and only y sends, with confirmed` |
| T-0032-M5 | packages/tui/src/actions.ts | a refusal dropped the server's status from the footer line | `actions in the reducer > a refusal shows the server's status and message until the next key` |
| T-0032-M6 | packages/tui/src/state.ts | `:` opened no palette | `actions in the reducer > the palette filters by fuzzy match and shows key, note and confirm` |
| T-0032-M7 | packages/tui/src/state.ts | the `:`, `?` and `q` built-ins came before the person's key bindings | `actions in the reducer > reserved keys are dropped from the bindings, announced once, and keep their built-in use` |
| T-0032-M8 | packages/tui/src/actions.ts | the note was trimmed before it was sent | `actions in the reducer > a note is sent exactly as entered` |
| T-0032-M9 | packages/tui/src/state.ts | the person's key bindings were skipped while the key list was open | `actions in the reducer > reserved keys are dropped from the bindings, announced once, and keep their built-in use` |
| T-0032-M10 | packages/tui/src/state.ts | the person's key bindings were skipped for `enter` and `escape` | `actions in the reducer > every reserved key is dropped whatever its source` |
| T-0032-M11 | packages/tui/src/actions.ts | an optional note of only whitespace was dropped from the request | `actions in the reducer > an optional note of only whitespace is sent as entered` |
| T-0032-M12 | packages/tui/src/actions.ts | `isReserved` returned false, so reserved keys stayed bindable | `actions in the reducer > every reserved key is dropped whatever its source` |
| T-0032-M13 | packages/tui/src/actions.ts | `keyOf` fell back to the action's own key, advertising a dropped reserved key | `actions in the reducer > a reserved plugin default is not advertised from the action's own key` |
| T-0032-M14 | packages/tui/src/actions.ts | `mainKey` returned `a` while `a` was bound to another action | `actions in the reducer > a bound a is not advertised as the main action's key` |
| T-0032-M15 | packages/tui/src/actions.ts | Ctrl and Meta chords were not reserved | `actions in the reducer > Ctrl and Meta chords are dropped as reserved` |
| T-0033-M1 | packages/tui/src/live.ts | a change event no longer asked for Pending and Running | `which events ask for which fetches > a change refetches its row and the lists; the open object also its pane` |
| T-0033-M2 | packages/tui/src/live.ts | every push opened a new timer, so a window made many batches | `which events ask for which fetches > events inside one window make one batch, then the next window starts` |
| T-0033-M3 | packages/tui/src/app.ts | the retry wait never grew | `live updates in the shell > a server that does not answer keeps the lists, names itself and retries with growing waits` |
| T-0033-M4 | packages/tui/src/app.ts | a 401 was retried like an unreachable server | `live updates in the shell > a 401 says the token was rotated and does not retry` |
| T-0033-M5 | packages/tui/src/app.ts | the signal handlers stayed after the app ended | `runTui > SIGINT restores the terminal, stops the event stream and exits 0` |
| T-0033-M6 | packages/tui/src/view/index.ts | the lists were not dimmed while the server was lost | `the states a session meets > the last lists stay visible but dimmed while the server does not answer` |
| T-0033-M7 | packages/tui/src/app.ts | an event after the server was lost fetched one row instead of everything | `live updates in the shell > an event while the server was lost refetches everything, not one row` |
| T-0033-M8 | packages/tui/src/state.ts | `r` did not ask again for a failed section | `the states a session meets > a section that failed shows its message and r asks for it again` |
| T-0033-M9 | packages/tui/src/state.ts | `r` retried after the 401 state | `rework 1 states > r does not retry after the token was rotated` |
| T-0033-M10 | packages/tui/src/state.ts | a gone object's row stayed in the type lists | `rework 1 states > a row whose object is gone leaves its list` |
| T-0033-M11 | packages/tui/src/events.ts | a lost stream yielded no error event | `TuiEvents > a refused connection retries with the first backoff step` |
| T-0033-M12 | packages/tui/src/events.ts | a stream that ended by itself was not reported as lost | `TuiEvents > a stream that ends by itself says the stream was lost once per outage` |
| T-0033-M13 | packages/tui/src/app.ts | a 401 left the scheduled unreachable retry running | `live updates in the shell > a 401 after the server was lost cancels the scheduled retry` |
| T-0033-M14 | packages/tui/src/app.ts | a deletion of the open object left its row in the lists | `live updates in the shell > a deletion event for the open object removes its row from the lists` |
| T-0033-M15 | packages/tui/src/app.ts | a live batch queued before a 401 still fetched | `live updates in the shell > a batch queued before a 401 makes no fetch` |
| T-0033-M16 | packages/tui/src/app.ts | a transport failure replaced the 401 state | `live updates in the shell > a transport failure after the 401 does not replace it or restart retries` |
| T-0033-M17 | packages/tui/src/app.ts | a failed live-section refresh was dropped silently | `live updates in the shell > a live section that fails to refresh shows its error` |
| T-0069-M1 | packages/tui/src/state.ts | `ready_to_merge` was not kept while the waiting flag is on | `rowMark: waiting keeps only the waiting-side marks, a mark beats running` |
| T-0069-M2 | packages/tui/src/state.ts | a mark did not beat the running flag | `the TUI view > each mark draws its own single-cell character; waiting beats a mark; running without a mark draws running` |
| T-0069-M3 | packages/tui/src/view/index.ts | the object header left out the badge | `the object pane view > the badge follows the state in the object's header` |

## T-0068 — running rows show the object

| id | file | mutation | failing test |
|---|---|---|---|
| T-0068-M1 | packages/tui/src/state.ts | the running row showed the run id instead of the object | `the TUI reducer` state test (running row with an object) |
| T-0068-M9 | packages/tui/src/state.ts | a running row with an object showed only its title, not the object id | `an object-backed running row shows the object and its title` |

## T-0070 — theme tokens

| id | file | mutation | failing test |
|---|---|---|---|
| T-0070-M1 | packages/tui/src/theme.ts | tui.json beat the `--theme` flag | `choosing the theme > tui.json names the theme and --theme beats it` |
| T-0070-M2 | packages/tui/src/theme.ts | `auto` always used the dark palette | `the theme tokens > auto follows the terminal's theme mode, also when it switches` |
| T-0070-M3 | packages/tui/src/theme.ts | the terminal theme's accent was an RGB hex, not an ANSI index | `the theme tokens > the terminal theme draws ANSI indexes, not RGB` |
| T-0070-M4 | packages/tui/src/app.ts | `runTui` skipped the config check and took the flag unchecked | `choosing the theme > the app does not start on an unknown theme or a broken file` |
| T-0070-M5 | packages/tui/src/view/index.ts | the selected row lost its tint background | `the theme tokens > the selected row has the tint as its background` |

## T-0049 — the filter key

| id | file | mutation | failing test |
|---|---|---|---|
| T-0049-M1 | packages/tui/src/state.ts | a page asked under another filter was shown | `filters: state > a page of an older filter is dropped, whatever order the answers come in` |
| T-0049-M2 | packages/tui/src/state.ts | a selection the new filter hides stayed at the old index, not the first row | `filters: state > a selection the new filter hides moves to the first row and the pane follows` |
| T-0049-M3 | packages/tui/src/state.ts | a live row that left the filter stayed in the list | `filters: state > a live event that takes the selected object out of the filter moves to the next row` |
| T-0049-M4 | packages/tui/src/state.ts | the footer offered `f filter` on every tab | `filters: view > the footer offers f filter only on a tab that has filters` |
| T-0049-M5 | packages/tui/src/state.ts | the header counted hidden rows under `all` | `filters: view > no hidden count when nothing is hidden or the filter is all` |
| T-0049-M6 | packages/tui/src/state.ts | cycling did not bump the list version, so a page of the old rows appended | `filters: state > a page for the old list version is dropped after a cycle` |
| T-0049-M7 | packages/tui/src/view/index.ts | the header was not cut to the terminal width | `filters: view > a 99-column terminal shows the same header, cut with … when it does not fit` |
| T-0049-M8 | packages/tui/src/app.ts | a refresh fetched the type without the chosen filter | `filters: shell > the first fetch uses the default filter, and a refresh the chosen one` |
| T-0049-M9 | packages/tui/src/state.ts | `f` did nothing | `filters: state > f with an object open cycles the filter in two panes and does nothing on a narrow screen` |
| T-0049-M10 | packages/tui/src/state.ts | an empty list under the new filter left the old object open | `filters: state > an empty list under the new filter closes the object pane` |
| T-0049-M11 | packages/tui/src/state.ts | the selected row leaving the filter did not make the pane follow | `filters: state > a live event that takes the selected object out of the filter moves to the next row` |
| T-0049-M12 | packages/tui/src/state.ts | a page was accepted without comparing its filter-cycle count | `filters: state > an old answer for a filter cycled back to is dropped` |
| T-0049-M13 | packages/tui/src/view/index.ts | the empty text for the `all` filter fell back to `no <type> yet` | `filters: view > an empty all filter reads no all tasks` |
| T-0049-M14 | packages/tui/src/app.ts | a refresh page carried no filter-cycle count | `filters: shell > a refresh answer for a filter cycled back to is dropped` |
| T-0049-M15 | packages/tui/src/app.ts | an event-triggered list page carried no filter-cycle count | `filters: shell > an event-triggered list answer for a filter cycled back to is dropped` |
| T-0070-M6 | packages/tui/src/view/index.ts | the header and footer rule used the weak token | `rules, text and the selected row > rules and the divider use the rule token` |
| T-0070-M7 | packages/tui/src/markdown.ts | plain markdown text used the weak token instead of text | `rules, text and the selected row > plain markdown text and code use the text token` |
| T-0070-M8 | packages/tui/src/view/index.ts | the selected row's label was not padded, so the tint stopped short | `rules, text and the selected row > the tint covers the whole selected row, padding included` |
| T-0070-M9 | packages/tui/src/view/index.ts | an unselected list label had no colour, so it kept the terminal foreground | `rules, text and the selected row > an unselected list label uses the text token` |
| T-0070-M10 | packages/tui/src/view/index.ts | the typed note text had no colour, so it kept the terminal foreground | `rules, text and the selected row > note text and unselected palette entries use the text token` |
| T-0070-M11 | packages/tui/src/view/index.ts | an unselected palette entry name had no colour | `rules, text and the selected row > note text and unselected palette entries use the text token` |
| T-0078-M1 | packages/tui/src/view/index.ts | the overlay box was not filled with the theme background, so the list showed through | `overlays > the palette fills its box and closing repaints the list` |
| T-0078-M2 | packages/tui/src/view/index.ts | the overlay sat at a fixed left edge instead of centred | `overlays > at 120x40 the palette, help, note and confirmation are centred` |
| T-0078-M3 | packages/tui/src/view/index.ts | the palette was centred on its height, so its input line moved with the matches | `overlays > at 120x40 the palette input line stays on its row as matches change` |
| T-0078-M4 | packages/tui/src/view/index.ts | the overlay had no one-cell margin inside its border | `overlays > the palette fills its box and closing repaints the list` |
| T-0078-M5 | packages/tui/src/view/index.ts | the overlay box was filled with the `code` token instead of `background` | `overlays > under the dark theme the palette box is filled with the background token` |
| T-0079-M5 | packages/tui/src/layout.ts | the weak colour code (90) was not read, so the table header lost its weak role | `tables fit the pane > 13 tasks at 100 columns take 15 rows none wider than the pane, and a resize re-lays them` |
| T-0071-M1 | packages/tui/src/theme.ts | the extends cycle check was removed, so a cycle recursed | `file themes > a cycle in extends names the file and the key` |
| T-0071-M2 | packages/tui/src/theme.ts | a theme without `extends` extended light instead of dark | `file themes > a theme names only what it changes and extends dark by default` |
| T-0071-M3 | packages/tui/src/theme.ts | a theme file named like a built-in was accepted | `file themes > a file with the name of a built-in is refused` |
| T-0071-M4 | packages/tui/src/theme.ts | an invalid edit replaced the last good theme with dark | `file themes > a change to the theme file or tui.json is applied; an invalid edit keeps the last good theme` |
| T-0071-M5 | packages/tui/src/app.ts | a good theme change did not clear the footer line about the bad one | `a changed theme file > repaints, shows one line when it is invalid and clears that line when it is good again` |
| T-0071-M6 | packages/tui/src/theme.ts | ANSI index 16 was accepted as a colour | `file themes > an unknown token, a bad colour and an unknown extends name the file and the key` |
| T-0071-M7 | packages/tui/src/theme.ts | a change to tui.json was ignored by the watch | `file themes > a change to the theme file or tui.json is applied; an invalid edit keeps the last good theme` |
| T-0126-M1 | packages/tui/src/theme.ts | the fallback timer never re-read the files, so an edit the directory watch missed was not applied | `file themes > the fallback timer picks up an edit the watch missed, and reports a problem once` |
| T-0126-M2 | packages/tui/src/theme.ts | the fallback timer reported every tick, so an unchanged invalid file repeated its problem | `file themes > the fallback timer picks up an edit the watch missed, and reports a problem once` |
| T-0090-M3 | packages/tui/src/state.ts | `n` on the last page asked for a page that does not exist | `a section with pages > n and N step through the pages and stop at both ends` |
| T-0090-M4 | packages/tui/src/state.ts | the position ignored where the loaded text starts in the table of contents | `a section with pages > the position line names the page and its label` |
| T-0090-M5 | packages/tui/src/actions.ts | `p` and `n` were no longer reserved, so a binding could take them | `actions in the reducer > the page keys p, n and N are reserved` |
| T-0090-M7 | packages/tui/src/view/index.ts | the page picker always listed from the first entry, so the marked page left the box | `a section with pages > the picker scrolls so the marked page stays in the box` |
| T-0141-M1 | packages/tui/src/app.ts | `runTui` did not wait for `renderer.closed`, so the message was written before the terminal was restored | `a fault that ends the app > a view that throws while a request is answered: the terminal is restored before the message is written` |
| T-0141-M2 | packages/tui/src/app.ts | a rejected request callback was swallowed instead of ending the app | `a fault that ends the app > a view that throws while a request is answered: the terminal is restored before the message is written` |
| T-0141-M3 | packages/tui/src/app.ts | no `unhandledRejection` handler, so the renderer's print-only handler kept the app up | `a fault that ends the app > an uncaught rejection: the terminal is restored before the message is written` |
| T-0100-M1 | packages/tui/src/state.ts | the list width had no upper limit of 60 columns | `the frame follows the terminal > the list is 40% of the width between 40 and 60 columns, and the divider follows` |
| T-0100-M2 | packages/tui/src/view/index.ts | the divider was drawn in the rule colour again, too close to the background | `the frame follows the terminal > the divider contrasts with the background in both themes` |
| T-0072-M1 | packages/tui/src/theme.ts | a family showed its dark member in a light terminal and the reverse | `families > a family follows the theme mode like auto, also when it switches` |
| T-0072-M2 | packages/tui/src/themes.ts | the kanagawa family named wave as light and lotus as dark | `families > every family names an existing light and dark theme, and is not a theme itself` |
| T-0072-M3 | packages/tui/themes/nord.json | nord's weak colour went back to the unadjusted upstream #4c566a (1.69:1) | `contrast > text reaches 4.5:1 and weak, accent, run, ok, error, add and remove 3:1 on the base colour` |
| T-0072-M4 | packages/tui/src/theme.ts | only the four original names counted as built-in, so a user file named like a shipped theme or family was accepted | `user files and shipped names > a user theme named like a shipped theme or a family is refused` |
| T-0072-M5 | packages/tui/src/theme.ts | `extends` did not accept a shipped theme name | `user files and shipped names > a user theme can extend a shipped theme, and the comment key is accepted` |
| T-0072-M6 | packages/tui/themes/dracula.json | the file left out the `code` token and inherited it from dark | `shipped themes: the files > every file matches the theme schema and sets every token itself` |
| T-0072-M7 | packages/tui/themes/LICENSE-nord | the bundled licence text was missing | `shipped themes: the files > themes/ holds exactly the listed themes, each with its licence text` |
| T-0072-M8 | packages/tui/themes/nord.json | the adjusted colour differed from the one its comment names | `contrast > a colour below its need is adjusted in the file, and the file's comment says so` |
| T-0100-M3 | packages/tui/src/view/index.ts | the list title left out the type list's filter | `filters: view > the list title names the page and a type list's filter, in the weak colour` |
| T-0100-M4 | packages/tui/src/view/index.ts | the list title was drawn in the text colour instead of the weak colour | `filters: view > the list title names the page and a type list's filter, in the weak colour` |
| T-0100-M5 | packages/tui/src/view/index.ts | the header showed the filter on every tab, not only the active one | `filters: view > the filter shows only on the current tab; a type without filters has no suffix` |
| T-0101-M1 | packages/tui/src/state.ts | an object counted two lines in the window, not three, so the window held a partly visible object | `two-line rows > scrolling keeps the cursor object fully visible and never draws half an object` |
| T-0101-M2 | packages/tui/src/view/index.ts | the dim line's indent lost the selection tint | `two-line rows > the selection tint covers both lines to the pane edge and not the blank line` |
| T-0101-M3 | packages/tui/src/state.ts | the window gave every list two lines more than it has | `the TUI reducer > the window around the cursor counts objects of three lines, the last one's blank line not needed` |
| T-0082-M1 | packages/tui/src/actions.ts | the palette listed the TUI commands before the open object's actions | `actions in the reducer > groups are shown in the order actions, tui; search reads the title` |
| T-0082-M2 | packages/tui/src/state.ts | the go back command did nothing instead of doing what escape does | `actions in the reducer > each TUI command does what its key does > go back closes the open object, as escape does` |
| T-0117-M1 | packages/tui/src/args.ts | a number above the schema's maximum was accepted | `arguments of an action > an integer outside its bounds is refused locally; one inside is sent` |
| T-0127-M1 | packages/tui/src/autostart.ts | a start that failed on a taken port was reported as "exited at once" | `ensureServer > a child that cannot listen because the port is taken says the port is in use` |
| T-0127-M2 | packages/tui/src/autostart.ts | a serve of the home that never answers was reported as a start that did not answer | `ensureServer > a child that lost the home lock to a serve that never answers says that serve runs and does not answer` |
| T-0083-M1 | packages/tui/src/actions.ts | a match at the start of a word got no bonus over a match in the middle | `palette search: query to first entry > "rec" finds ops:reconcile first` |
| T-0083-M2 | packages/tui/src/actions.ts | the group was not searched | `palette search: query to first entry > a group word keeps only the entries of that group` |
| T-0083-M3 | packages/tui/src/actions.ts | the recent list put the newest entry last | `palette search: recent entries > an empty query keeps the last five used first inside each group, and lists the groups in order` |
| T-0083-M4 | packages/tui/src/actions.ts | equal scores were listed in reverse order | `palette search: query to first entry > equal scores keep the order the entries were listed in` |
| T-0083-M5 | packages/tui/src/view/index.ts | the matched characters of the name were not drawn in the accent | `palette search: highlight positions > the matched characters are drawn in the accent colour` |
| T-0084-M1 | packages/tui/src/state.ts | moving the theme list's cursor did not change the previewed theme | `the theme command: list and keys > moving previews the theme under the cursor, and stops at the ends` |
| T-0084-M2 | packages/tui/src/state.ts | escape closed the theme list but left the preview on | `the theme command: list and keys > escape closes the list and ends the preview, asking for nothing` |
| T-0084-M3 | packages/tui/src/theme.ts | saving the theme replaced tui.json with only the theme key | `saving the choice > it writes tui.json, keeps the other keys and the next start reads it` |
| T-0084-M4 | packages/tui/src/app.ts | Enter kept the theme for the session but did not write tui.json | `the theme command in the running app > enter keeps the theme, writes tui.json, and a new start uses it` |
| T-0084-M5 | packages/tui/src/app.ts | the view ignored the preview and always drew the theme in force | `the theme command in the running app > moving the selection changes the drawn colours; escape puts them back` |
| T-0129-M2 | packages/tui/src/state.ts | opening a type-tab row asked for the bare id instead of `<type>:<id>` | `the TUI object app > a row opens by its typed id; a server that refuses bare ids is never asked for one` |
| T-0112-M10 | packages/tui/src/actions.ts | a status number in front of a refusal was kept (also T-0112-M11) | `a refusal line > drops a status number and a field prefix, and keeps the sentence` |
| T-0117-M2 | packages/tui/src/args.ts | a boolean argument was not recognised, so no yes/no list was asked | `arguments of an action > a boolean is a yes/no list that starts on its default` |
| T-0129-M3 | packages/tui/src/app.ts | the section request sent the answer's bare id instead of `<type>:<id>` | `the TUI object app > a row opens by its typed id; a server that refuses bare ids is never asked for one` |
| T-0102-M1 | packages/tui/src/state.ts | a list that loaded did not ask the object pane to show the cursor row | `the object pane follows the cursor > a list that loads under the open tab shows its first row` |
| T-0102-M2 | packages/tui/src/app.ts | a new cursor move did not cancel the pending follow, so every row in a fast run was fetched | `the object pane follows the cursor > three fast moves fetch only the last row` |
| T-0102-M3 | packages/tui/src/state.ts | the follow opened the row also in one-pane layout | `the object pane follows the cursor > one pane opens nothing until enter` |
| T-0102-M4 | packages/tui/src/view/index.ts | a cursor row that names no object showed "loading…" instead of "select an object" | `a row that names no object > the pane asks to select an object instead of loading forever` |
| T-0085-M1 | packages/tui/src/actions.ts | a setting's description was left out of what the palette searches | `settings in the palette > every setting is listed, and search reads the name and the description` |
| T-0085-M2 | packages/tui/src/actions.ts | a confirm setting was sent without asking | `settings in the palette > a confirm setting asks first; any key but y cancels, y sends it confirmed` |
| T-0085-M3 | packages/tui/src/actions.ts | a setting that cannot change was given a value prompt | `settings in the palette > a setting that cannot change opens read-only and sends nothing` |
| T-0085-M5 | packages/tui/src/actions.ts | a repository's own page listed global settings only | `the scopes the palette lists > no object lists global only; a task names its repository; a repository's own page names itself` |
| T-0161-M2 | packages/tui/src/state.ts | a running row ignored the item's mark and always drew running | `two-line rows > a running row draws its mark's character, and running without one` |
| T-0148-M1 | packages/tui/src/app.ts | a refresh read from the first page, not from the page the text starts at | `a live section that was jumped to a later page > a change reads it again from that page and keeps the position` |
| T-0148-M2 | packages/tui/src/state.ts | a replace reset pageStart to 0 instead of keeping the start | `a live section that was jumped to a later page > a change reads it again from that page and keeps the position` |
| T-0148-M3 | packages/tui/src/state.ts | the position counted every loaded page, not the page under the scroll | `a section with pages > the position is the page under the top of the pane, not the last one loaded` |
| T-0148-M4 | packages/tui/src/state.ts | the picker opened with its cursor on the first entry | `a section with pages > the picker opens with its cursor on the page shown` |
| T-0148-M5 | packages/tui/src/app.ts | a fault before the shell existed did not stop it when it started | `runTui > a fault before the shell exists still ends the app, with the message` |
| T-0148-M6 | packages/tui/src/app.ts | runTui did not pass onMessage, so request failures were not echoed at exit | `runTui > a server that cannot be reached is echoed after the screen closes` |
| T-0148-M7 | packages/tui/src/app.ts | the request guard swallowed a rejection | `a fault in the app's own loops > a view that throws while a request is answered ends the app through the request guard` |
| T-0121-M1 | packages/tui/src/app.ts | a plugin whose roots only partly have children listed the children (`some` instead of `every`) | `one tab per plugin > roots without children are listed themselves` |
| T-0121-M2 | packages/tui/src/state.ts | a plugin tab's column took the terminal's share instead of the width its rows need | `one tab per plugin > a plugin column is as wide as its rows, never wider than the terminal's share` |
| T-0121-M3 | packages/tui/src/state.ts | escape on a child's page closed the pane instead of returning to the plan | `one tab per plugin > enter on a child in the page opens its own page, and back returns to the plan` |
| T-0121-M4 | packages/tui/src/view/index.ts | a plugin tab's rows drew their title after the id and slug | `two-line rows > at the one-pane width nothing is wider than the pane, and a long id and title cut with …` |
| T-0121-M5 | packages/tui/src/state.ts | a child's page took the child's id as its source, so a refresh of the left list reopened the plan | `one tab per plugin > a refresh of the left list leaves a child's page open` |
| T-0121-M6 | packages/tui/src/state.ts | a changed row was not put in place on the open page's next-level list | `one tab per plugin > a change to a child refreshes its row on the open plan page` |
| T-0149-M1 | packages/tui/src/theme.ts | the shipped palettes were read again when the module was imported, so a missing file failed every start | `shipped themes: the files > a missing shipped file fails when its theme or family is chosen, not when the module is imported` |
| T-0149-M2 | packages/tui/src/theme.ts | choosing a shipped theme no longer read and checked its file | `shipped themes: the files > a missing shipped file fails when its theme or family is chosen, not when the module is imported` |
| T-0149-M3 | packages/tui/src/theme.ts | choosing a family checked only the family name, not both of its members | `shipped themes: the files > a missing shipped file fails when its theme or family is chosen, not when the module is imported` |
| T-0149-M4 | packages/tui/themes/rose-pine-main.json, packages/tui/themes/rose-pine-dawn.json | the tint went back to the surface colour, which is barely visible on the base and equals code | `shipped themes: the files > Rosé Pine's selected row is visible on its base` |
| T-0149-M5 | packages/tui/themes/dracula.json | code went back to the selection colour, so a code block looked like a selected row | `shipped themes: the files > every shipped theme resolves to a full palette equal to its file` (code is not tint) |
| T-0149-M6 | packages/tui/themes/solarized-dark.json | code went back to base02, the tint and rule colour | `shipped themes: the files > every shipped theme resolves to a full palette equal to its file` (code is not tint) |
| T-0149-M7 | packages/tui/themes/solarized-light.json | code went back to base2, the tint and rule colour | `shipped themes: the files > every shipped theme resolves to a full palette equal to its file` (code is not tint) |
| T-0149-M8 | packages/tui/themes/one-light.json | code went back to the selection colour, leaving no second background | `shipped themes: the files > every shipped theme resolves to a full palette equal to its file` (code is not tint) |
| T-0103-M1 | packages/tui/src/state.ts | a cycle no longer fell back to the list order | `the object page's child list > a cycle falls back to the list order` |
| T-0103-M2 | packages/tui/src/state.ts | every parent in `after` was printed as `also after`, not only the ones after the first | `the object page's child list > a child with two parents hangs under the first and names the other as also after` |
| T-0103-M3 | packages/tui/src/state.ts | cancelled children kept their list place instead of moving last | `the progress bar and its heading > the child list puts cancelled rows last` |
| T-0103-M4 | packages/tui/src/state.ts | cancelled children counted in the done total and were left out of the bar cells | `the progress bar and its heading > cancelled children are counted in neither done nor total, but still draw a cell at the end` |
| T-0103-M5 | packages/tui/src/view/index.ts | a cancelled bar segment took the weak grey instead of the cancelled dark red | `the progress bar and its heading > the bar takes its colours from each mark; cancelled is dark red and comes last` |
| T-0103-M6 | packages/tui/src/actions.ts | `t` was no longer reserved, so a binding could take it | `the tree and list layouts > t toggles the child list, is reserved, and the footer names the layout it switches to` |
| T-0103-M7 | packages/tui/src/view/index.ts | a long title was cut with `…` instead of wrapped | `the object page's frame and columns > the title wraps inside the frame` |
| T-0103-M8 | packages/tui/src/view/index.ts | the child heading carried the state word `done` beside the numbers | `the progress bar and its heading > cancelled children are counted in neither done nor total, but still draw a cell at the end` |
| T-0103-M9 | packages/tui/src/theme.ts | reading `tui.json` ignored the saved child layout | `the tree and list layouts > the chosen layout is read from tui.json and saved next to the theme` |

## T-0206 — the serve log tail reads only the end

| id | file | mutation | failing test |
|---|---|---|---|
| T-0206-M5 | packages/tui/src/autostart.ts | decoded each backward chunk on its own, so a multi-byte character split across two reads became U+FFFD | `ensureServer > a long log's tail keeps the last ten lines and decodes a multi-byte line across reads` |

## FATAL-FLAKY — the fault tests' terminal restore is not cut short by load

| id | file | mutation | failing test |
|---|---|---|---|
| FATAL-FLAKY-M1 | packages/tui/test/fatal.test.ts | the test renderer's native session went back to a wall-clock close deadline (`closeTimeoutMs: 0`, what a one-second stall of the loop amounts to) instead of the virtual scheduler | `a fault that ends the app > a view that throws while a request is answered: the terminal is restored before the message is written` (also the uncaught exception and rejection cases) |
| T-0103-M10 | packages/tui/src/state.ts | the tree kept an active child under its cancelled parent instead of moving every cancelled row last | `the progress bar and its heading > an active child of a cancelled parent is still before every cancelled row` |
| T-0103-M11 | packages/tui/src/state.ts | an active row took its first `after` parent even when that parent was cancelled, so it hung from a cancelled row instead of drawing top-level | `the progress bar and its heading > an active child of a cancelled parent is drawn top-level before every cancelled row` |
| T-0160-M3 | packages/tui/src/actions.ts | parsed typed text as JSON even for a string setting | `typed setting text > a string setting keeps text that reads as JSON; other types parse it` |
| T-0160-M4 | packages/tui/src/state.ts | left the theme list cursor where it was when the list got shorter | `the theme command: list and keys > a theme file removed while the list is open keeps the cursor on a theme` |
| T-0215-M1 | packages/tui/test/popular-themes.test.ts | the temporary copy kept `rose-pine-main.json` (the file that should be missing) | `shipped themes: the files > a missing shipped file fails when its theme or family is chosen, not when the module is imported` |

## T-0104 — the overlays' and the footer's spacing

| id | file | mutation | failing test |
|---|---|---|---|
| T-0104-M1 | packages/tui/src/view/index.ts | put no blank line under the palette's input | `the overlays' spacing > the palette at 80 columns has a blank line under the input, a dim group label and aligned columns` |
| T-0104-M2 | packages/tui/src/view/index.ts | put no blank line between the palette's groups | `the overlays' spacing > the palette at 160 columns has a blank line under the input, a dim group label and aligned columns` |
| T-0104-M3 | packages/tui/src/view/index.ts | left-aligned the palette's key instead of keeping it at the right edge | `the overlays' spacing > the palette at 80 columns has a blank line under the input, a dim group label and aligned columns` |
| T-0104-M4 | packages/tui/src/view/index.ts | drew a palette group label in the text colour instead of the weak colour | `the overlays' spacing > the palette at 80 columns has a blank line under the input, a dim group label and aligned columns` |
| T-0104-M5 | packages/tui/src/view/index.ts | did not pad the key column of the key list | `the overlays' spacing > the key list at 80 columns aligns every key and puts a blank line between groups` |
| T-0104-M6 | packages/tui/src/view/index.ts | put no blank line between the key list's groups | `the overlays' spacing > the key list at 160 columns aligns every key and puts a blank line between groups` |
| T-0104-M7 | packages/tui/src/view/index.ts | separated the footer's hints with two spaces instead of ` · ` | `the overlays' spacing > the footer separates hints with a dot, the keys in the text colour and the hints weak` |
| T-0104-M8 | packages/tui/src/view/index.ts | drew the footer's keys in the weak colour | `the overlays' spacing > the footer separates hints with a dot, the keys in the text colour and the hints weak` |
| T-0104-M9 | packages/tui/src/actions.ts | listed the recent palette entries across groups instead of grouping them | `palette search: recent entries > an empty query keeps the last five used first inside each group, and lists the groups in order` |
| T-0104-M10 | packages/tui/src/view/index.ts | drew the key list from its first row, so a short terminal could not reach its last group | `the overlays' spacing > the key list scrolls to its last group on a 24-row terminal at 80 columns` |

## T-0105 — diff text contrast

| id | file | mutation | failing test |
|---|---|---|---|
| T-0105-M1 | packages/tui/src/layout.ts | gave code text with no role the weak role again | `a diff block > gives header, hunk, add, remove and context their roles` |
| T-0105-M2 | packages/tui/src/layout.ts | drew the fence's language as a line | `a diff block > has no line for the fence's language` |
| T-0105-M3 | packages/tui/src/layout.ts | did not pad code rows to the pane's width | `a diff block > is one rectangle: every row has the pane's width and one column of left padding` |
| T-0105-M4 | packages/tui/src/layout.ts | drew the whole --stat line in one colour | `a diff block > colours the + and - runs of a --stat line` |
| T-0105-M5 | packages/tui/src/theme.ts | set the dark theme's weak colour to #5a5a66 | `theme contrast > dark: text and weak read on the background and the code background` |
| T-0105-M6 | packages/tui/src/layout.ts | wrapped code rows without re-adding the left padding to continuation rows | `a wrapped code row > keeps the block's left padding and its width on every row` |
| T-0105-M7 | packages/tui/src/layout.ts | counted the --stat head in UTF-16 units instead of graphemes | `code rows at narrow widths and with astral characters > colours the first + of a --stat line whose file name has an astral character` |
| T-0239-M5 | packages/tui/src/state.ts | a running row did not show the time a step spent queued | `two-line rows > a run queued for a check place says so, and how long it waited once it runs` |
